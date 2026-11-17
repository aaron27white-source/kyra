import { eq } from "drizzle-orm";
import { businesses, calendarConnections } from "@lobbystack/db";
import { PILOT_ADMIN_ROUTES } from "@lobbystack/shared";
import type { HttpAuditContext } from "./isolation-http";

function policyMethods(path: string) {
  const policy = PILOT_ADMIN_ROUTES.find((entry) => entry.pattern === path);
  if (!policy) throw new Error(`PILOT_INTEGRATIONS_POLICY_MISSING:${path}`);
  return [...policy.methods].sort();
}

/** Exercises every supported Google Calendar API method through the pilot HTTP boundary. */
export async function probePilotIntegrationsContext(context: HttpAuditContext) {
  const { db, a, b, cookieA, cookieB, request, check, probed } = context;
  const path = "/api/integrations";
  const [connectionA] = await db.admin.db.select({
    id: calendarConnections.id,
    account: calendarConnections.externalAccountId,
    staffId: calendarConnections.staffId,
    status: calendarConnections.status,
  }).from(calendarConnections).where(eq(calendarConnections.businessId, a.tenantId)).limit(1);
  const [connectionB] = await db.admin.db.select({
    id: calendarConnections.id,
    account: calendarConnections.externalAccountId,
    staffId: calendarConnections.staffId,
    status: calendarConnections.status,
  }).from(calendarConnections).where(eq(calendarConnections.businessId, b.tenantId)).limit(1);
  if (!connectionA || !connectionB) throw new Error("PILOT_INTEGRATIONS_FIXTURE_CONNECTION_MISSING");

  const readA = await request(path, cookieA, a.tenantId);
  const bodyA = await readA.text();
  const readB = await request(path, cookieB, b.tenantId);
  const bodyB = await readB.text();
  check(readA.status === 200 && bodyA.includes(connectionA.account) && !bodyA.includes(connectionB.account), "PILOT_INTEGRATIONS_READ_TENANT_A");
  check(readB.status === 200 && bodyB.includes(connectionB.account) && !bodyB.includes(connectionA.account), "PILOT_INTEGRATIONS_READ_TENANT_B");
  probed.push("GET /api/integrations");

  const head = await request(path, cookieA, a.tenantId, "HEAD");
  check(head.status === 200 && await head.text() === "", `PILOT_INTEGRATIONS_HEAD:${head.status}`);
  probed.push("HEAD /api/integrations");

  const options = await request(path, cookieA, a.tenantId, "OPTIONS");
  const allow = (options.headers.get("allow") ?? "").split(/[, ]+/).filter(Boolean).sort();
  check(options.status === 204 && await options.text() === "" && JSON.stringify(allow) === JSON.stringify(policyMethods(path)), `PILOT_INTEGRATIONS_OPTIONS:${options.status}`);
  probed.push("OPTIONS /api/integrations");

  // A's authenticated owner cannot use B's tenant context to mutate a connection.
  const foreignPatch = await request(path, cookieA, b.tenantId, "PATCH", {}, { connectionId: connectionB.id, staffId: null });
  check(foreignPatch.status === 404, `PILOT_INTEGRATIONS_FOREIGN_PATCH:${foreignPatch.status}`);
  await foreignPatch.arrayBuffer();
  const patchA = await request(path, cookieA, a.tenantId, "PATCH", {}, { connectionId: connectionA.id, staffId: null });
  check(patchA.status === 200, `PILOT_INTEGRATIONS_PATCH:${patchA.status}`);
  await patchA.arrayBuffer();
  const [afterPatchA] = await db.admin.db.select({ staffId: calendarConnections.staffId }).from(calendarConnections).where(eq(calendarConnections.id, connectionA.id)).limit(1);
  const [afterPatchB] = await db.admin.db.select({ staffId: calendarConnections.staffId }).from(calendarConnections).where(eq(calendarConnections.id, connectionB.id)).limit(1);
  check(afterPatchA?.staffId === null && afterPatchB?.staffId === connectionB.staffId, "PILOT_INTEGRATIONS_PATCH_CROSSED_TENANTS");
  probed.push("PATCH /api/integrations");

  const foreignSync = await request(path, cookieA, b.tenantId, "POST", {}, { connectionId: connectionB.id });
  check(foreignSync.status === 404, `PILOT_INTEGRATIONS_FOREIGN_SYNC:${foreignSync.status}`);
  await foreignSync.arrayBuffer();
  const syncA = await request(path, cookieA, a.tenantId, "POST", {}, { connectionId: connectionA.id });
  check(syncA.status === 200, `PILOT_INTEGRATIONS_SYNC:${syncA.status}`);
  await syncA.arrayBuffer();
  const [afterSyncA] = await db.admin.db.select({ status: calendarConnections.status }).from(calendarConnections).where(eq(calendarConnections.id, connectionA.id)).limit(1);
  const [afterSyncB] = await db.admin.db.select({ status: calendarConnections.status }).from(calendarConnections).where(eq(calendarConnections.id, connectionB.id)).limit(1);
  check(afterSyncA?.status === "syncing" && afterSyncB?.status === connectionB.status, "PILOT_INTEGRATIONS_SYNC_CROSSED_TENANTS");
  probed.push("POST /api/integrations");

  const foreignDelete = await request(`${path}?connectionId=${connectionB.id}`, cookieA, b.tenantId, "DELETE");
  check(foreignDelete.status === 404, `PILOT_INTEGRATIONS_FOREIGN_DELETE:${foreignDelete.status}`);
  await foreignDelete.arrayBuffer();
  const deleteA = await request(`${path}?businessId=${a.tenantId}&connectionId=${connectionA.id}`, cookieA, a.tenantId, "DELETE");
  check(deleteA.status === 200, `PILOT_INTEGRATIONS_DELETE:${deleteA.status}`);
  await deleteA.arrayBuffer();
  const [afterDeleteA] = await db.admin.db.select({ status: calendarConnections.status }).from(calendarConnections).where(eq(calendarConnections.id, connectionA.id)).limit(1);
  const [afterDeleteB] = await db.admin.db.select({ status: calendarConnections.status }).from(calendarConnections).where(eq(calendarConnections.id, connectionB.id)).limit(1);
  check(afterDeleteA?.status === "disconnected" && afterDeleteB?.status === connectionB.status, "PILOT_INTEGRATIONS_DELETE_CROSSED_TENANTS");
  probed.push("DELETE /api/integrations");

  const share = await request(path, cookieA, a.tenantId, "PATCH", {}, { shareServiceAddress: true });
  check(share.status === 200, `PILOT_INTEGRATIONS_ADDRESS_SHARING_PATCH:${share.status}`);
  await share.arrayBuffer();
  const [businessA] = await db.admin.db.select({ enabled: businesses.calendarShareServiceAddress }).from(businesses).where(eq(businesses.id, a.tenantId)).limit(1);
  const [businessB] = await db.admin.db.select({ enabled: businesses.calendarShareServiceAddress }).from(businesses).where(eq(businesses.id, b.tenantId)).limit(1);
  check(businessA?.enabled === true && businessB?.enabled === false, "PILOT_INTEGRATIONS_SHARING_CROSSED_TENANTS");
  const resetShare = await request(path, cookieA, a.tenantId, "PATCH", {}, { shareServiceAddress: false });
  check(resetShare.status === 200, `PILOT_INTEGRATIONS_ADDRESS_SHARING_RESET:${resetShare.status}`);
  await resetShare.arrayBuffer();
}
