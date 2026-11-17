import { isDeepStrictEqual } from "node:util";
import type { HttpAuditContext } from "./isolation-http";

/** User/session endpoints ignore forged tenant selectors; switching requires real membership. */
export async function probePilotSessionContext(context: HttpAuditContext) {
  const { a, b, cookieA, cookieB, request, check, probed, db } = context;
  const signedIn = context.verifiedLoginUsers.includes(a.ownerId) && context.verifiedLoginUsers.includes(b.ownerId);
  check(signedIn, "PILOT_REAL_SIGN_IN_CONTROLS_MISSING");
  if (signedIn) probed.push("POST /api/auth/sign-in/email");
  for (const path of ["/api/auth/get-session", "/api/account", "/api/businesses"]) {
    for (const [cookie, tenant, own, foreign] of [[cookieA, a.tenantId, a, b], [cookieB, b.tenantId, b, a], [cookieA, b.tenantId, a, b]] as const) {
      const response = await request(`${path}?businessId=${tenant}`, cookie, tenant, "GET", { "x-user-id": foreign.ownerId, "x-tenant-id": tenant, "x-actor-type": "system" });
      const text = await response.text();
      let payload: { user?: { id?: string }; businesses?: Array<{ businessId: string }> } = {};
      try { payload = JSON.parse(text); } catch { check(false, `PILOT_SESSION_JSON:${path}`); }
      check(response.status === 200 && !text.includes(foreign.ownerId) && !text.includes(foreign.tenantId), `PILOT_SESSION_FOREIGN_DATA:${path}:${response.status}`);
      if (path !== "/api/businesses") check(payload.user?.id === own.ownerId, `PILOT_SESSION_CANONICAL_USER:${path}`);
      if (path !== "/api/auth/get-session") check(payload.businesses?.some(row => row.businessId === own.tenantId) === true && payload.businesses.every(row => row.businessId !== foreign.tenantId), `PILOT_SESSION_MEMBERSHIPS:${path}`);
    }
    const anonymous = await request(path, "", b.tenantId);
    const text = await anonymous.text();
    check(anonymous.status === (path === "/api/auth/get-session" ? 200 : 401), `PILOT_SESSION_ANONYMOUS:${path}:${anonymous.status}`);
    if (path === "/api/auth/get-session") check(text.trim() === "null", "PILOT_ANONYMOUS_SESSION_NOT_NULL");
    else check(!text.includes(a.ownerId) && !text.includes(b.ownerId), `PILOT_ANONYMOUS_USER_LEAK:${path}`);
    probed.push(`GET ${path}`);
    if (path === "/api/auth/get-session") continue;
    for (const [cookie, tenant, expected] of [[cookieA, a.tenantId, 200], [cookieB, b.tenantId, 200], [cookieA, b.tenantId, 200], ["", b.tenantId, 401]] as const) {
      const response = await request(path, cookie, tenant, "HEAD");
      check(response.status === expected && (await response.text()) === "", `PILOT_SESSION_HEAD:${path}:${response.status}`);
    }
    probed.push(`HEAD ${path}`);
    await options(path);
  }
  async function options(path: string) {
    for (const [cookie, tenant] of [["", b.tenantId], [cookieA, b.tenantId], [cookieB, a.tenantId]] as const) {
      const response = await request(path, cookie, tenant, "OPTIONS");
      check(response.status === 204 && (await response.text()) === "" && !response.headers.has("set-cookie"), `PILOT_SESSION_OPTIONS:${path}:${response.status}`);
    }
    probed.push(`OPTIONS ${path}`);
  }
  async function users() {
    return (await db.admin.pool.query("select id,active_business_id,updated_at from users where id=any($1::uuid[]) order by id", [[a.ownerId, b.ownerId]])).rows;
  }
  for (const [cookie, tenant, userId] of [[cookieA, a.tenantId, a.ownerId], [cookieB, b.tenantId, b.ownerId]] as const) {
    const response = await request("/api/businesses/switch", cookie, tenant, "POST", {}, { businessId: tenant });
    const payload = await response.json() as { businessId?: string };
    check(response.status === 200 && payload.businessId === tenant, `PILOT_SWITCH_POSITIVE:${userId}:${response.status}`);
    const persisted = await db.admin.pool.query<{ active_business_id: string }>("select active_business_id from users where id=$1", [userId]);
    check(persisted.rows[0]?.active_business_id === tenant, `PILOT_SWITCH_PERSISTENCE:${userId}`);
  }
  const before = await users();
  for (const [cookie, tenant, expected, origin] of [[cookieA, b.tenantId, 403, context.base.origin], [cookieB, a.tenantId, 403, context.base.origin], ["", b.tenantId, 401, context.base.origin], [cookieA, a.tenantId, 403, "https://foreign.invalid"]] as const) {
    const response = await request("/api/businesses/switch", cookie, tenant, "POST", { origin, "x-user-id": b.ownerId, "x-actor-type": "system" }, { businessId: tenant, userId: b.ownerId, role: "platform_admin" });
    const text = await response.text();
    check(response.status === expected && !text.includes("Florida Roofing"), `PILOT_SWITCH_FOREIGN:${expected}:${response.status}`);
  }
  check(isDeepStrictEqual(before, await users()), "PILOT_SWITCH_FOREIGN_PERSISTED");
  probed.push("POST /api/businesses/switch");
  await options("/api/businesses/switch");
}
