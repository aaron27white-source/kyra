import { and, asc, eq, ilike, or } from "drizzle-orm";
import { DateTime } from "luxon";

import { receptionistProfiles, services, withBusinessTransaction } from "@lobbystack/db";
import { normalizeAppointmentChangePolicy, type HoursWindow } from "@lobbystack/shared";
import { getPostHogDistinctIdForBusinessSystem } from "@lobbystack/telemetry";

import { createAppointmentChangeVerification } from "./appointmentChanges";
import { bookAppointment, cancelAppointmentForCaller, findAvailability, rescheduleAppointmentForCaller } from "./booking";
import { recordCallSchedulingProgress } from "./callOutcome";
import type { DomainContext } from "./context";
import { appendMessage, getOrCreateConversation } from "./conversations";
import { queueOperatorAlert } from "./notifications";
import { recordProductEvent } from "./productEvents";
import { createVoiceFollowUpTask } from "./voice";
import type { ServiceIntake } from "./service-intake";
import { findAppointmentChangeMatches } from "./appointmentChangeLookup";

// Actions the receptionist agent takes on a business's behalf, whatever the
// channel. Each one opens its own tenant-scoped transaction.

export type ReceptionistChannel = "voice" | "web_voice" | "web_chat" | "sms";

async function resolveActiveService(context: DomainContext, businessId: string, serviceName: string) {
  return await withBusinessTransaction(context.db, { businessId, actorType: "worker" }, async (tx) => {
    const normalized = serviceName.trim().toLowerCase();
    return (await tx.select({ id: services.id, name: services.name, durationMinutes: services.durationMinutes }).from(services).where(and(eq(services.businessId, businessId), eq(services.active, true), or(eq(services.slug, normalized), ilike(services.name, serviceName.trim())))).limit(1))[0];
  });
}

async function safeRecordProductEvent(context: DomainContext, input: Parameters<typeof recordProductEvent>[1]): Promise<void> {
  try {
    await recordProductEvent(context, input);
  } catch {
    // Product telemetry is best-effort and must never fail the caller's request.
  }
}

export function bookingFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("Service is not available")) return "service_unavailable";
  if (message.includes("No staff member is available")) return "no_staff_available";
  if (message.includes("no longer available")) return "slot_unavailable";
  if (message.includes("required")) return "invalid_request";
  if (message.includes("Contact could not be created")) return "contact_create_failed";
  if (message.includes("Appointment could not be created")) return "appointment_create_failed";
  if (message.includes("Booking confirmation notification")) return "notification_create_failed";
  return "unknown";
}

const OPENING_STEP_MINUTES = 30;
// Availability checks run this many at a time, so a busy day is scanned in
// full without one slow query per start time.
const OPENING_CHECK_BATCH = 6;

// Start times to try on a local date, inside business hours, nearest to the
// caller's preferred time first.
export function candidateStartTimes(input: { date: string; timezone: string; hours: HoursWindow[]; durationMinutes: number; preferredMinutes?: number; now?: Date }): string[] {
  const day = DateTime.fromISO(`${input.date}T00:00:00`, { zone: input.timezone });
  if (!day.isValid) return [];
  const weekday = day.weekday % 7;
  const now = input.now ?? new Date();
  const minutes: number[] = [];
  for (const window of input.hours.filter((item) => item.dayOfWeek === weekday)) {
    for (let start = window.openMinutes; start + input.durationMinutes <= window.closeMinutes; start += OPENING_STEP_MINUTES) minutes.push(start);
  }
  const preferred = input.preferredMinutes;
  return minutes
    .sort((left, right) => preferred === undefined ? left - right : Math.abs(left - preferred) - Math.abs(right - preferred) || left - right)
    // Set the wall-clock time; adding minutes to midnight drifts an hour on DST days.
    .map((value) => day.set({ hour: Math.floor(value / 60), minute: value % 60 }))
    .filter((start) => start.toJSDate() > now)
    .map((start) => start.toUTC().toISO()!);
}

export async function findOpenings(
  context: DomainContext,
  input: { businessId: string; serviceName: string; date: string; timezone: string; hours: HoursWindow[]; preferredHour24?: number; preferredMinute?: number; limit?: number; callId?: string },
) {
  const service = await resolveActiveService(context, input.businessId, input.serviceName);
  if (!service) return { ok: false as const, reason: "Service is not available." };
  const candidates = candidateStartTimes({
    date: input.date,
    timezone: input.timezone,
    hours: input.hours,
    durationMinutes: service.durationMinutes,
    ...(input.preferredHour24 !== undefined ? { preferredMinutes: input.preferredHour24 * 60 + (input.preferredMinute ?? 0) } : {}),
  });
  const limit = input.limit ?? 3;
  const openings: string[] = [];
  // Scan the whole day, nearest first, and stop once there are enough openings.
  for (let index = 0; index < candidates.length && openings.length < limit; index += OPENING_CHECK_BATCH) {
    const batch = candidates.slice(index, index + OPENING_CHECK_BATCH);
    const available = await Promise.all(batch.map(async (startsAt) => (await findAvailability(context, { businessId: input.businessId, serviceId: service.id, startsAt, timezone: input.timezone })).length > 0));
    for (const [position, startsAt] of batch.entries()) if (available[position] && openings.length < limit) openings.push(startsAt);
  }
  if (input.callId) await recordCallSchedulingProgress(context, { businessId: input.businessId, callId: input.callId, serviceName: service.name });
  return {
    ok: true as const,
    serviceName: service.name,
    date: input.date,
    timezone: input.timezone,
    openings: openings.sort().map((startsAt) => ({ startsAt, displayTime: DateTime.fromISO(startsAt).setZone(input.timezone).toFormat("cccc LLL d, h:mm a") })),
  };
}

export async function checkOpening(
  context: DomainContext,
  input: { businessId: string; serviceName: string; startsAt: string; timezone: string; callId?: string },
) {
  const service = await resolveActiveService(context, input.businessId, input.serviceName);
  if (!service) return { ok: false as const, reason: "Service is not available." };
  const slots = await findAvailability(context, { businessId: input.businessId, serviceId: service.id, startsAt: input.startsAt, timezone: input.timezone });
  if (input.callId) await recordCallSchedulingProgress(context, { businessId: input.businessId, callId: input.callId, serviceName: service.name, startsAt: input.startsAt });
  return { ok: true as const, serviceName: service.name, available: slots.length > 0 };
}

export async function bookForCaller(
  context: DomainContext,
  input: { businessId: string; serviceName: string; startsAt: string; timezone: string; contactPhone: string; contactName?: string; smsConsentGranted?: boolean; intake?: ServiceIntake; channel: ReceptionistChannel; callId?: string; sessionId?: string },
) {
  const startedAt = Date.now();
  const operationalLog = (event: string, reasonCode: string) => {
    try { console.info(JSON.stringify({ event, operation: "book_appointment", businessId: input.businessId, ...(input.callId ? { callId: input.callId } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}), reasonCode, durationMs: Date.now() - startedAt })); } catch { /* observability never controls booking */ }
  };
  if (!/^\+[1-9]\d{7,14}$/.test(input.contactPhone)) {
    operationalLog("voice.booking.failed", "invalid_phone");
    return { ok: false as const, reason: "A valid callback number in international format is needed." };
  }
  const distinctId = getPostHogDistinctIdForBusinessSystem(input.businessId);
  try {
    const service = await resolveActiveService(context, input.businessId, input.serviceName);
    if (!service) {
      operationalLog("voice.booking.failed", "service_unavailable");
      await safeRecordProductEvent(context, { name: "appointment.booking_failed", businessId: input.businessId, distinctId, properties: { reason: "service_unavailable", requestedServiceName: input.serviceName, channel: input.channel, sourceChannel: input.channel } });
      return { ok: false as const, reason: "Service is not available." };
    }
    const appointment = await bookAppointment(context, {
      businessId: input.businessId,
      serviceId: service.id,
      startsAt: input.startsAt,
      timezone: input.timezone,
      contactPhone: input.contactPhone,
      sourceChannel: input.channel,
      ...(input.callId ? { callId: input.callId } : {}),
      ...(input.smsConsentGranted ? { smsConsentGranted: true } : {}),
      ...(input.contactName ? { contactName: input.contactName } : {}),
      ...(input.intake ? { intake: input.intake } : {}),
    });
    if (!appointment.idempotent) await safeRecordProductEvent(context, { name: "appointment.booked", businessId: input.businessId, distinctId, properties: { appointmentId: appointment.appointmentId, channel: input.channel, serviceId: service.id, sourceChannel: input.channel } });
    operationalLog("voice.booking.committed", "committed");
    return { ok: true as const, appointmentId: appointment.appointmentId, serviceName: service.name, startsAt: input.startsAt };
  } catch (error) {
    const intakeError = error as Error & { code?: string; missingFields?: string[]; validationIssues?: Array<{ field: string; code: string }> };
    if (intakeError.code === "missing_required_fields" || intakeError.code === "invalid_service_address" || intakeError.code === "outside_service_area") {
      operationalLog("voice.booking.intake_incomplete", intakeError.code);
      const invalidField = intakeError.validationIssues?.[0]?.field;
      const reason = intakeError.code === "outside_service_area" ? "That location is outside the configured service area. Do not offer an onsite appointment; offer to take a message for the team instead." : intakeError.code === "invalid_service_address" ? `The service address needs clarification. Ask only about ${invalidField ?? "the invalid address field"}; do not ask for the entire address again.` : "The appointment is not booked yet. Ask only for the required intake details listed below, then retry.";
      return { ok: false as const, reasonCode: intakeError.code, reason, missingFields: intakeError.missingFields ?? [], validationIssues: intakeError.validationIssues ?? [] };
    }
    const reason = bookingFailureReason(error);
    operationalLog("voice.booking.failed", reason);
    await safeRecordProductEvent(context, { name: "appointment.booking_failed", businessId: input.businessId, distinctId, properties: { reason, requestedServiceName: input.serviceName, channel: input.channel, sourceChannel: input.channel } });
    return { ok: false as const, reason: reason === "slot_unavailable" ? "That time is no longer available." : "The booking could not be completed." };
  }
}

export async function lookupCallerAppointments(context: DomainContext, input: { businessId: string; callerPhone: string; callerName?: string; appointmentStartsAt?: string; serviceName?: string; appointmentId?: string; timezone?: string }) {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const [lookup, profile] = await Promise.all([
      findAppointmentChangeMatches(tx, input),
      tx.select({ appointmentChangePolicy: receptionistProfiles.appointmentChangePolicy }).from(receptionistProfiles).where(eq(receptionistProfiles.businessId, input.businessId)).limit(1),
    ]);
    const { matches, callerPhoneAppointmentCount } = lookup;
    const policy = normalizeAppointmentChangePolicy(profile[0]?.appointmentChangePolicy);
    // Return only an opaque ID for a unique match. Alternate-number matches
    // require OTP to the saved contact number before any change or disclosure.
    return { ok: true as const, policy: { ...policy, enabled: policy.enabled && (callerPhoneAppointmentCount > 0 || matches.length > 0) }, phoneMatched: callerPhoneAppointmentCount > 0, appointmentCount: callerPhoneAppointmentCount, matchingAppointmentCount: matches.length, reason: lookup.reason, matchingStrategy: lookup.matchingStrategy, matchedFacts: lookup.matchedFacts, ...(matches.length === 1 ? { appointmentId: matches[0]!.id } : {}) };
  });
}

export async function verifyCallerForChange(
  context: DomainContext,
  input: { businessId: string; callerPhone: string; action: "cancel" | "reschedule"; appointmentId?: string; callerName?: string; appointmentStartsAt?: string; serviceName?: string; timezone?: string },
) {
  const verification = await createAppointmentChangeVerification(context, input);
  if (!verification) return { ok: false as const, verified: false, reason: "The appointment could not be verified." };
  const verified = verification.status === "otp_verified" || verification.status === "facts_verified";
  return { ok: true as const, verified, requiresOtp: !verified, verificationId: verification.verificationId, appointmentId: verification.appointmentId, status: verification.status, ...(verified && verification.appointment ? { appointment: verification.appointment } : {}) };
}

export async function cancelForCaller(
  context: DomainContext,
  input: { businessId: string; callerPhone: string; appointmentId: string; verificationId?: string; finalConfirmation: boolean },
) {
  if (!input.finalConfirmation) return { ok: false as const, reason: "Final confirmation is required." };
  if (!input.verificationId) return { ok: false as const, reason: "The appointment change verification is required." };
  const result = await cancelAppointmentForCaller(context, { businessId: input.businessId, appointmentId: input.appointmentId, callerPhone: input.callerPhone, verificationId: input.verificationId });
  if (!result) return { ok: false as const, reason: "The appointment could not be verified." };
  return { ok: true as const, appointmentId: input.appointmentId, startsAt: result.startsAt.toISOString(), status: "canceled" };
}

export async function rescheduleForCaller(
  context: DomainContext,
  input: { businessId: string; callerPhone: string; appointmentId: string; startsAt: string; verificationId?: string; finalConfirmation: boolean },
) {
  if (!input.finalConfirmation) return { ok: false as const, reason: "Final confirmation is required." };
  if (!input.verificationId) return { ok: false as const, reason: "The appointment change verification is required." };
  const result = await rescheduleAppointmentForCaller(context, { businessId: input.businessId, appointmentId: input.appointmentId, callerPhone: input.callerPhone, startsAt: input.startsAt, verificationId: input.verificationId });
  if (!result) return { ok: false as const, reason: "The appointment could not be verified." };
  return { ok: true as const, appointmentId: input.appointmentId, startsAt: result.startsAt.toISOString(), status: "confirmed" };
}

export async function takeMessageForStaff(
  context: DomainContext,
  input: { businessId: string; message: string; channel: ReceptionistChannel; callerName?: string; callbackPhone?: string; urgency?: string; callbackWindow?: string; requestKind?: "appointment_request"; callId?: string; conversationId?: string },
) {
  const alert = { eventKind: "voiceMessage" as const, subject: "New voice message", body: "A caller left a voice message. Open the inbox to review it." };
  // A website chat's conversation is the visitor's own thread: a staff note
  // there would show up to them, and to the agent, as if they had written it.
  const inVisitorThread = input.channel === "web_chat" && input.conversationId !== undefined;
  if (!inVisitorThread) {
    const conversationId = input.conversationId ?? (await getOrCreateConversation(context, { businessId: input.businessId, contactPhone: input.callbackPhone ?? "unknown", channel: input.channel === "web_chat" ? "web_chat" : "voice" })).conversationId;
    await appendMessage(context, {
      businessId: input.businessId,
      conversationId,
      body: input.message,
      direction: "inbound",
      channel: "dashboard",
      operatorAlert: alert,
    });
  }
  const task = await createVoiceFollowUpTask(context, {
    businessId: input.businessId,
    message: input.message,
    channel: input.channel,
    ...(input.callId ? { callId: input.callId } : {}),
    ...(input.callerName ? { callerName: input.callerName } : {}),
    ...(input.callbackPhone ? { callbackPhone: input.callbackPhone } : {}),
    ...(input.urgency ? { urgency: input.urgency } : {}),
    ...(input.callbackWindow ? { callbackWindow: input.callbackWindow } : {}),
    ...(input.requestKind ? { requestKind: input.requestKind } : {}),
  });
  if (inVisitorThread) await queueOperatorAlert(context, { businessId: input.businessId, eventKey: `${alert.eventKind}:${task.inboxItemId}`, ...alert });
  return { ok: true as const, inboxItemId: task.inboxItemId };
}
