import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { businesses, calendarConnections } from "@lobbystack/db";
import { discoverCalendars, listCalendarConnections, refreshCalendar, resolveCalendarAccessToken, selectCalendar } from "@lobbystack/domain";
import { GoogleCalendarProvider, SecretBox } from "@lobbystack/providers";
import { asApiResponse, readJson, requireOperatorBusiness, withOperatorTransaction } from "@/lib/api-helpers";
import { createDomainContext, createWorkerDomainContext } from "@/lib/domain-context";

export const dynamic = "force-dynamic";
const selectionSchema = z.object({ connectionId: z.string().uuid(), calendarId: z.string().trim().min(1).max(255) }).strict();

function googleProvider() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!clientId || !clientSecret || !redirectUri || !encryptionKey) throw Object.assign(new Error("Google Calendar is not configured."), { status: 503, code: "calendar_unconfigured" });
  return { provider: new GoogleCalendarProvider({ clientId, clientSecret, redirectUri }), box: new SecretBox(encryptionKey) };
}

async function requireManagedOwner(request: Request) {
  const { session, businessId } = await requireOperatorBusiness(request);
  await withOperatorTransaction(request, async ({ tx }) => {
    const [business] = await tx.select({ status: businesses.status, stage: businesses.onboardingStage }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
    const managedStage = business?.stage === "managed_draft" || business?.stage === "managed_active";
    if (!business || (business.status !== "draft" && business.status !== "paused") || !managedStage) throw Object.assign(new Error("Managed setup is not available."), { status: 404, code: "not_found" });
  }, { minimumRole: "business_owner" });
  return { session, businessId };
}

async function options(userId: string, businessId: string, connectionId: string) {
  const { provider, box } = googleProvider();
  return await discoverCalendars(createDomainContext(), { userId, businessId, connectionId, decryptAccessToken: (value) => box.decrypt(value), resolveAccessToken: (id) => resolveCalendarAccessToken(createWorkerDomainContext(), { businessId, connectionId: id, decryptToken: (value) => box.decrypt(value), encryptToken: (value) => box.encrypt(value), refreshAccessToken: (input) => provider.refreshAccessToken(input) }), listCalendars: (input) => provider.listCalendars(input) });
}

export async function GET(request: Request) {
  try {
    const { session, businessId } = await requireManagedOwner(request);
    const connections = await listCalendarConnections(createDomainContext(), { userId: session.user.id, businessId });
    const connection = connections.find((item) => item.provider === "google") ?? null;
    let calendars: Awaited<ReturnType<typeof options>> = [];
    let discoveryError: string | null = null;
    if (connection) try { calendars = await options(session.user.id, businessId, connection.id); } catch { discoveryError = "Calendar discovery is temporarily unavailable."; }
    return NextResponse.json({ tenantId: businessId, connection, calendars, discoveryError });
  } catch (error) { return asApiResponse(error); }
}

export async function PATCH(request: Request) {
  try {
    const { session, businessId } = await requireManagedOwner(request);
    const parsed = selectionSchema.safeParse(await readJson(request));
    if (!parsed.success) return NextResponse.json({ error: "A valid calendar selection is required." }, { status: 400 });
    await withOperatorTransaction(request, async ({ tx }) => {
      const [owned] = await tx.select({ id: calendarConnections.id }).from(calendarConnections).where(and(eq(calendarConnections.id, parsed.data.connectionId), eq(calendarConnections.businessId, businessId), eq(calendarConnections.ownerUserId, session.user.id), eq(calendarConnections.provider, "google"))).limit(1);
      if (!owned) throw Object.assign(new Error("Calendar connection not found."), { status: 404, code: "not_found" });
    }, { minimumRole: "business_owner" });
    const calendars = await options(session.user.id, businessId, parsed.data.connectionId);
    const selected = calendars.find((calendar) => calendar.id === parsed.data.calendarId && ["owner", "writer"].includes(calendar.accessRole ?? ""));
    if (!selected) return NextResponse.json({ error: "Select a calendar you can write to." }, { status: 400 });
    await selectCalendar(createDomainContext(), { userId: session.user.id, businessId, connectionId: parsed.data.connectionId, calendarId: selected.id });
    await refreshCalendar(createDomainContext(), { userId: session.user.id, businessId, connectionId: parsed.data.connectionId });
    return NextResponse.json({ ok: true });
  } catch (error) { return asApiResponse(error); }
}
