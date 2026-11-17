import { randomUUID } from "node:crypto";
import { and, count, eq, gt, isNotNull, or } from "drizzle-orm";
import { NextResponse } from "next/server";

import { appointments, billingAccounts, businesses, enqueueOutbox, phoneNumbers } from "@lobbystack/db";
import { assignCalendarStaff, discoverCalendars, disconnectCalendar, listCalendarConnections, listCalendarStaff, refreshCalendar, resolveCalendarAccessToken, selectCalendar } from "@lobbystack/domain";
import { GoogleCalendarProvider, SecretBox } from "@lobbystack/providers";
import { asApiResponse, businessIdFromRequest, readJson, requireApiSession, withOperatorTransaction } from "@/lib/api-helpers";
import { createDomainContext, createWorkerDomainContext } from "@/lib/domain-context";

export const dynamic = "force-dynamic";

async function calendarDiscovery(userId: string, businessId: string, connectionId: string) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!clientId || !clientSecret || !redirectUri || !encryptionKey) throw new Error("Google Calendar discovery is not configured.");
  const provider = new GoogleCalendarProvider({ clientId, clientSecret, redirectUri });
  const box = new SecretBox(encryptionKey);
  return await discoverCalendars(createDomainContext(), {
    userId, businessId, connectionId,
    decryptAccessToken: (value) => box.decrypt(value),
    resolveAccessToken: (id) => resolveCalendarAccessToken(createWorkerDomainContext(), { businessId, connectionId: id, decryptToken: (value) => box.decrypt(value), encryptToken: (value) => box.encrypt(value), refreshAccessToken: (input) => provider.refreshAccessToken(input) }),
    listCalendars: (input) => provider.listCalendars(input),
  });
}

export async function GET(request: Request) {
  try {
    const session = await requireApiSession(request);
    const { businessId, billing, phones, calendarShareServiceAddress } = await withOperatorTransaction(request, async ({ businessId, tx }) => {
      const billing = await tx.select({ plan: billingAccounts.plan, state: billingAccounts.subscriptionState, updatedAt: billingAccounts.updatedAt }).from(billingAccounts).where(eq(billingAccounts.businessId, businessId)).limit(1);
      const phones = await tx.select({ count: count() }).from(phoneNumbers).where(and(eq(phoneNumbers.businessId, businessId), eq(phoneNumbers.status, "active")));
      const [business] = await tx.select({ calendarShareServiceAddress: businesses.calendarShareServiceAddress }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
      return { businessId, billing, phones, calendarShareServiceAddress: business?.calendarShareServiceAddress === true };
    }, { minimumRole: "business_admin", pilotCapability: "integrations" });
      const [calendar, staffRows] = await Promise.all([
        listCalendarConnections(createDomainContext(), { userId: session.user.id, businessId }),
        listCalendarStaff(createDomainContext(), { userId: session.user.id, businessId }),
      ]);
      const googleConnection = calendar.find((connection) => connection.provider === "google");
      let calendarOptions: Array<{ id: string; summary: string; primary: boolean; accessRole?: string; selected: boolean }> = [];
      let discoveryError: string | null = null;
      if (googleConnection) {
        try {
          calendarOptions = await calendarDiscovery(session.user.id, businessId, googleConnection.id);
        } catch (error) {
          discoveryError = error instanceof Error ? error.message : "Calendar discovery failed.";
        }
      }
      return NextResponse.json({
        calendarConnections: calendar.map((connection) => ({
          ...connection,
          selectedCalendarSummary: calendarOptions.find((option) => option.id === connection.selectedCalendarId)?.summary ?? null,
        })),
        staff: staffRows,
        calendarOptions,
        calendarShareServiceAddress,
        discoveryError,
        integrations: [
          ...(calendar[0] ? [{ name: calendar[0].provider === "google" ? "Google Calendar" : calendar[0].provider, account: calendar[0].externalAccountId, status: calendar[0].status, updatedAt: calendar[0].updatedAt, connectionId: calendar[0].id, staffId: calendar[0].staffId, selectedCalendarId: calendar[0].selectedCalendarId, lastSyncError: calendar[0].lastSyncError, calendarOptions, discoveryError }] : [{ name: "Google Calendar", account: "Not connected", status: "disconnected", updatedAt: null, connectionId: null, staffId: null, selectedCalendarId: null, lastSyncError: null, calendarOptions: [], discoveryError: null }]),
          { name: "Twilio", account: `${Number(phones[0]?.count ?? 0)} active phone number${Number(phones[0]?.count ?? 0) === 1 ? "" : "s"}`, status: Number(phones[0]?.count ?? 0) > 0 ? "connected" : "disconnected", updatedAt: null },
          { name: "Polar billing", account: billing[0]?.plan ?? "Not configured", status: billing[0]?.state ?? "disconnected", updatedAt: billing[0]?.updatedAt ?? null },
        ],
      });
  } catch (error) {
    return asApiResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await requireApiSession(request);
    const businessId = businessIdFromRequest(request);
    const body = await readJson(request) as { connectionId?: string; calendarId?: string; staffId?: string | null; shareServiceAddress?: boolean };
    if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "A calendar update is required." }, { status: 400 });
    if (typeof body.shareServiceAddress === "boolean") {
      if (!businessId || body.connectionId !== undefined || body.calendarId !== undefined || body.staffId !== undefined) return NextResponse.json({ error: "Only calendar address sharing may be changed in this request." }, { status: 400 });
      await withOperatorTransaction(request, async ({ businessId: authorizedBusinessId, tx }) => {
        const [current] = await tx.select({ enabled: businesses.calendarShareServiceAddress }).from(businesses).where(eq(businesses.id, authorizedBusinessId)).limit(1);
        if (!current || current.enabled === body.shareServiceAddress) return;
        await tx.update(businesses).set({ calendarShareServiceAddress: body.shareServiceAddress!, updatedAt: new Date() }).where(eq(businesses.id, authorizedBusinessId));
        const pending = await tx.select({ id: appointments.id }).from(appointments).where(and(eq(appointments.businessId, authorizedBusinessId), eq(appointments.status, "confirmed"), gt(appointments.endsAt, new Date()), or(isNotNull(appointments.calendarExternalId), isNotNull(appointments.serviceLocation))));
        const changeId = randomUUID();
        for (const appointment of pending) await enqueueOutbox(tx, { topic: "calendar.syncAppointment", businessId: authorizedBusinessId, aggregateType: "appointment", aggregateId: appointment.id, dedupeKey: `appointment:${appointment.id}:calendar:sharing:${changeId}`, payload: { appointmentId: appointment.id, action: "sharing_changed" } });
      }, { minimumRole: "business_admin", pilotCapability: "integrations" });
      return NextResponse.json({ ok: true });
    }
    if (!businessId || !body.connectionId || (!body.calendarId && body.staffId === undefined)) return NextResponse.json({ error: "businessId, connectionId, and calendarId or staffId are required." }, { status: 400 });
    await withOperatorTransaction(request, async () => undefined, { minimumRole: "business_admin", pilotCapability: "integrations" });
    if (body.calendarId) {
      const options = await calendarDiscovery(session.user.id, businessId, body.connectionId);
      const selected = options.find((option) => option.id === body.calendarId?.trim());
      if (!selected || !["owner", "writer"].includes(selected.accessRole ?? "")) return NextResponse.json({ error: "Select a calendar you can write to." }, { status: 400 });
      await selectCalendar(createDomainContext(), { userId: session.user.id, businessId, connectionId: body.connectionId, calendarId: selected.id });
    }
    if (body.staffId !== undefined) await assignCalendarStaff(createDomainContext(), { userId: session.user.id, businessId, connectionId: body.connectionId, staffId: body.staffId });
    return NextResponse.json({ ok: true });
  } catch (error) { return asApiResponse(error); }
}

export async function POST(request: Request) {
  try {
    const session = await requireApiSession(request);
    const businessId = businessIdFromRequest(request);
    const body = await readJson(request) as { connectionId?: string };
    if (!businessId || !body.connectionId) return NextResponse.json({ error: "businessId and connectionId are required." }, { status: 400 });
    await withOperatorTransaction(request, async () => undefined, { minimumRole: "business_admin", pilotCapability: "integrations" });
    await refreshCalendar(createDomainContext(), { userId: session.user.id, businessId, connectionId: body.connectionId });
    return NextResponse.json({ ok: true });
  } catch (error) { return asApiResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    const session = await requireApiSession(request);
    const businessId = businessIdFromRequest(request);
    const connectionId = new URL(request.url).searchParams.get("connectionId");
    if (!businessId || !connectionId) return NextResponse.json({ error: "businessId and connectionId are required." }, { status: 400 });
    await withOperatorTransaction(request, async () => undefined, { minimumRole: "business_admin", pilotCapability: "integrations" });
    await disconnectCalendar(createDomainContext(), { userId: session.user.id, businessId, connectionId });
    return NextResponse.json({ ok: true });
  } catch (error) { return asApiResponse(error); }
}
