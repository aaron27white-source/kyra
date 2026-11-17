import { DateTime } from "luxon";
import { createHash } from "node:crypto";
import { lmcBookingRulesSchema } from "@lobbystack/contracts";
import { and, asc, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";

import { appointments, auditLogs, businesses, businessHours, calendarBusyBlocks, calendarConnections, calls, closures, contacts, enqueueOutbox, lmcSettings, notifications, receptionistProfiles, services, smsConsentEvents, staff, staffServiceAssignments, withBusinessTransaction, type DatabaseTransaction } from "@lobbystack/db";
import { getPostHogDistinctIdForBusinessSystem } from "@lobbystack/telemetry";

import { computeAvailability } from "../availability";
import { requireBusinessMembership } from "../authz";
import type { DomainContext } from "./context";
import { recordCallOutcomeInTransaction } from "./callOutcome";
import { consumeAppointmentChangeVerificationInTransaction } from "./appointmentChanges";
import { recordProductEvent } from "./productEvents";
import { rescheduleAppointmentReminderInTransaction } from "./notifications";
import { emitWebhookEventInTransaction } from "./publicApi/webhooks";
import { effectiveServiceIntakePolicy, validateServiceIntake, type ServiceIntake } from "./service-intake";
import type { ServiceIntakePolicy } from "@lobbystack/shared";

type BookingInput = {
  callId?: string;
  businessId: string;
  userId?: string;
  serviceId: string;
  startsAt: string;
  timezone: string;
  contactPhone: string;
  contactName?: string;
  sourceChannel: string;
  preferredStaffId?: string;
  smsConsentGranted?: boolean;
  intake?: ServiceIntake;
  /** Set when the public API or the MCP server made the booking; recorded in the audit log. */
  apiAudit?: ApiAudit;
};

/** Who made an API change: the audit row's actor user (OAuth grants act for a user) and payload (actor and credential id). */
export type ApiAudit = { actorUserId: string | null; payload: Record<string, unknown> };

async function lockStaff(tx: DatabaseTransaction, staffId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${staffId}, 0))`);
}

export const MAX_CALENDAR_SYNC_AGE_MS = 20 * 60_000;
export const CALENDAR_SYNC_HORIZON_MS = 90 * 24 * 60 * 60_000;

type AvailabilityReference = {
  businessId: string;
  serviceId: string;
  serviceName: string;
  serviceDurationMinutes: number;
  intakePolicy: ServiceIntakePolicy;
  timezone: string;
  startsAt: Date;
  endsAt: Date;
  activeStaffIds: string[];
  assignedStaffIds: Set<string>;
  connections: Array<typeof calendarConnections.$inferSelect>;
  hours: Array<typeof businessHours.$inferSelect>;
  closures: Array<{ startsAt: string; endsAt: string; reason: string }>;
};

/**
 * Reads an availability reference snapshot. Booking callers reload it after
 * waiting for an advisory lock so they do not validate against stale rules.
 */
async function loadAvailabilityReference(tx: DatabaseTransaction, input: { businessId: string; serviceId: string; startsAt: string }): Promise<AvailabilityReference> {
  const [service] = await tx.select({ id: services.id, name: services.name, durationMinutes: services.durationMinutes, intakePolicy: services.intakePolicy }).from(services).where(and(eq(services.id, input.serviceId), eq(services.businessId, input.businessId), eq(services.active, true))).limit(1);
  const [profile] = await tx.select({ intakePolicy: receptionistProfiles.intakePolicy }).from(receptionistProfiles).where(eq(receptionistProfiles.businessId, input.businessId)).limit(1);
  const [business] = await tx.select({ timezone: businesses.timezone }).from(businesses).where(eq(businesses.id, input.businessId)).limit(1);
  if (!service || !business) throw new Error("Service is not available.");
  const startsAt = new Date(input.startsAt);
  if (!Number.isFinite(startsAt.getTime()) || !Number.isSafeInteger(service.durationMinutes) || service.durationMinutes <= 0) throw new Error("A valid appointment time and duration are required.");
  const endsAt = new Date(startsAt.getTime() + service.durationMinutes * 60_000);
  const activeStaff = await tx.select({ id: staff.id }).from(staff).where(and(eq(staff.businessId, input.businessId), eq(staff.active, true))).orderBy(asc(staff.id));
  const activeStaffIds = activeStaff.map((row) => row.id);
  const assignments = await tx.select({ staffId: staffServiceAssignments.staffId }).from(staffServiceAssignments).where(and(eq(staffServiceAssignments.businessId, input.businessId), eq(staffServiceAssignments.serviceId, input.serviceId)));
  const connections = activeStaffIds.length
    ? await tx.select().from(calendarConnections).where(and(eq(calendarConnections.businessId, input.businessId), ne(calendarConnections.status, "disconnected"), or(isNull(calendarConnections.staffId), inArray(calendarConnections.staffId, activeStaffIds))))
    : [];
  const hours = await tx.select().from(businessHours).where(eq(businessHours.businessId, input.businessId));
  const closed = await tx.select().from(closures).where(and(eq(closures.businessId, input.businessId), lt(closures.startsAt, endsAt), gt(closures.endsAt, startsAt)));
  return {
    businessId: input.businessId,
    serviceId: input.serviceId,
    serviceName: service.name,
    serviceDurationMinutes: service.durationMinutes,
    intakePolicy: effectiveServiceIntakePolicy(profile?.intakePolicy, service.intakePolicy),
    timezone: business.timezone,
    startsAt,
    endsAt,
    activeStaffIds,
    assignedStaffIds: new Set(assignments.map((row) => row.staffId)),
    connections,
    hours,
    closures: closed.map((row) => ({ startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString(), reason: row.reason })),
  };
}

// Unassigned services retain the existing all-active-staff default. Explicit
// assignments constrain eligibility instead of being silently ignored.
function eligibleStaffIds(reference: AvailabilityReference, requestedStaffIds?: string[]): string[] {
  return reference.activeStaffIds.filter((id) => (!requestedStaffIds || requestedStaffIds.includes(id)) && (!reference.assignedStaffIds.size || reference.assignedStaffIds.has(id)));
}

function isCalendarFresh(reference: AvailabilityReference, staffId: string, now: number): boolean {
  return !reference.connections.some((connection) => connection.selectedCalendarId && (!connection.staffId || connection.staffId === staffId) && (
    connection.status !== "connected" || !connection.lastSyncedAt || now - connection.lastSyncedAt.getTime() > MAX_CALENDAR_SYNC_AGE_MS
    || reference.startsAt.getTime() < connection.lastSyncedAt.getTime() || reference.endsAt.getTime() > connection.lastSyncedAt.getTime() + CALENDAR_SYNC_HORIZON_MS
  ));
}

/**
 * Reads only staff-specific conflicts. Call after taking the staff advisory
 * lock so the conflict check reflects the holder of the lock.
 */
async function staffAvailabilityInTransaction(tx: DatabaseTransaction, reference: AvailabilityReference, input: { staffIds: string[]; ignoreAppointmentId?: string; ignoreCalendarEventId?: string }) {
  if (!input.staffIds.length) return [];
  const existing = await tx.select({ staffId: appointments.staffId, startsAt: appointments.startsAt, endsAt: appointments.endsAt }).from(appointments).where(and(eq(appointments.businessId, reference.businessId), ne(appointments.status, "canceled"), input.ignoreAppointmentId ? ne(appointments.id, input.ignoreAppointmentId) : undefined, inArray(appointments.staffId, input.staffIds), lt(appointments.startsAt, reference.endsAt), gt(appointments.endsAt, reference.startsAt)));
  const configured = reference.connections.filter((connection) => connection.selectedCalendarId && input.staffIds.some((id) => !connection.staffId || connection.staffId === id));
  const connectionIds = configured.filter((connection) => connection.status === "connected").map((connection) => connection.id);
  const busy = connectionIds.length ? await tx.select().from(calendarBusyBlocks).where(and(eq(calendarBusyBlocks.businessId, reference.businessId), inArray(calendarBusyBlocks.connectionId, connectionIds), lt(calendarBusyBlocks.startsAt, reference.endsAt), gt(calendarBusyBlocks.endsAt, reference.startsAt), input.ignoreCalendarEventId ? or(isNull(calendarBusyBlocks.externalEventId),ne(calendarBusyBlocks.externalEventId,input.ignoreCalendarEventId)) : undefined)) : [];
  const staffByConnection = new Map(reference.connections.map((connection) => [connection.id, connection.staffId]));
  return computeAvailability({
    request: { serviceId: reference.serviceId, startsAt: reference.startsAt.toISOString(), timezone: reference.timezone },
    serviceDurationMinutes: reference.serviceDurationMinutes,
    staffIds: input.staffIds,
    hours: reference.hours,
    closures: reference.closures,
    existingAppointments: [
      ...existing.map((row) => ({ staffId: row.staffId, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString() })),
      ...busy.flatMap((row) => { const owner = row.staffId ?? staffByConnection.get(row.connectionId); return (owner ? [owner] : input.staffIds).map((staffId) => ({ staffId, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString() })); }),
    ],
  });
}

async function availabilityInTransaction(tx: DatabaseTransaction, input: { businessId: string; serviceId: string; startsAt: string; staffIds?: string[]; ignoreAppointmentId?: string }) {
  const reference = await loadAvailabilityReference(tx, input);
  const now = Date.now();
  const selected = eligibleStaffIds(reference, input.staffIds).filter((id) => isCalendarFresh(reference, id, now));
  if (!selected.length) return [];
  return await staffAvailabilityInTransaction(tx, reference, input.ignoreAppointmentId ? { staffIds: selected, ignoreAppointmentId: input.ignoreAppointmentId } : { staffIds: selected });
}

export async function findAvailability(
  context: DomainContext,
  input: { userId?: string; businessId: string; serviceId: string; startsAt: string; timezone: string; staffIds?: string[] },
) {
  return await withBusinessTransaction(context.db, { userId: input.userId, businessId: input.businessId, actorType: input.userId ? "operator" : "worker" }, async (tx) => {
    if (input.userId) {
      await requireBusinessMembership(tx, { userId: input.userId, businessId: input.businessId });
    }
    return await availabilityInTransaction(tx, input);
  });
}

export async function bookAppointment(
  context: DomainContext,
  input: BookingInput,
): Promise<{ appointmentId: string; contactId: string; staffId: string; idempotent?: boolean }> {
  return await withBusinessTransaction(context.db, { userId: input.userId, businessId: input.businessId, actorType: input.userId ? "operator" : "worker" }, async (tx) => {
    if (input.userId) {
      await requireBusinessMembership(tx, { userId: input.userId, businessId: input.businessId, minimumRole: "scheduler" });
    }
    const canonicalStartsAt = new Date(input.startsAt);
    if (!Number.isFinite(canonicalStartsAt.getTime())) throw new Error("A valid appointment time and duration are required.");
    const idempotencyKey = input.callId
      ? createHash("sha256").update(`${input.serviceId}:${canonicalStartsAt.toISOString()}`).digest("hex")
      : undefined;
    if (input.callId && idempotencyKey) {
      // Serialize retries for one call and return the first committed booking
      // before checking availability (the successful booking now occupies it).
      const [call] = await tx.select({ id: calls.id }).from(calls)
        .where(and(eq(calls.id, input.callId), eq(calls.businessId, input.businessId))).limit(1).for("update");
      if (!call) throw new Error("Call does not belong to this business.");
      const [existing] = await tx.select({ appointmentId: appointments.id, contactId: appointments.contactId, staffId: appointments.staffId })
        .from(appointments).where(and(eq(appointments.businessId, input.businessId), eq(appointments.originCallId, input.callId), eq(appointments.idempotencyKey, idempotencyKey))).limit(1);
      if (existing) {
        await recordCallOutcomeInTransaction(tx, { businessId: input.businessId, callId: input.callId, outcome: { kind: "booked", serviceName: null, startsAt: canonicalStartsAt.toISOString(), appointmentId: existing.appointmentId } });
        return { appointmentId: existing.appointmentId, contactId: existing.contactId, staffId: existing.staffId, idempotent: true as const };
      }
    }
    // The first read discovers a stable, sorted lock set. Reference data is
    // reloaded after each candidate lock because it may change while we wait.
    const initialReference = await loadAvailabilityReference(tx, { businessId: input.businessId, serviceId: input.serviceId, startsAt: input.startsAt });
    const callerName = input.contactName?.trim() || input.intake?.answers?.customerName?.trim();
    const intake = validateServiceIntake(initialReference.intakePolicy, {
      ...(input.intake ?? {}),
      answers: { ...(input.intake?.answers ?? {}), ...(callerName ? { customerName: callerName } : {}), callbackPhone: input.contactPhone },
    });
    if (!intake.ok) throw Object.assign(new Error(intake.reason), { code: intake.reason, missingFields: intake.missingFields, validationIssues: intake.validationIssues });
    const candidates = initialReference.activeStaffIds.filter((id) => !input.preferredStaffId || id === input.preferredStaffId);
    let selectedStaff: { id: string } | undefined;
    let selectedReference: AvailabilityReference | undefined;
    for (const candidateId of candidates) {
      await lockStaff(tx, candidateId);
      const reference = await loadAvailabilityReference(tx, { businessId: input.businessId, serviceId: input.serviceId, startsAt: input.startsAt });
      if (!reference.activeStaffIds.includes(candidateId)) continue;
      if (reference.assignedStaffIds.size && !reference.assignedStaffIds.has(candidateId)) continue;
      if (!isCalendarFresh(reference, candidateId, Date.now())) continue;
      const slots = await staffAvailabilityInTransaction(tx, reference, { staffIds: [candidateId] });
      if (slots.length) {
        selectedStaff = { id: candidateId };
        selectedReference = reference;
        break;
      }
    }
    if (!selectedStaff || !selectedReference) {
      throw new Error("No staff member is available for this service.");
    }
    const reference = selectedReference;
    const startsAt = reference.startsAt;
    const endsAt = reference.endsAt;
    const conflicting = await tx.select({ id: appointments.id }).from(appointments).where(and(eq(appointments.businessId, input.businessId), eq(appointments.staffId, selectedStaff.id), ne(appointments.status, "canceled"), lt(appointments.startsAt, endsAt), gt(appointments.endsAt, startsAt))).limit(1);
    if (conflicting[0]) {
      throw new Error("That appointment time is no longer available.");
    }
    const existingContacts = await tx.select({ id: contacts.id, smsConsentStatus: contacts.smsConsentStatus, operatorBlockedAt: contacts.operatorBlockedAt }).from(contacts).where(and(eq(contacts.businessId, input.businessId), eq(contacts.phone, input.contactPhone))).limit(1);
    const contactCreated = !existingContacts[0];
    const contactId = existingContacts[0]?.id ?? (await tx.insert(contacts).values({
      businessId: input.businessId,
      phone: input.contactPhone,
      ...(callerName ? { name: callerName } : {}),
    }).returning({ id: contacts.id }))[0]?.id;
    if (!contactId) {
      throw new Error("Contact could not be created.");
    }
    const canGrantReminderConsent = input.smsConsentGranted === true && existingContacts[0]?.smsConsentStatus !== "opted_out" && !existingContacts[0]?.operatorBlockedAt;
    if (canGrantReminderConsent) {
      const now = new Date();
      await tx.update(contacts).set({ smsConsentStatus: "subscribed", smsConsentSource: "appointment_booking", smsConsentUpdatedAt: now, updatedAt: now }).where(and(eq(contacts.id, contactId), eq(contacts.businessId, input.businessId)));
      await tx.insert(smsConsentEvents).values({ businessId: input.businessId, contactId, phone: input.contactPhone, recipientType: "contact", action: "reminder_consent_granted", source: "appointment_booking" });
    }
    const [appointment] = await tx.insert(appointments).values({
      businessId: input.businessId,
      contactId,
      staffId: selectedStaff.id,
      serviceId: input.serviceId,
      startsAt,
      endsAt,
      timezone: input.timezone,
      status: "confirmed",
      sourceChannel: input.sourceChannel,
      ...(input.callId ? { originCallId: input.callId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(intake.serviceLocation ? { serviceLocation: intake.serviceLocation as unknown as Record<string, unknown> } : {}),
      ...(Object.keys(intake.answers).length ? { intakeAnswers: intake.answers } : {}),
      intakeCompletionStatus: intake.required ? "complete" : "not_required",
      calendarSyncState: "pending",
    }).returning({ id: appointments.id, revision: appointments.revision });
    if (!appointment) {
      throw new Error("Appointment could not be created.");
    }
    const [confirmation] = await tx.insert(notifications).values({
      businessId: input.businessId,
      channel: "sms",
      kind: "booking_confirmation",
      relatedId: appointment.id,
      scheduledFor: new Date(),
      status: "pending",
    }).onConflictDoNothing().returning({ id: notifications.id });
    if (!confirmation) {
      throw new Error("Booking confirmation notification could not be created.");
    }
    await enqueueOutbox(tx, {
      topic: "calendar.syncAppointment",
      businessId: input.businessId,
      aggregateType: "appointment",
      aggregateId: appointment.id,
      dedupeKey: `appointment:${appointment.id}:calendar:create`,
      payload: { appointmentId: appointment.id },
    });
    await enqueueOutbox(tx, {
      topic: "realtime.publish",
      businessId: input.businessId,
      aggregateType: "appointment",
      aggregateId: appointment.id,
      dedupeKey: `appointment:${appointment.id}:updated:${appointment.revision}`,
      payload: { type: "appointment.updated", entityId: appointment.id, revision: appointment.revision },
    });
    await enqueueOutbox(tx, {
      topic: "notification.dispatch",
      businessId: input.businessId,
      aggregateType: "appointment",
      aggregateId: appointment.id,
      dedupeKey: `notification:${confirmation.id}:dispatch`,
      payload: { notificationId: confirmation.id },
    });
    const reminderAt = new Date(startsAt.getTime() - 24 * 60 * 60 * 1000);
    if (reminderAt > new Date()) {
      const [reminder] = await tx.insert(notifications).values({
        businessId: input.businessId,
        channel: "sms",
        kind: "appointment_reminder",
        relatedId: appointment.id,
        scheduledFor: reminderAt,
        status: "pending",
      }).onConflictDoNothing().returning({ id: notifications.id });
      if (reminder) {
        await enqueueOutbox(tx, {
          topic: "notification.dispatch",
          businessId: input.businessId,
          aggregateType: "appointment",
          aggregateId: appointment.id,
          dedupeKey: `notification:${reminder.id}:dispatch`,
          availableAt: reminderAt,
          payload: { notificationId: reminder.id, appointmentRevision: appointment.revision },
        });
      }
    }
    if (input.callId) await recordCallOutcomeInTransaction(tx, {
      businessId: input.businessId,
      callId: input.callId,
      // Browser voice starts with an anonymous contact and may bind it once at
      // booking; a phone call retains its original Caller ID contact.
      ...(input.sourceChannel === "web_voice" ? { contactId } : {}),
      outcome: { kind: "booked", serviceName: reference.serviceName, startsAt: startsAt.toISOString(), appointmentId: appointment.id },
    });
    if (input.apiAudit) await tx.insert(auditLogs).values({ businessId: input.businessId, actorUserId: input.apiAudit.actorUserId, eventType: "api.appointment.booked", entityType: "appointment", entityId: appointment.id, payload: input.apiAudit.payload });
    if (contactCreated) await emitWebhookEventInTransaction(tx, { businessId: input.businessId, type: "contact.created", resourceId: contactId });
    await emitWebhookEventInTransaction(tx, { businessId: input.businessId, type: "appointment.booked", resourceId: appointment.id });
    return { appointmentId: appointment.id, contactId, staffId: selectedStaff.id };
  });
}

async function recordAppointmentChange(
  context: DomainContext,
  input: { name: "appointment.rescheduled" | "appointment.cancelled"; businessId: string; appointmentId: string; source: string },
): Promise<void> {
  try {
    await recordProductEvent(context, {
      name: input.name,
      businessId: input.businessId,
      distinctId: getPostHogDistinctIdForBusinessSystem(input.businessId),
      properties: { appointmentId: input.appointmentId, source: input.source },
    });
  } catch {
    // Product telemetry is best-effort and must not fail the appointment change.
  }
}

type AppointmentChangeSource = { source: "operator"; userId: string } | { source: "caller" } | { source: "api"; audit: ApiAudit };

function changeAudit(change: AppointmentChangeSource): { actorUserId: string | null; payload: Record<string, unknown> } {
  if (change.source === "operator") return { actorUserId: change.userId, payload: { source: "operator" } };
  if (change.source === "api") return { actorUserId: change.audit.actorUserId, payload: { source: "api", ...change.audit.payload } };
  return { actorUserId: null, payload: { source: "caller" } };
}

/**
 * Cancels inside the caller's transaction: skips pending reminders, queues the
 * calendar removal, and emits appointment.cancelled. Returns "already" when the
 * appointment was cancelled before and "missing" when it does not exist.
 */
export async function cancelAppointmentInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; appointmentId: string; change: AppointmentChangeSource },
): Promise<"cancelled" | "already" | "missing"> {
  const [appointment] = await tx.update(appointments).set({ status: "canceled", calendarSyncState: "pending", revision: sql`${appointments.revision} + 1`, updatedAt: new Date() }).where(and(eq(appointments.id, input.appointmentId), eq(appointments.businessId, input.businessId), ne(appointments.status, "canceled"))).returning({ id: appointments.id, revision: appointments.revision });
  if (!appointment) {
    const [existing] = await tx.select({ id: appointments.id }).from(appointments).where(and(eq(appointments.id, input.appointmentId), eq(appointments.businessId, input.businessId))).limit(1);
    return existing ? "already" : "missing";
  }
  const audit = changeAudit(input.change);
  await tx.insert(auditLogs).values({ businessId: input.businessId, actorUserId: audit.actorUserId, eventType: "appointment_change.canceled", entityType: "appointment", entityId: appointment.id, payload: audit.payload });
  await tx.update(notifications)
    .set({ status: "skipped", updatedAt: new Date() })
    .where(and(
      eq(notifications.businessId, input.businessId),
      eq(notifications.relatedId, appointment.id),
      eq(notifications.kind, "appointment_reminder"),
      inArray(notifications.status, ["pending", "processing"]),
    ));
  await enqueueOutbox(tx, {
    topic: "calendar.syncAppointment",
    businessId: input.businessId,
    aggregateType: "appointment",
    aggregateId: appointment.id,
    dedupeKey: `appointment:${appointment.id}:calendar:cancel:${appointment.revision}`,
    payload: { appointmentId: appointment.id, action: "cancel" },
  });
  await enqueueOutbox(tx, {
    topic: "realtime.publish",
    businessId: input.businessId,
    aggregateType: "appointment",
    aggregateId: appointment.id,
    dedupeKey: `appointment:${appointment.id}:updated:${appointment.revision}`,
    payload: { type: "appointment.updated", entityId: appointment.id, revision: appointment.revision },
  });
  await emitWebhookEventInTransaction(tx, { businessId: input.businessId, type: "appointment.cancelled", resourceId: appointment.id });
  return "cancelled";
}

export async function cancelAppointment(
  context: DomainContext,
  input: { userId: string; businessId: string; appointmentId: string },
): Promise<void> {
  const changed = await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => {
    await requireBusinessMembership(tx, { userId: input.userId, businessId: input.businessId, minimumRole: "scheduler" });
    const result = await cancelAppointmentInTransaction(tx, { businessId: input.businessId, appointmentId: input.appointmentId, change: { source: "operator", userId: input.userId } });
    if (result === "missing") throw new Error("Appointment not found.");
    return result === "cancelled";
  });
  if (changed) await recordAppointmentChange(context, { name: "appointment.cancelled", businessId: input.businessId, appointmentId: input.appointmentId, source: "operator" });
}

/**
 * Moves an appointment to a new time with the same staff member, inside the
 * caller's transaction. Checks availability (hours, closures, calendar busy
 * time and freshness) under the staff lock, reschedules the reminder, queues
 * the calendar update and emits appointment.rescheduled. `beforeUpdate` runs
 * after the checks and can veto the change, for example to consume a caller's
 * verification.
 */
export async function rescheduleAppointmentInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; appointmentId: string; startsAt: string; change: AppointmentChangeSource; callerPhone?: string; staffId?: string; beforeUpdate?: () => Promise<boolean> },
): Promise<{ appointmentId: string; serviceId: string; startsAt: Date; endsAt: Date } | null> {
  const row = (await tx.select({ id: appointments.id, serviceId: appointments.serviceId, staffId: appointments.staffId, durationMinutes: services.durationMinutes }).from(appointments).innerJoin(contacts, and(eq(appointments.contactId, contacts.id), eq(contacts.businessId, input.businessId))).innerJoin(services, and(eq(appointments.serviceId, services.id), eq(services.businessId, input.businessId))).where(and(eq(appointments.id, input.appointmentId), eq(appointments.businessId, input.businessId), input.callerPhone !== undefined && !input.beforeUpdate ? eq(contacts.phone, input.callerPhone) : undefined)).limit(1))[0];
  if (!row) return null;
  // The appointment keeps its staff member unless the caller moves it to another one.
  const staffId = input.staffId ?? row.staffId;
  await lockStaff(tx, staffId);
  const startsAt = new Date(input.startsAt);
  if (!Number.isFinite(startsAt.getTime())) throw new Error("A valid appointment start time is required.");
  const endsAt = new Date(startsAt.getTime() + row.durationMinutes * 60_000);
  const slots = await availabilityInTransaction(tx, { businessId: input.businessId, serviceId: row.serviceId, startsAt: startsAt.toISOString(), staffIds: [staffId], ignoreAppointmentId: row.id });
  if (!slots.length) throw new Error("That appointment time is no longer available.");
  const conflict = (await tx.select({ id: appointments.id }).from(appointments).where(and(eq(appointments.businessId, input.businessId), eq(appointments.staffId, staffId), ne(appointments.status, "canceled"), ne(appointments.id, row.id), lt(appointments.startsAt, endsAt), gt(appointments.endsAt, startsAt))).limit(1))[0];
  if (conflict) throw new Error("That appointment time is no longer available.");
  if (input.beforeUpdate && !(await input.beforeUpdate())) return null;
  const [updated] = await tx.update(appointments).set({ startsAt, endsAt, staffId, status: "confirmed", calendarSyncState: "pending", revision: sql`${appointments.revision} + 1`, updatedAt: new Date() }).where(and(eq(appointments.id, row.id), eq(appointments.businessId, input.businessId), ne(appointments.status, "canceled"))).returning({ revision: appointments.revision });
  if (!updated) return null;
  await rescheduleAppointmentReminderInTransaction(tx, { businessId: input.businessId, appointmentId: row.id, startsAt, revision: updated.revision });
  const audit = changeAudit(input.change);
  await tx.insert(auditLogs).values({ businessId: input.businessId, actorUserId: audit.actorUserId, eventType: "appointment_change.rescheduled", entityType: "appointment", entityId: row.id, payload: { ...audit.payload, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), ...(staffId !== row.staffId ? { staffId } : {}) } });
  await enqueueOutbox(tx, { topic: "calendar.syncAppointment", businessId: input.businessId, aggregateType: "appointment", aggregateId: row.id, dedupeKey: `appointment:${row.id}:calendar:reschedule:${updated.revision}`, payload: { appointmentId: row.id, action: "reschedule" } });
  await enqueueOutbox(tx, { topic: "realtime.publish", businessId: input.businessId, aggregateType: "appointment", aggregateId: row.id, dedupeKey: `appointment:${row.id}:updated:${updated.revision}`, payload: { type: "appointment.updated", entityId: row.id, revision: updated.revision } });
  await emitWebhookEventInTransaction(tx, { businessId: input.businessId, type: "appointment.rescheduled", resourceId: row.id });
  return { appointmentId: row.id, serviceId: row.serviceId, startsAt, endsAt };
}

export async function rescheduleAppointmentForCaller(
  context: DomainContext,
  input: { businessId: string; appointmentId: string; callerPhone: string; startsAt: string; verificationId: string },
): Promise<{ appointmentId: string; serviceId: string; startsAt: Date; endsAt: Date } | null> {
  const result = await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => await rescheduleAppointmentInTransaction(tx, {
    businessId: input.businessId,
    appointmentId: input.appointmentId,
    startsAt: input.startsAt,
    callerPhone: input.callerPhone,
    change: { source: "caller" },
    beforeUpdate: async () => await consumeAppointmentChangeVerificationInTransaction(tx, { businessId: input.businessId, verificationId: input.verificationId, appointmentId: input.appointmentId, callerPhone: input.callerPhone, action: "reschedule" }),
  }));
  if (result) {
    await recordAppointmentChange(context, { name: "appointment.rescheduled", businessId: input.businessId, appointmentId: result.appointmentId, source: "caller" });
  }
  return result;
}

export async function cancelAppointmentForCaller(
  context: DomainContext,
  input: { businessId: string; appointmentId: string; callerPhone: string; verificationId: string },
): Promise<{ appointmentId: string; serviceId: string; startsAt: Date; endsAt: Date } | null> {
  const result = await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const row = (await tx.select({ id: appointments.id, serviceId: appointments.serviceId, startsAt: appointments.startsAt, endsAt: appointments.endsAt }).from(appointments).innerJoin(contacts, and(eq(appointments.contactId, contacts.id), eq(contacts.businessId, input.businessId))).where(and(eq(appointments.id, input.appointmentId), eq(appointments.businessId, input.businessId), ne(appointments.status, "canceled"))).limit(1))[0];
    if (!row) return null;
    const consumed = await consumeAppointmentChangeVerificationInTransaction(tx, { businessId: input.businessId, verificationId: input.verificationId, appointmentId: input.appointmentId, callerPhone: input.callerPhone, action: "cancel" });
    if (!consumed) return null;
    if (await cancelAppointmentInTransaction(tx, { businessId: input.businessId, appointmentId: row.id, change: { source: "caller" } }) !== "cancelled") return null;
    return { appointmentId: row.id, serviceId: row.serviceId, startsAt: row.startsAt, endsAt: row.endsAt };
  });
  if (result) {
    await recordAppointmentChange(context, { name: "appointment.cancelled", businessId: input.businessId, appointmentId: result.appointmentId, source: "caller" });
  }
  return result;
}

/** Email callers share canonical hours, staff eligibility, freshness and conflict checks. */
export async function findEmailAvailabilityInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; serviceId: string; startsAt: string; now: Date; staffId?: string; ignoreAppointmentId?: string },
) {
  const reference = await loadAvailabilityReference(tx,input);
  const [settings] = await tx.select({ config: lmcSettings.config }).from(lmcSettings).where(eq(lmcSettings.tenantId, input.businessId)).limit(1);
  const rules = lmcBookingRulesSchema.safeParse(settings?.config.bookingRules ?? {});
  if (!rules.success) return [];
  const horizon = DateTime.fromJSDate(input.now, { zone: reference.timezone }).startOf("day").plus({ days: rules.data.horizonDays }).toMillis();
  const starts = reference.startsAt.getTime();
  if (!Number.isFinite(horizon) || reference.startsAt <= input.now || starts < input.now.getTime() + rules.data.minimumNoticeMinutes * 60_000 || starts >= horizon) return [];
  const selected = eligibleStaffIds(reference,input.staffId ? [input.staffId] : undefined).filter(id =>
    reference.connections.some(connection => connection.provider === "google" && connection.status === "connected" && connection.selectedCalendarId && (!connection.staffId || connection.staffId === id))
    && isCalendarFresh(reference,id,input.now.getTime()));
  const [ignored] = input.ignoreAppointmentId ? await tx.select({externalId:appointments.calendarExternalId}).from(appointments).where(and(eq(appointments.businessId,input.businessId),eq(appointments.id,input.ignoreAppointmentId))).limit(1) : [];
  return staffAvailabilityInTransaction(tx,reference,{staffIds:selected,...(input.ignoreAppointmentId?{ignoreAppointmentId:input.ignoreAppointmentId}:{}),...(ignored?.externalId?{ignoreCalendarEventId:ignored.externalId}:{})});
}

/** No synthetic phone or SMS work: the verified email contact is the canonical appointment contact. */
export async function bookEmailAppointmentInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; contactId: string; contactEmail: string; serviceId: string; staffId: string; startsAt: string; now: Date },
): Promise<{ appointmentId: string; startsAt: string; endsAt: string } | null> {
  const [contact] = await tx.select({id:contacts.id}).from(contacts).where(and(eq(contacts.businessId,input.businessId),eq(contacts.id,input.contactId),eq(contacts.email,input.contactEmail))).limit(1);
  if (!contact) return null;
  await lockStaff(tx,input.staffId);
  const slots = await findEmailAvailabilityInTransaction(tx,input);
  const slot = slots.find(candidate => candidate.staffId === input.staffId && Date.parse(candidate.startsAt) === Date.parse(input.startsAt));
  if (!slot) return null;
  const [business] = await tx.select({timezone:businesses.timezone}).from(businesses).where(eq(businesses.id,input.businessId)).limit(1);
  if (!business) return null;
  const [appointment] = await tx.insert(appointments).values({businessId:input.businessId,contactId:input.contactId,staffId:slot.staffId,serviceId:slot.serviceId,
    startsAt:new Date(slot.startsAt),endsAt:new Date(slot.endsAt),timezone:business.timezone,status:"confirmed",sourceChannel:"email",calendarSyncState:"pending",createdAt:input.now,updatedAt:input.now}).returning({id:appointments.id,revision:appointments.revision});
  if (!appointment) throw new Error("LMC_APPOINTMENT_CREATE_FAILED");
  await enqueueOutbox(tx,{topic:"calendar.syncAppointment",businessId:input.businessId,aggregateType:"appointment",aggregateId:appointment.id,dedupeKey:`appointment:${appointment.id}:calendar:create`,payload:{appointmentId:appointment.id}});
  await enqueueOutbox(tx,{topic:"realtime.publish",businessId:input.businessId,aggregateType:"appointment",aggregateId:appointment.id,dedupeKey:`appointment:${appointment.id}:updated:${appointment.revision}`,payload:{type:"appointment.updated",entityId:appointment.id,revision:appointment.revision}});
  await tx.insert(auditLogs).values({businessId:input.businessId,eventType:"email.appointment.booked",entityType:"appointment",entityId:appointment.id,payload:{source:"email",contactId:contact.id},createdAt:input.now});
  await emitWebhookEventInTransaction(tx,{businessId:input.businessId,type:"appointment.booked",resourceId:appointment.id});
  return {appointmentId:appointment.id,startsAt:slot.startsAt,endsAt:slot.endsAt};
}

/** Email changes retain canonical calendar/outbox behavior without creating SMS work. */
export async function rescheduleEmailAppointmentInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; appointmentId: string; contactId: string; contactEmail: string; staffId: string; startsAt: string; now: Date },
): Promise<{startsAt:string;endsAt:string}|null> {
  const [initial]=await tx.select({staffId:appointments.staffId}).from(appointments).where(and(eq(appointments.businessId,input.businessId),eq(appointments.id,input.appointmentId),eq(appointments.sourceChannel,"email"))).limit(1);
  if(!initial)return null;
  for(const id of [...new Set([initial.staffId,input.staffId])].sort())await lockStaff(tx,id);
  const [current]=await tx.select().from(appointments).where(and(eq(appointments.businessId,input.businessId),eq(appointments.id,input.appointmentId),eq(appointments.contactId,input.contactId),eq(appointments.sourceChannel,"email"),eq(appointments.status,"confirmed"))).for("update");
  const [contact]=await tx.select({id:contacts.id}).from(contacts).where(and(eq(contacts.businessId,input.businessId),eq(contacts.id,input.contactId),eq(contacts.email,input.contactEmail))).limit(1);
  if(!current||!contact||current.staffId!==initial.staffId)return null;
  const slots=await findEmailAvailabilityInTransaction(tx,{businessId:input.businessId,serviceId:current.serviceId,startsAt:input.startsAt,staffId:input.staffId,now:input.now,ignoreAppointmentId:current.id});
  const slot=slots.find(item=>item.staffId===input.staffId&&Date.parse(item.startsAt)===Date.parse(input.startsAt));
  if(!slot)return null;
  const [updated]=await tx.update(appointments).set({startsAt:new Date(slot.startsAt),endsAt:new Date(slot.endsAt),staffId:slot.staffId,calendarSyncState:"pending",revision:sql`${appointments.revision}+1`,updatedAt:input.now}).where(and(eq(appointments.businessId,input.businessId),eq(appointments.id,current.id))).returning({revision:appointments.revision});
  if(!updated)throw new Error("LMC_APPOINTMENT_CHANGE_FAILED");
  await enqueueOutbox(tx,{topic:"calendar.syncAppointment",businessId:input.businessId,aggregateType:"appointment",aggregateId:current.id,dedupeKey:`appointment:${current.id}:calendar:reschedule:${updated.revision}`,payload:{appointmentId:current.id,action:"reschedule"}});
  await enqueueOutbox(tx,{topic:"realtime.publish",businessId:input.businessId,aggregateType:"appointment",aggregateId:current.id,dedupeKey:`appointment:${current.id}:updated:${updated.revision}`,payload:{type:"appointment.updated",entityId:current.id,revision:updated.revision}});
  await tx.insert(auditLogs).values({businessId:input.businessId,eventType:"email.appointment.rescheduled",entityType:"appointment",entityId:current.id,payload:{source:"email",contactId:contact.id,startsAt:slot.startsAt},createdAt:input.now});
  await emitWebhookEventInTransaction(tx,{businessId:input.businessId,type:"appointment.rescheduled",resourceId:current.id});
  return{startsAt:slot.startsAt,endsAt:slot.endsAt};
}
