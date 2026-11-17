import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { appointments, contacts, enqueueOutbox, receptionistProfiles, services } from "@lobbystack/db";
import type { ServiceAddress } from "@lobbystack/shared";
import { effectiveServiceIntakePolicy, validateServiceIntake } from "@lobbystack/domain";
import { asApiResponse, jsonError, readJson, withOperatorTransaction } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ appointmentId: string }> }) {
  try {
    const { appointmentId } = await params;
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw jsonError("An appointment location is required.");
    const rawLocation = (body as Record<string, unknown>).serviceLocation;
    if (!rawLocation || typeof rawLocation !== "object" || Array.isArray(rawLocation)) throw jsonError("A structured service location is required.");
    const location = rawLocation as ServiceAddress;
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => {
      const [appointment] = await tx.select({ serviceId: appointments.serviceId, status: appointments.status, endsAt: appointments.endsAt, intakeAnswers: appointments.intakeAnswers, contactName: contacts.name, contactPhone: contacts.phone }).from(appointments).leftJoin(contacts, and(eq(contacts.id, appointments.contactId), eq(contacts.businessId, businessId))).where(and(eq(appointments.id, appointmentId), eq(appointments.businessId, businessId))).limit(1);
      if (!appointment) throw jsonError("Appointment not found.", 404);
      const [[service], [profile]] = await Promise.all([
        tx.select({ intakePolicy: services.intakePolicy }).from(services).where(and(eq(services.id, appointment.serviceId), eq(services.businessId, businessId))).limit(1),
        tx.select({ intakePolicy: receptionistProfiles.intakePolicy }).from(receptionistProfiles).where(eq(receptionistProfiles.businessId, businessId)).limit(1),
      ]);
      const policy = effectiveServiceIntakePolicy(profile?.intakePolicy, service?.intakePolicy);
      const checked = validateServiceIntake(policy, { serviceLocation: location, answers: { ...(appointment.intakeAnswers ?? {}), ...(appointment.contactName ? { customerName: appointment.contactName } : {}), ...(appointment.contactPhone ? { callbackPhone: appointment.contactPhone } : {}) } });
      if (!checked.ok || !checked.serviceLocation) throw jsonError(!checked.ok && checked.reason === "outside_service_area" ? "The service location is outside the configured service area." : "The service location is incomplete or invalid.", 400, !checked.ok ? checked.reason : "invalid_service_address");
      const [updated] = await tx.update(appointments).set({ serviceLocation: checked.serviceLocation as unknown as Record<string, unknown>, intakeCompletionStatus: checked.required ? "complete" : "not_required", revision: sql`${appointments.revision} + 1`, updatedAt: new Date() }).where(and(eq(appointments.id, appointmentId), eq(appointments.businessId, businessId))).returning({ revision: appointments.revision });
      if (!updated) throw jsonError("Appointment not found.", 404);
      await enqueueOutbox(tx, { topic: "realtime.publish", businessId, aggregateType: "appointment", aggregateId: appointmentId, dedupeKey: `appointment:${appointmentId}:location:${Date.now()}`, payload: { type: "appointment.updated", entityId: appointmentId, revision: updated.revision } });
      if (appointment.status === "confirmed" && appointment.endsAt > new Date()) await enqueueOutbox(tx, { topic: "calendar.syncAppointment", businessId, aggregateType: "appointment", aggregateId: appointmentId, dedupeKey: `appointment:${appointmentId}:calendar:location:${updated.revision}`, payload: { appointmentId, action: "location_corrected" } });
      return { ok: true };
    }, { minimumRole: "scheduler", pilotCapability: "voice" }));
  } catch (error) { return asApiResponse(error); }
}
