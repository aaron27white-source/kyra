import { and, asc, eq, sql } from "drizzle-orm";
import { lmcBusinessSettingsSchema, lmcEmailAddressSchema, lmcTenantSeedSchema } from "@lobbystack/contracts";
import { businesses, businessHours, calendarBusyBlocks, calendarConnections, enqueueOutbox, lmcEvents, lmcSettings, services, staff, staffServiceAssignments, users, withBusinessTransaction, type Database } from "@lobbystack/db";
import { requireBusinessMembership } from "../../authz";
import { createReplyToken } from "./capabilities";

/** Trusted operator seed: one transaction, actual App role, canonical scheduling data. */
export async function configureLmcTenant(context: { database: Database; authDatabase: Database; senderEmail: string; now: () => Date }, raw: unknown) {
  const seed = lmcTenantSeedSchema.parse(raw);
  const sender = lmcEmailAddressSchema.parse(context.senderEmail).toLowerCase();
  if (seed.settings.fromEmail.toLowerCase() !== sender) throw new Error("SENDING_IDENTITY_NOT_ALLOWED");
  // Auth owns this private column; preserve verification without granting it
  // to the App role or relying on caller-supplied verification claims.
  const [operator] = await context.authDatabase.select({ verified: users.emailVerified }).from(users).where(eq(users.id, seed.userId)).limit(1);
  if (!operator?.verified) throw new Error("TENANT_OPERATOR_NOT_VERIFIED");
  return withBusinessTransaction(context.database, { businessId: seed.tenantId, userId: seed.userId, actorType: "operator" }, async tx => {
    await requireBusinessMembership(tx, { businessId: seed.tenantId, userId: seed.userId, minimumRole: "business_admin" });
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${seed.tenantId}:lmc-settings`},0))`);
    const [business] = await tx.select({ timezone: businesses.timezone }).from(businesses).where(eq(businesses.id, seed.tenantId)).limit(1);
    if (!business) throw new Error("TENANT_NOT_AVAILABLE");
    const [member] = await tx.select({ id: staff.id }).from(staff).where(and(eq(staff.id, seed.calendar.staffId), eq(staff.businessId, seed.tenantId), eq(staff.active, true))).limit(1);
    const [connection] = await tx.select({ id: calendarConnections.id, staffId: calendarConnections.staffId, selectedCalendarId: calendarConnections.selectedCalendarId, status: calendarConnections.status, provider: calendarConnections.provider, hasCredentials: sql<boolean>`${calendarConnections.encryptedAccessToken} is not null` }).from(calendarConnections).where(and(eq(calendarConnections.id, seed.calendar.connectionId), eq(calendarConnections.businessId, seed.tenantId))).limit(1).for("update");
    if (!member || !connection || connection.provider !== "google" || connection.status === "disconnected" || !connection.hasCredentials) throw new Error("CALENDAR_NOT_AVAILABLE");
    const now = context.now();
    let changed = false;
    if (business.timezone !== seed.timezone) {
      await tx.update(businesses).set({ timezone: seed.timezone, updatedAt: now }).where(eq(businesses.id, seed.tenantId));
      changed = true;
    }
    const configuredServices: Array<{ id: string; name: string; aliases: string[] }> = [];
    for (const service of seed.settings.services) {
      const [existing] = await tx.select().from(services).where(and(eq(services.businessId, seed.tenantId), eq(services.slug, service.slug))).limit(1).for("update");
      let id = existing?.id;
      if (!existing) {
        const [inserted] = await tx.insert(services).values({ businessId: seed.tenantId, name: service.name, slug: service.slug, durationMinutes: service.durationMinutes, active: true, createdAt: now, updatedAt: now }).returning({ id: services.id });
        id = inserted!.id; changed = true;
      } else if (existing.name !== service.name || existing.durationMinutes !== service.durationMinutes || !existing.active) {
        await tx.update(services).set({ name: service.name, durationMinutes: service.durationMinutes, active: true, updatedAt: now }).where(and(eq(services.id, existing.id), eq(services.businessId, seed.tenantId)));
        changed = true;
      }
      const assigned = await tx.insert(staffServiceAssignments).values({ businessId: seed.tenantId, staffId: member.id, serviceId: id! }).onConflictDoNothing().returning({ id: staffServiceAssignments.staffId });
      if (assigned.length) changed = true;
      configuredServices.push({ id: id!, name: service.name, aliases: [...service.aliases] });
    }
    const oldHours = await tx.select({ dayOfWeek: businessHours.dayOfWeek, openMinutes: businessHours.openMinutes, closeMinutes: businessHours.closeMinutes }).from(businessHours).where(eq(businessHours.businessId, seed.tenantId)).orderBy(asc(businessHours.dayOfWeek));
    const hours = [...seed.hours].sort((a,b) => a.dayOfWeek-b.dayOfWeek);
    if (JSON.stringify(oldHours) !== JSON.stringify(hours)) {
      await tx.delete(businessHours).where(eq(businessHours.businessId, seed.tenantId));
      if (hours.length) await tx.insert(businessHours).values(hours.map(day => ({ ...day, businessId: seed.tenantId, createdAt: now, updatedAt: now })));
      changed = true;
    }
    const calendarChanged = connection.staffId !== member.id || connection.selectedCalendarId !== seed.calendar.calendarId;
    if (calendarChanged) {
      await tx.update(calendarConnections).set({ staffId: member.id, selectedCalendarId: seed.calendar.calendarId, status: "syncing", lastSyncedAt: null, syncCursor: null, lastSyncError: null, updatedAt: now }).where(and(eq(calendarConnections.id, connection.id), eq(calendarConnections.businessId, seed.tenantId)));
      await tx.delete(calendarBusyBlocks).where(and(eq(calendarBusyBlocks.businessId, seed.tenantId), eq(calendarBusyBlocks.connectionId, connection.id)));
      await enqueueOutbox(tx, { topic: "calendar.reconcileBusiness", businessId: seed.tenantId, aggregateType: "calendar_connection", aggregateId: connection.id, dedupeKey: `calendar:${connection.id}:configure:${now.getTime()}`, payload: { connectionId: connection.id } });
      changed = true;
    }
    const config = lmcBusinessSettingsSchema.parse({ ...seed.settings, services: configuredServices, fromEmail: sender });
    const [current] = await tx.select().from(lmcSettings).where(eq(lmcSettings.tenantId, seed.tenantId)).limit(1).for("update");
    const token = current ? undefined : createReplyToken(seed.tenantId);
    if (!current) {
      await tx.insert(lmcSettings).values({ tenantId: seed.tenantId, enabled: seed.enabled, config, captureTokenHash: token!.hash, createdAt: now, updatedAt: now });
      changed = true;
    } else if (current.enabled !== seed.enabled || JSON.stringify(lmcBusinessSettingsSchema.parse(current.config)) !== JSON.stringify(config)) {
      await tx.update(lmcSettings).set({ enabled: seed.enabled, config, updatedAt: now }).where(eq(lmcSettings.tenantId, seed.tenantId));
      changed = true;
    }
    if (changed) await tx.insert(lmcEvents).values({ tenantId: seed.tenantId, type: "tenant_configured", metadata: { userId: seed.userId, services: configuredServices.length, configuredDays: hours.length, calendarChanged }, createdAt: now });
    return { tenantId: seed.tenantId, changed, services: configuredServices.map(service => ({ id: service.id, name: service.name })), calendarSyncRequired: calendarChanged, ...(token ? { captureToken: token.value } : {}) };
  });
}
