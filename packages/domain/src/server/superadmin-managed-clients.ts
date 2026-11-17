import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, gt, ne, sql } from "drizzle-orm";

import { lmcBusinessSettingsSchema, superAdminClientDraftSchema, type SuperAdminClientDraft } from "@lobbystack/contracts";
import {
  businessHours, businessInvitations, businesses, calendarConnections, enqueueOutbox,
  lmcSettings, lmcTenantDrafts, platformAdminAuditEvents, platformAdminOperations, receptionistProfiles,
  services, staff, staffServiceAssignments, withBusinessTransaction, type Database,
} from "@lobbystack/db";
import { defaultAppointmentChangePolicy } from "@lobbystack/shared";
import { requirePlatformAdmin } from "../authz";
import { createReplyToken } from "./lmc/capabilities";

type Context = { db: Database; now?: () => Date };
type OperationResponse = Record<string, unknown>;

function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function previousOperation(tx: Parameters<Parameters<Database["transaction"]>[0]>[0], input: { actorUserId: string; action: string; idempotencyKey: string; hash: string }) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.actorUserId}:${input.action}:${input.idempotencyKey}`}, 0))`);
  const [existing] = await tx.select({ requestHash: platformAdminOperations.requestHash, response: platformAdminOperations.response }).from(platformAdminOperations)
    .where(and(eq(platformAdminOperations.actorUserId, input.actorUserId), eq(platformAdminOperations.action, input.action), eq(platformAdminOperations.idempotencyKey, input.idempotencyKey))).limit(1);
  if (existing && existing.requestHash !== input.hash) throw Object.assign(new Error("IDEMPOTENCY_KEY_REUSED"), { status: 409, code: "idempotency_conflict" });
  return existing?.response;
}

async function recordOperation(tx: Parameters<Parameters<Database["transaction"]>[0]>[0], input: { actorUserId: string; action: string; idempotencyKey: string; hash: string; response: OperationResponse }) {
  await tx.insert(platformAdminOperations).values({ actorUserId: input.actorUserId, action: input.action, idempotencyKey: input.idempotencyKey, requestHash: input.hash, response: input.response });
}

async function audit(tx: Parameters<Parameters<Database["transaction"]>[0]>[0], input: { actorUserId: string; action: string; tenantId: string; changes: Record<string, unknown>; requestId: string }) {
  await tx.insert(platformAdminAuditEvents).values({ actorUserId: input.actorUserId, action: input.action, targetType: "business", targetId: input.tenantId, changes: input.changes, requestId: input.requestId });
}

export async function provisionManagedLmcClient(context: Context, input: { actorUserId: string; idempotencyKey: string; requestId: string; draft: unknown }) {
  const draft = superAdminClientDraftSchema.parse(input.draft);
  const hash = requestHash(draft);
  const tenantId = randomUUID();
  return await withBusinessTransaction(context.db, { actorType: "system", userId: input.actorUserId, businessId: tenantId }, async (tx) => {
    await requirePlatformAdmin(tx, input.actorUserId);
    const previous = await previousOperation(tx, { actorUserId: input.actorUserId, action: "client.create", idempotencyKey: input.idempotencyKey, hash });
    if (previous) return { ...(previous as { tenantId: string; revision: number }), created: false };
    const now = context.now?.() ?? new Date();
    await tx.insert(businesses).values({ id: tenantId, name: draft.name, slug: draft.slug, timezone: draft.timezone, businessType: draft.businessType, status: "draft", onboardingStage: "managed_draft", deploymentMode: "cloud", createdAt: now, updatedAt: now });
    await tx.insert(staff).values({ businessId: tenantId, name: draft.name, timezone: draft.timezone, active: true, createdAt: now, updatedAt: now });
    await tx.insert(receptionistProfiles).values({ businessId: tenantId, greeting: `Thanks for calling ${draft.name}.`, tone: "warm and direct", summary: `${draft.name} uses Kyra to respond to service requests.`, bookingPolicy: "Only confirm a booking after availability is checked.", voiceInstructions: "Sound calm, confident, and concise. Escalate urgent requests when policy requires it.", smsInstructions: "Keep replies concise and friendly.", transferMode: "on_request", appointmentChangePolicy: defaultAppointmentChangePolicy, createdAt: now, updatedAt: now });
    await tx.insert(lmcTenantDrafts).values({ tenantId, ownerEmail: draft.ownerEmail, draft, revision: 1, createdByUserId: input.actorUserId, updatedByUserId: input.actorUserId, createdAt: now, updatedAt: now });
    await enqueueOutbox(tx, { topic: "snapshot.refresh", businessId: tenantId, aggregateType: "business", aggregateId: tenantId, dedupeKey: `business:${tenantId}:snapshot:draft`, payload: { businessId: tenantId, reason: "managed_draft_created" } });
    await audit(tx, { actorUserId: input.actorUserId, action: "client.create", tenantId, changes: { lifecycle: "draft", ownerEmailChanged: true }, requestId: input.requestId });
    const response = { tenantId, revision: 1, created: true };
    await recordOperation(tx, { actorUserId: input.actorUserId, action: "client.create", idempotencyKey: input.idempotencyKey, hash, response });
    return response;
  });
}

export async function readManagedLmcDraft(context: Context, input: { actorUserId: string; tenantId: string }) {
  return await withBusinessTransaction(context.db, { actorType: "system", userId: input.actorUserId, businessId: input.tenantId }, async (tx) => {
    await requirePlatformAdmin(tx, input.actorUserId);
    const [row] = await tx.select({ draft: lmcTenantDrafts.draft, revision: lmcTenantDrafts.revision, updatedAt: lmcTenantDrafts.updatedAt }).from(lmcTenantDrafts).where(eq(lmcTenantDrafts.tenantId, input.tenantId)).limit(1);
    if (!row) throw Object.assign(new Error("CLIENT_DRAFT_NOT_FOUND"), { status: 404, code: "not_found" });
    return { tenantId: input.tenantId, draft: superAdminClientDraftSchema.parse(row.draft), revision: row.revision, updatedAt: row.updatedAt };
  });
}

export async function updateManagedLmcDraft(context: Context, input: { actorUserId: string; tenantId: string; expectedRevision: number; requestId: string; draft: unknown }) {
  const draft = superAdminClientDraftSchema.parse(input.draft);
  return await withBusinessTransaction(context.db, { actorType: "system", userId: input.actorUserId, businessId: input.tenantId }, async (tx) => {
    await requirePlatformAdmin(tx, input.actorUserId);
    const [current] = await tx.select({ revision: lmcTenantDrafts.revision, draft: lmcTenantDrafts.draft }).from(lmcTenantDrafts).where(eq(lmcTenantDrafts.tenantId, input.tenantId)).limit(1).for("update");
    if (!current) throw Object.assign(new Error("CLIENT_DRAFT_NOT_FOUND"), { status: 404, code: "not_found" });
    if (current.revision !== input.expectedRevision) throw Object.assign(new Error("CLIENT_DRAFT_CHANGED"), { status: 409, code: "revision_conflict" });
    const now = context.now?.() ?? new Date();
    const revision = current.revision + 1;
    await tx.update(lmcTenantDrafts).set({ ownerEmail: draft.ownerEmail, draft, revision, updatedByUserId: input.actorUserId, updatedAt: now }).where(eq(lmcTenantDrafts.tenantId, input.tenantId));
    await tx.update(businesses).set({ name: draft.name, slug: draft.slug, timezone: draft.timezone, businessType: draft.businessType, updatedAt: now }).where(eq(businesses.id, input.tenantId));
    const old = superAdminClientDraftSchema.parse(current.draft);
    const changedFields = (["name", "slug", "timezone", "businessType", "ownerEmail", "hours", "settings"] as const).filter((key) => JSON.stringify(old[key]) !== JSON.stringify(draft[key]));
    await audit(tx, { actorUserId: input.actorUserId, action: "client.draft.update", tenantId: input.tenantId, changes: { revision, changedFields }, requestId: input.requestId });
    return { tenantId: input.tenantId, revision, changed: changedFields.length > 0 };
  });
}

export async function inviteManagedLmcOwner(context: Context, input: { actorUserId: string; tenantId: string; idempotencyKey: string; requestId: string; appBaseUrl: string }) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const hash = requestHash({ tenantId: input.tenantId });
  return await withBusinessTransaction(context.db, { actorType: "system", userId: input.actorUserId, businessId: input.tenantId }, async (tx) => {
    await requirePlatformAdmin(tx, input.actorUserId);
    const previous = await previousOperation(tx, { actorUserId: input.actorUserId, action: `client.invite:${input.tenantId}`, idempotencyKey: input.idempotencyKey, hash });
    if (previous) return { ...(previous as { tenantId: string; invitationId: string }), created: false };
    const [draft] = await tx.select({ ownerEmail: lmcTenantDrafts.ownerEmail }).from(lmcTenantDrafts).where(eq(lmcTenantDrafts.tenantId, input.tenantId)).limit(1);
    if (!draft) throw Object.assign(new Error("CLIENT_DRAFT_NOT_FOUND"), { status: 404, code: "not_found" });
    const now = context.now?.() ?? new Date();
    const [pending] = await tx.select({ id: businessInvitations.id }).from(businessInvitations).where(and(eq(businessInvitations.businessId, input.tenantId), eq(businessInvitations.normalizedEmail, draft.ownerEmail), eq(businessInvitations.role, "business_owner"), eq(businessInvitations.status, "pending"), gt(businessInvitations.expiresAt, now))).limit(1);
    if (pending) {
      const response = { tenantId: input.tenantId, invitationId: pending.id, created: false };
      await recordOperation(tx, { actorUserId: input.actorUserId, action: `client.invite:${input.tenantId}`, idempotencyKey: input.idempotencyKey, hash, response });
      return response;
    }
    const invitationId = randomUUID();
    await tx.insert(businessInvitations).values({ id: invitationId, businessId: input.tenantId, invitedByUserId: input.actorUserId, email: draft.ownerEmail, normalizedEmail: draft.ownerEmail, role: "business_owner", tokenHash, status: "pending", expiresAt: new Date(now.getTime() + 7 * 86_400_000) });
    const url = new URL("/accept-invite", input.appBaseUrl); url.searchParams.set("token", token);
    await enqueueOutbox(tx, { topic: "email.send", businessId: input.tenantId, aggregateType: "business_invitation", aggregateId: invitationId, dedupeKey: `managed-invitation:${invitationId}:send`, payload: { invitationId, email: draft.ownerEmail, token, template: "invitation", url: url.href } });
    await audit(tx, { actorUserId: input.actorUserId, action: "client.invite", tenantId: input.tenantId, changes: { invitationId, role: "business_owner" }, requestId: input.requestId });
    const response = { tenantId: input.tenantId, invitationId, created: true };
    await recordOperation(tx, { actorUserId: input.actorUserId, action: `client.invite:${input.tenantId}`, idempotencyKey: input.idempotencyKey, hash, response });
    return response;
  });
}

export type ManagedClientReadiness = {
  tenantId: string;
  voiceEnabled: boolean;
  status: string;
  onboardingStage: string;
  checks: {
    draft: boolean;
    verifiedOwner: boolean;
    calendarAuthorized: boolean;
    calendarSelected: boolean;
    calendarFresh: boolean;
    senderConfigured: boolean;
  };
  calendar: { status: string; account: string; selected: boolean; lastSyncedAt: Date | null; error: string | null } | null;
  canActivate: boolean;
};

type ActivationEnvironment = { senderEmail: string; emailProviderReady: boolean };

async function readinessInTransaction(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  input: { tenantId: string; environment: ActivationEnvironment; lock?: boolean },
): Promise<ManagedClientReadiness & { draft: SuperAdminClientDraft | null; ownerUserId: string | null; connectionId: string | null }> {
  const businessQuery = tx.select({ status: businesses.status, onboardingStage: businesses.onboardingStage, voiceEnabled: businesses.lmcVoiceEnabled }).from(businesses).where(eq(businesses.id, input.tenantId)).limit(1);
  const draftQuery = tx.select({ draft: lmcTenantDrafts.draft, ownerEmail: lmcTenantDrafts.ownerEmail }).from(lmcTenantDrafts).where(eq(lmcTenantDrafts.tenantId, input.tenantId)).limit(1);
  const [business] = input.lock ? await businessQuery.for("update") : await businessQuery;
  const [storedDraft] = input.lock ? await draftQuery.for("update") : await draftQuery;
  if (!business || !storedDraft) throw Object.assign(new Error("CLIENT_DRAFT_NOT_FOUND"), { status: 404, code: "not_found" });
  const parsedDraft = superAdminClientDraftSchema.safeParse(storedDraft.draft);
  const ownerResult = await tx.execute<{ user_id: string; email_verified: boolean }>(sql`select user_id,email_verified from app.superadmin_managed_owner(${input.tenantId}::uuid)`);
  const owner = ownerResult.rows[0] ? { userId: ownerResult.rows[0].user_id, verified: ownerResult.rows[0].email_verified } : undefined;
  const [calendar] = owner ? await tx.select({ id: calendarConnections.id, ownerUserId: calendarConnections.ownerUserId, account: calendarConnections.externalAccountId, selectedCalendarId: calendarConnections.selectedCalendarId, status: calendarConnections.status, hasCredentials: sql<boolean>`${calendarConnections.encryptedAccessToken} is not null`, lastSyncedAt: calendarConnections.lastSyncedAt, error: calendarConnections.lastSyncError }).from(calendarConnections)
    .where(and(eq(calendarConnections.businessId, input.tenantId), eq(calendarConnections.ownerUserId, owner.userId), eq(calendarConnections.provider, "google"), ne(calendarConnections.status, "disconnected"))).orderBy(asc(calendarConnections.createdAt)).limit(1) : [];
  const calendarAuthorized = Boolean(calendar?.hasCredentials && calendar.ownerUserId === owner?.userId);
  const calendarSelected = calendarAuthorized && Boolean(calendar?.selectedCalendarId);
  const calendarFresh = calendarSelected && calendar?.status === "connected" && Boolean(calendar.lastSyncedAt && Date.now() - calendar.lastSyncedAt.getTime() <= 24 * 60 * 60 * 1000);
  const checks = {
    draft: parsedDraft.success,
    verifiedOwner: Boolean(owner?.verified),
    calendarAuthorized,
    calendarSelected,
    calendarFresh,
    senderConfigured: Boolean(parsedDraft.success && input.environment.emailProviderReady && parsedDraft.data.settings.fromEmail.toLowerCase() === input.environment.senderEmail.toLowerCase()),
  };
  return {
    tenantId: input.tenantId,
    voiceEnabled: business.voiceEnabled,
    status: business.status,
    onboardingStage: business.onboardingStage,
    checks,
    calendar: calendar ? { status: calendar.status, account: calendar.account, selected: Boolean(calendar.selectedCalendarId), lastSyncedAt: calendar.lastSyncedAt, error: calendar.error ? "Calendar synchronization failed." : null } : null,
    canActivate: Object.values(checks).every(Boolean),
    draft: parsedDraft.success ? parsedDraft.data : null,
    ownerUserId: owner?.userId ?? null,
    connectionId: calendar?.id ?? null,
  };
}

export async function setManagedLmcVoiceEnabled(context: Context, input: { actorUserId: string; tenantId: string; enabled: boolean; requestId: string }) {
  return await withBusinessTransaction(context.db, { actorType: "system", userId: input.actorUserId, businessId: input.tenantId }, async (tx) => {
    await requirePlatformAdmin(tx, input.actorUserId);
    const [setting] = await tx.select({ voiceEnabled: businesses.lmcVoiceEnabled }).from(businesses).where(eq(businesses.id, input.tenantId)).limit(1).for("update");
    if (!setting) throw Object.assign(new Error("CLIENT_SETTINGS_NOT_FOUND"), { status: 404, code: "not_found" });
    if (setting.voiceEnabled !== input.enabled) {
      await tx.update(businesses).set({ lmcVoiceEnabled: input.enabled, updatedAt: context.now?.() ?? new Date() }).where(eq(businesses.id, input.tenantId));
      await audit(tx, { actorUserId: input.actorUserId, action: "client.voice_enabled", tenantId: input.tenantId, changes: { enabled: input.enabled }, requestId: input.requestId });
    }
    return { tenantId: input.tenantId, voiceEnabled: input.enabled };
  });
}

export async function readManagedClientReadiness(context: Context, input: { actorUserId: string; tenantId: string; environment: ActivationEnvironment }): Promise<ManagedClientReadiness> {
  return await withBusinessTransaction(context.db, { actorType: "system", userId: input.actorUserId, businessId: input.tenantId }, async (tx) => {
    await requirePlatformAdmin(tx, input.actorUserId);
    const { draft: _draft, ownerUserId: _owner, connectionId: _connection, ...result } = await readinessInTransaction(tx, input);
    return result;
  });
}

export async function activateManagedLmcClient(context: Context, input: { actorUserId: string; tenantId: string; idempotencyKey: string; requestId: string; environment: ActivationEnvironment }) {
  const hash = requestHash({ tenantId: input.tenantId, senderEmail: input.environment.senderEmail });
  return await withBusinessTransaction(context.db, { actorType: "system", userId: input.actorUserId, businessId: input.tenantId }, async (tx) => {
    await requirePlatformAdmin(tx, input.actorUserId);
    const previous = await previousOperation(tx, { actorUserId: input.actorUserId, action: `client.activate:${input.tenantId}`, idempotencyKey: input.idempotencyKey, hash });
    if (previous) return { ...(previous as { tenantId: string; activated: boolean }), repeated: true };
    const readiness = await readinessInTransaction(tx, { ...input, lock: true });
    if (!readiness.canActivate || !readiness.draft || !readiness.ownerUserId || !readiness.connectionId) {
      const missing = Object.entries(readiness.checks).filter(([, ready]) => !ready).map(([key]) => key);
      throw Object.assign(new Error(`CLIENT_NOT_READY:${missing.join(",")}`), { status: 409, code: "client_not_ready" });
    }
    const now = context.now?.() ?? new Date();
    const [defaultStaff] = await tx.select({ id: staff.id }).from(staff).where(and(eq(staff.businessId, input.tenantId), eq(staff.active, true))).orderBy(asc(staff.createdAt)).limit(1);
    if (!defaultStaff) throw Object.assign(new Error("CLIENT_STAFF_REQUIRED"), { status: 409, code: "client_not_ready" });
    const configuredServices: Array<{ id: string; name: string; aliases: string[] }> = [];
    for (const service of readiness.draft.settings.services) {
      const [saved] = await tx.insert(services).values({ businessId: input.tenantId, name: service.name, slug: service.slug, durationMinutes: service.durationMinutes, active: true, createdAt: now, updatedAt: now }).onConflictDoUpdate({ target: [services.businessId, services.slug], set: { name: service.name, durationMinutes: service.durationMinutes, active: true, updatedAt: now } }).returning({ id: services.id });
      await tx.insert(staffServiceAssignments).values({ businessId: input.tenantId, staffId: defaultStaff.id, serviceId: saved!.id }).onConflictDoNothing();
      configuredServices.push({ id: saved!.id, name: service.name, aliases: service.aliases });
    }
    await tx.delete(businessHours).where(eq(businessHours.businessId, input.tenantId));
    if (readiness.draft.hours.length) await tx.insert(businessHours).values(readiness.draft.hours.map((hours) => ({ ...hours, businessId: input.tenantId, createdAt: now, updatedAt: now })));
    const config = lmcBusinessSettingsSchema.parse({ ...readiness.draft.settings, services: configuredServices, fromEmail: input.environment.senderEmail });
    const [current] = await tx.select({ tenantId: lmcSettings.tenantId }).from(lmcSettings).where(eq(lmcSettings.tenantId, input.tenantId)).limit(1).for("update");
    const capture = current ? null : createReplyToken(input.tenantId);
    if (current) await tx.update(lmcSettings).set({ config, enabled: true, updatedAt: now }).where(eq(lmcSettings.tenantId, input.tenantId));
    else await tx.insert(lmcSettings).values({ tenantId: input.tenantId, config, enabled: true, captureTokenHash: capture!.hash, createdAt: now, updatedAt: now });
    await tx.update(calendarConnections).set({ staffId: defaultStaff.id, updatedAt: now }).where(and(eq(calendarConnections.id, readiness.connectionId), eq(calendarConnections.businessId, input.tenantId)));
    await tx.update(businesses).set({ status: "active", onboardingStage: "managed_active", updatedAt: now }).where(eq(businesses.id, input.tenantId));
    await enqueueOutbox(tx, { topic: "snapshot.refresh", businessId: input.tenantId, aggregateType: "business", aggregateId: input.tenantId, dedupeKey: `business:${input.tenantId}:snapshot:activation:${now.getTime()}`, payload: { businessId: input.tenantId, reason: "managed_client_activated" } });
    await audit(tx, { actorUserId: input.actorUserId, action: "client.activate", tenantId: input.tenantId, changes: { lifecycle: "active", ownerUserId: readiness.ownerUserId, serviceCount: configuredServices.length }, requestId: input.requestId });
    const response = { tenantId: input.tenantId, activated: true };
    // The operation record deliberately excludes the bearer capture token. The
    // database retains only its hash; a repeated request confirms activation
    // without recovering or replaying the capability.
    await recordOperation(tx, { actorUserId: input.actorUserId, action: `client.activate:${input.tenantId}`, idempotencyKey: input.idempotencyKey, hash, response });
    return { ...response, ...(capture ? { captureToken: capture.value } : {}), repeated: false };
  });
}

export async function pauseManagedLmcClient(context: Context, input: { actorUserId: string; tenantId: string; idempotencyKey: string; requestId: string }) {
  const hash = requestHash({ tenantId: input.tenantId });
  return await withBusinessTransaction(context.db, { actorType: "system", userId: input.actorUserId, businessId: input.tenantId }, async (tx) => {
    await requirePlatformAdmin(tx, input.actorUserId);
    const action = `client.pause:${input.tenantId}`;
    const previous = await previousOperation(tx, { actorUserId: input.actorUserId, action, idempotencyKey: input.idempotencyKey, hash });
    if (previous) return { ...(previous as { tenantId: string; paused: boolean; changed: boolean }), repeated: true };
    const now = context.now?.() ?? new Date();
    const [business] = await tx.select({ status: businesses.status }).from(businesses).where(eq(businesses.id, input.tenantId)).limit(1).for("update");
    if (!business) throw Object.assign(new Error("CLIENT_NOT_FOUND"), { status: 404, code: "not_found" });
    const changed = business.status !== "paused";
    if (changed) await tx.update(businesses).set({ status: "paused", updatedAt: now }).where(eq(businesses.id, input.tenantId));
    await tx.update(lmcSettings).set({ enabled: false, updatedAt: now }).where(eq(lmcSettings.tenantId, input.tenantId));
    if (changed) await audit(tx, { actorUserId: input.actorUserId, action: "client.pause", tenantId: input.tenantId, changes: { lifecycle: "paused" }, requestId: input.requestId });
    const response = { tenantId: input.tenantId, paused: true, changed };
    await recordOperation(tx, { actorUserId: input.actorUserId, action, idempotencyKey: input.idempotencyKey, hash, response });
    return { ...response, repeated: false };
  });
}
