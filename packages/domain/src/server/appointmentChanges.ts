import { createHash, randomInt, timingSafeEqual } from "node:crypto";

import { and, eq, gt, inArray, lt, or } from "drizzle-orm";

import { appointmentChangeVerifications, appointments, auditLogs, contacts, enqueueOutbox, phoneNumbers, receptionistProfiles, services, withBusinessTransaction, type DatabaseTransaction } from "@lobbystack/db";
import { normalizeAppointmentChangePolicy } from "@lobbystack/shared";

import { contactPhoneMatchesCallerValue } from "./contactPhone";
import { findAppointmentChangeMatches } from "./appointmentChangeLookup";

import type { DomainContext } from "./context";

const OTP_TTL_MS = 10 * 60_000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_SEND_LEASE_MS = 5 * 60_000;

function otpSecret(): string {
  return process.env.OTP_HASH_SECRET ?? process.env.ENCRYPTION_KEY ?? process.env.BETTER_AUTH_SECRET ?? "development-only-change-me";
}

function hashOtp(code: string): string {
  return createHash("sha256").update(`${otpSecret()}:${code}`).digest("hex");
}

function matchesOtp(expectedHash: string, code: string): boolean {
  const actual = Buffer.from(hashOtp(code), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function newOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return `••••${digits.slice(-2)}`;
}

async function verifiedAppointmentSummary(tx: DatabaseTransaction, businessId: string, appointmentId: string) {
  const row = (await tx.select({ startsAt: appointments.startsAt, timezone: appointments.timezone, serviceName: services.name })
    .from(appointments)
    .innerJoin(services, and(eq(services.id, appointments.serviceId), eq(services.businessId, businessId)))
    .where(and(eq(appointments.id, appointmentId), eq(appointments.businessId, businessId)))
    .limit(1))[0];
  return row ? { startsAt: row.startsAt.toISOString(), timezone: row.timezone, serviceName: row.serviceName } : undefined;
}

async function auditAppointmentChange(tx: DatabaseTransaction, input: { businessId: string; appointmentId: string; verificationId?: string; eventType: string; payload?: Record<string, unknown> }): Promise<void> {
  await tx.insert(auditLogs).values({ businessId: input.businessId, eventType: input.eventType, entityType: "appointment_change", entityId: input.appointmentId, payload: { ...(input.verificationId ? { verificationId: input.verificationId } : {}), ...(input.payload ?? {}) } });
}

export async function createAppointmentChangeVerification(
  context: DomainContext,
  input: { businessId: string; appointmentId?: string; callerPhone: string; action: "cancel" | "reschedule"; callerName?: string; appointmentStartsAt?: string; serviceName?: string; timezone?: string },
): Promise<{ verificationId: string; appointmentId: string; contactId: string; status: string; expiresAt: string; appointment?: { startsAt: string; timezone: string; serviceName: string } } | null> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const profile = (await tx.select({ policy: receptionistProfiles.appointmentChangePolicy }).from(receptionistProfiles).where(eq(receptionistProfiles.businessId, input.businessId)).limit(1))[0];
    const policy = normalizeAppointmentChangePolicy(profile?.policy);
    if (!policy.enabled || policy.verificationMode === "operator_only" || (input.action === "cancel" ? !policy.allowCancel : !policy.allowReschedule)) return null;
    if (!input.appointmentStartsAt?.trim() && !input.serviceName?.trim()) return null;
    const { matches } = await findAppointmentChangeMatches(tx, input);
    if (matches.length !== 1) return null;
    const appointment = matches[0]!;
    const now = new Date();
    // Serialize duplicate verify calls for the same booking. Reuse an active
    // verification so retries cannot invalidate a code already sent.
    await tx.select({ id: appointments.id }).from(appointments)
      .where(and(eq(appointments.id, appointment.id), eq(appointments.businessId, input.businessId)))
      .limit(1).for("update");
    const existing = (await tx.select({ id: appointmentChangeVerifications.id, status: appointmentChangeVerifications.status, expiresAt: appointmentChangeVerifications.expiresAt })
      .from(appointmentChangeVerifications)
      .where(and(eq(appointmentChangeVerifications.businessId, input.businessId), eq(appointmentChangeVerifications.appointmentId, appointment.id), eq(appointmentChangeVerifications.callerPhone, input.callerPhone), eq(appointmentChangeVerifications.action, input.action), inArray(appointmentChangeVerifications.status, ["facts_verified", "otp_verified", "otp_pending", "otp_queued", "otp_sending", "otp_sent"]), gt(appointmentChangeVerifications.expiresAt, now)))
      .limit(1).for("update"))[0];
    if (existing) {
      const summary = existing.status === "facts_verified" ? await verifiedAppointmentSummary(tx, input.businessId, appointment.id) : undefined;
      return { verificationId: existing.id, appointmentId: appointment.id, contactId: appointment.contactId, status: existing.status, expiresAt: existing.expiresAt.toISOString(), ...(summary ? { appointment: summary } : {}) };
    }
    const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
    const status = policy.verificationMode === "otp_required" || !contactPhoneMatchesCallerValue(appointment.phone, input.callerPhone) ? "otp_pending" : "facts_verified";
    const [verification] = await tx.insert(appointmentChangeVerifications).values({ businessId: input.businessId, appointmentId: appointment.id, contactId: appointment.contactId, callerPhone: input.callerPhone, action: input.action, status, expiresAt, attemptCount: 0 }).returning({ id: appointmentChangeVerifications.id });
    if (!verification) throw new Error("Appointment change verification could not be created.");
    await auditAppointmentChange(tx, { businessId: input.businessId, appointmentId: appointment.id, verificationId: verification.id, eventType: "appointment_change.verification_created", payload: { action: input.action } });
    const summary = status === "facts_verified" ? await verifiedAppointmentSummary(tx, input.businessId, appointment.id) : undefined;
    return { verificationId: verification.id, appointmentId: appointment.id, contactId: appointment.contactId, status, expiresAt: expiresAt.toISOString(), ...(summary ? { appointment: summary } : {}) };
  });
}

export async function issueAppointmentChangeOtp(
  context: DomainContext,
  input: { businessId: string; verificationId: string },
): Promise<{ ok: true; status: string; verificationId: string; otpPhone: string } | { ok: false; status: string; reason: string }> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const current = (await tx.select({ id: appointmentChangeVerifications.id, appointmentId: appointmentChangeVerifications.appointmentId, callerPhone: appointmentChangeVerifications.callerPhone, status: appointmentChangeVerifications.status, expiresAt: appointmentChangeVerifications.expiresAt, attemptCount: appointmentChangeVerifications.attemptCount, contactPhone: contacts.phone }).from(appointmentChangeVerifications).innerJoin(contacts, and(eq(contacts.id, appointmentChangeVerifications.contactId), eq(contacts.businessId, input.businessId))).where(and(eq(appointmentChangeVerifications.id, input.verificationId), eq(appointmentChangeVerifications.businessId, input.businessId))).limit(1).for("update"))[0];
    const now = new Date();
    if (!current) return { ok: false, status: "missing", reason: "The verification session was not found." };
    if (current.expiresAt <= now || ["expired", "superseded", "used", "failed"].includes(current.status)) {
      await tx.update(appointmentChangeVerifications).set({ status: "expired", updatedAt: now }).where(eq(appointmentChangeVerifications.id, current.id));
      await auditAppointmentChange(tx, { businessId: input.businessId, appointmentId: current.appointmentId, verificationId: current.id, eventType: "appointment_change.verification_expired" });
      return { ok: false, status: "expired", reason: "The verification session has expired." };
    }
    if (current.attemptCount >= OTP_MAX_ATTEMPTS) return { ok: false, status: "failed", reason: "Too many verification attempts." };
    if (["otp_queued", "otp_sending", "otp_sent"].includes(current.status)) {
      if (!current.contactPhone) return { ok: false, status: "unavailable", reason: "The saved contact has no phone number for verification." };
      return { ok: true, status: current.status, verificationId: current.id, otpPhone: maskPhone(current.contactPhone) };
    }
    if (current.status !== "otp_pending") return { ok: false, status: current.status, reason: "This verification session cannot send a new code." };
    const sender = (await tx.select({ e164: phoneNumbers.e164 }).from(phoneNumbers).where(and(eq(phoneNumbers.businessId, input.businessId), eq(phoneNumbers.status, "active"), eq(phoneNumbers.smsEnabled, true))).limit(1))[0];
    if (!sender) return { ok: false, status: "unavailable", reason: "SMS delivery is not configured for this business." };
    if (!current.contactPhone) return { ok: false, status: "unavailable", reason: "The saved contact has no phone number for verification." };
    const code = newOtp();
    const queued = await tx.update(appointmentChangeVerifications).set({ codeHash: hashOtp(code), status: "otp_queued", expiresAt: new Date(now.getTime() + OTP_TTL_MS), updatedAt: now }).where(and(eq(appointmentChangeVerifications.id, current.id), eq(appointmentChangeVerifications.status, "otp_pending"))).returning({ id: appointmentChangeVerifications.id });
    if (!queued.length) return { ok: false, status: current.status, reason: "The verification code is already being processed." };
    await enqueueOutbox(tx, { topic: "appointment.sendChangeOtp", businessId: input.businessId, aggregateType: "appointment_change_verification", aggregateId: current.id, dedupeKey: `appointment-change-otp:${current.id}`, payload: { verificationId: current.id, code, to: current.contactPhone, from: sender.e164 } });
    await auditAppointmentChange(tx, { businessId: input.businessId, appointmentId: current.appointmentId, verificationId: current.id, eventType: "appointment_change.otp_queued" });
    return { ok: true, status: "otp_queued", verificationId: current.id, otpPhone: maskPhone(current.contactPhone) };
  });
}

export async function claimAppointmentChangeOtp(
  context: DomainContext,
  input: { businessId: string; verificationId: string },
): Promise<boolean> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const staleBefore = new Date(Date.now() - OTP_SEND_LEASE_MS);
    const rows = await tx.update(appointmentChangeVerifications).set({ status: "otp_sending", updatedAt: new Date() }).where(and(eq(appointmentChangeVerifications.id, input.verificationId), eq(appointmentChangeVerifications.businessId, input.businessId), or(eq(appointmentChangeVerifications.status, "otp_queued"), and(eq(appointmentChangeVerifications.status, "otp_sending"), lt(appointmentChangeVerifications.updatedAt, staleBefore))))).returning({ id: appointmentChangeVerifications.id });
    if (rows.length > 0) {
      const row = (await tx.select({ appointmentId: appointmentChangeVerifications.appointmentId }).from(appointmentChangeVerifications).where(eq(appointmentChangeVerifications.id, input.verificationId)).limit(1))[0];
      if (row) await auditAppointmentChange(tx, { businessId: input.businessId, appointmentId: row.appointmentId, verificationId: input.verificationId, eventType: "appointment_change.otp_send_claimed" });
    }
    return rows.length > 0;
  });
}

export async function loadAppointmentChangeOtpTarget(
  context: DomainContext,
  input: { businessId: string; verificationId: string; to: string; from: string; code: string },
): Promise<{ to: string; from: string; code: string } | null> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const row = (await tx.select({ id: appointmentChangeVerifications.id, expiresAt: appointmentChangeVerifications.expiresAt, status: appointmentChangeVerifications.status }).from(appointmentChangeVerifications).innerJoin(contacts, and(eq(contacts.id, appointmentChangeVerifications.contactId), eq(contacts.businessId, input.businessId))).where(and(eq(appointmentChangeVerifications.id, input.verificationId), eq(appointmentChangeVerifications.businessId, input.businessId), eq(contacts.phone, input.to), eq(appointmentChangeVerifications.status, "otp_sending"))).limit(1))[0];
    if (!row || row.expiresAt <= new Date()) return null;
    return { to: input.to, from: input.from, code: input.code };
  });
}

export async function markAppointmentChangeOtpSent(
  context: DomainContext,
  input: { businessId: string; verificationId: string },
): Promise<boolean> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const rows = await tx.update(appointmentChangeVerifications).set({ status: "otp_sent", updatedAt: new Date() }).where(and(eq(appointmentChangeVerifications.id, input.verificationId), eq(appointmentChangeVerifications.businessId, input.businessId), eq(appointmentChangeVerifications.status, "otp_sending"))).returning({ id: appointmentChangeVerifications.id });
    if (rows.length > 0) {
      const row = (await tx.select({ appointmentId: appointmentChangeVerifications.appointmentId }).from(appointmentChangeVerifications).where(eq(appointmentChangeVerifications.id, input.verificationId)).limit(1))[0];
      if (row) await auditAppointmentChange(tx, { businessId: input.businessId, appointmentId: row.appointmentId, verificationId: input.verificationId, eventType: "appointment_change.otp_sent" });
    }
    return rows.length > 0;
  });
}

export async function releaseAppointmentChangeOtp(
  context: DomainContext,
  input: { businessId: string; verificationId: string },
): Promise<void> {
  await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const [row] = await tx.update(appointmentChangeVerifications).set({ status: "otp_queued", updatedAt: new Date() }).where(and(eq(appointmentChangeVerifications.id, input.verificationId), eq(appointmentChangeVerifications.businessId, input.businessId), eq(appointmentChangeVerifications.status, "otp_sending"))).returning({ appointmentId: appointmentChangeVerifications.appointmentId });
    if (row) await auditAppointmentChange(tx, { businessId: input.businessId, appointmentId: row.appointmentId, verificationId: input.verificationId, eventType: "appointment_change.otp_delivery_failed" });
  });
}

export async function verifyAppointmentChangeOtp(
  context: DomainContext,
  input: { businessId: string; verificationId: string; code: string },
): Promise<{ ok: boolean; status: string; verificationId: string; reason?: string; appointment?: { startsAt: string; timezone: string; serviceName: string } }> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const current = (await tx.select({ id: appointmentChangeVerifications.id, appointmentId: appointmentChangeVerifications.appointmentId, status: appointmentChangeVerifications.status, codeHash: appointmentChangeVerifications.codeHash, expiresAt: appointmentChangeVerifications.expiresAt, attemptCount: appointmentChangeVerifications.attemptCount }).from(appointmentChangeVerifications).where(and(eq(appointmentChangeVerifications.id, input.verificationId), eq(appointmentChangeVerifications.businessId, input.businessId))).limit(1).for("update"))[0];
    if (!current) return { ok: false, status: "missing", verificationId: input.verificationId, reason: "The verification session was not found." };
    const now = new Date();
    if (current.expiresAt <= now || ["expired", "superseded", "used"].includes(current.status)) {
      await tx.update(appointmentChangeVerifications).set({ status: "expired", updatedAt: now }).where(eq(appointmentChangeVerifications.id, current.id));
      await auditAppointmentChange(tx, { businessId: input.businessId, appointmentId: current.appointmentId, verificationId: current.id, eventType: "appointment_change.verification_expired" });
      return { ok: false, status: "expired", verificationId: current.id, reason: "The verification session has expired." };
    }
    if (current.attemptCount >= OTP_MAX_ATTEMPTS) return { ok: false, status: "failed", verificationId: current.id, reason: "Too many verification attempts." };
    if (current.status === "otp_verified") {
      const summary = await verifiedAppointmentSummary(tx, input.businessId, current.appointmentId);
      return { ok: true, status: "otp_verified", verificationId: current.id, ...(summary ? { appointment: summary } : {}) };
    }
    if (current.status === "otp_pending" || current.status === "otp_queued" || current.status === "otp_sending" || current.status === "failed" || !current.codeHash) return { ok: false, status: current.status, verificationId: current.id, reason: "A verification code has not been sent yet." };
    if (!matchesOtp(current.codeHash, input.code.trim())) {
      const attemptCount = current.attemptCount + 1;
      await tx.update(appointmentChangeVerifications).set({ attemptCount, status: attemptCount >= OTP_MAX_ATTEMPTS ? "failed" : "otp_sent", updatedAt: now }).where(eq(appointmentChangeVerifications.id, current.id));
      await auditAppointmentChange(tx, { businessId: input.businessId, appointmentId: current.appointmentId, verificationId: current.id, eventType: attemptCount >= OTP_MAX_ATTEMPTS ? "appointment_change.otp_locked" : "appointment_change.otp_rejected", payload: { attemptCount } });
      return { ok: false, status: attemptCount >= OTP_MAX_ATTEMPTS ? "failed" : "otp_sent", verificationId: current.id, reason: "The verification code is invalid." };
    }
    await tx.update(appointmentChangeVerifications).set({ status: "otp_verified", attemptCount: current.attemptCount + 1, updatedAt: now }).where(eq(appointmentChangeVerifications.id, current.id));
    await auditAppointmentChange(tx, { businessId: input.businessId, appointmentId: current.appointmentId, verificationId: current.id, eventType: "appointment_change.otp_verified" });
    const summary = await verifiedAppointmentSummary(tx, input.businessId, current.appointmentId);
    return { ok: true, status: "otp_verified", verificationId: current.id, ...(summary ? { appointment: summary } : {}) };
  });
}

export async function consumeAppointmentChangeVerification(
  context: DomainContext,
  input: { businessId: string; verificationId: string; appointmentId: string; callerPhone: string; action: "cancel" | "reschedule" },
): Promise<boolean> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => await consumeAppointmentChangeVerificationInTransaction(tx, input));
}

export async function consumeAppointmentChangeVerificationInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; verificationId: string; appointmentId: string; callerPhone: string; action: "cancel" | "reschedule" },
): Promise<boolean> {
  const profile = (await tx.select({ policy: receptionistProfiles.appointmentChangePolicy }).from(receptionistProfiles).where(eq(receptionistProfiles.businessId, input.businessId)).limit(1).for("share"))[0];
  const policy = normalizeAppointmentChangePolicy(profile?.policy);
  if (!policy.enabled || policy.verificationMode === "operator_only" || (input.action === "cancel" ? !policy.allowCancel : !policy.allowReschedule)) return false;
  const rows = await tx.update(appointmentChangeVerifications).set({ status: "used", updatedAt: new Date() }).where(and(eq(appointmentChangeVerifications.id, input.verificationId), eq(appointmentChangeVerifications.businessId, input.businessId), eq(appointmentChangeVerifications.appointmentId, input.appointmentId), eq(appointmentChangeVerifications.callerPhone, input.callerPhone), eq(appointmentChangeVerifications.action, input.action), inArray(appointmentChangeVerifications.status, policy.verificationMode === "otp_required" ? ["otp_verified"] : ["facts_verified", "otp_verified"]), gt(appointmentChangeVerifications.expiresAt, new Date()))).returning({ id: appointmentChangeVerifications.id });
  if (rows.length > 0) await auditAppointmentChange(tx, { businessId: input.businessId, appointmentId: input.appointmentId, verificationId: input.verificationId, eventType: "appointment_change.verification_consumed", payload: { action: input.action } });
  return rows.length > 0;
}
