import { isDeepStrictEqual } from "node:util";
import { PILOT_ADMIN_ROUTES } from "@lobbystack/shared";
import type { HttpAuditContext } from "./isolation-http";
import { readIsolationCatalog, type AuditRoute } from "./isolation-inventory";
import { quote } from "./isolation-fixtures";

export async function scopedSnapshot(context: HttpAuditContext, target: "a" | "b" | "both" = "both") {
  const catalog = await readIsolationCatalog(context.db);
  const fixtures = target === "both" ? [context.a, context.b] : [context[target]];
  const ids = fixtures.flatMap(fixture => [fixture.tenantId, fixture.ownerId]);
  const snapshot: Record<string, unknown> = {};
  for (const table of catalog.tables) {
    const keys = table.columns.filter(column => ["tenant_id", "business_id", "user_id"].includes(column.name) || (table.name === "users" && column.name === "id"));
    if (!keys.length) continue;
    const where = keys.map(column => `t.${quote(column.name)}::text=any($1::text[])`).join(" or ");
    const result = await context.db.admin.pool.query<{ data: unknown }>(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) as data from public.${quote(table.name)} t where ${where}`, [ids]);
    snapshot[table.name] = result.rows[0]!.data;
  }
  return snapshot;
}

/** Actual HTTP method rejection with A/B sessions, forged actor claims and before/after DB state. */
export async function probePilotMethodGuards(context: HttpAuditContext, routes: AuditRoute[]) {
  const { a, b, one, other, cookieA, cookieB, request, check } = context;
  const boundary = await request("/api/billing");
  if (boundary.status !== 404) throw new Error("PILOT_HTTP_BOUNDARY_REQUIRED");
  await boundary.arrayBuffer();
  const before = await scopedSnapshot(context);
  const covered: string[] = [];
  for (const route of routes.filter(route => route.surface === "admin")) {
    const policy = PILOT_ADMIN_ROUTES.find(policy => policy.pattern === route.path);
    if (!policy) throw new Error(`UNCLASSIFIED_PILOT_GUARD:${route.path}`);
    const token = route.path.includes("/unsubscribe/") ? "payload.signature" : new URL(a.captureUrl).pathname.split("/").at(-1)!;
    const path = route.path
      .replace("[leadId]", one.id)
      .replace("[contactId]", one.id)
      .replace("[serviceId]", one.id)
      .replace("[documentId]", one.id)
      .replace("[snippetId]", one.id)
      .replace("[appointmentId]", one.id)
      .replace("[tenantId]", a.tenantId)
      .replace("[callId]", a.tenantId)
      .replace("[token]", token);
    for (const method of route.methods.filter(method => !policy.methods.includes(method))) {
      const id = `${method} ${route.path}`;
      const attempts = [
        { cookie: "", tenant: b.tenantId, user: b.ownerId, path },
        { cookie: cookieA, tenant: a.tenantId, user: a.ownerId, path },
        { cookie: cookieB, tenant: b.tenantId, user: b.ownerId, path: path.replace(one.id, other.id) },
        { cookie: cookieA, tenant: b.tenantId, user: b.ownerId, path: path.replace(one.id, other.id) },
      ];
      const passed = await Promise.all(attempts.map(async (attempt, index) => {
        const response = await request(`${attempt.path}?businessId=${attempt.tenant}`, attempt.cookie, attempt.tenant, method, { "x-user-id": attempt.user, "x-tenant-id": attempt.tenant, "x-actor-type": "system" }, ["GET", "HEAD", "OPTIONS"].includes(method) ? undefined : {});
        const text = await response.text();
        const allow = (response.headers.get("allow") ?? "").split(/[, ]+/).filter(Boolean).sort();
        const valid = response.status === 405 && text === "" && !response.headers.has("location") && !response.headers.has("set-cookie") && response.headers.get("cache-control") === "no-store" && isDeepStrictEqual(allow, [...policy.methods].sort());
        check(valid, `PILOT_METHOD_GUARD:${id}:${index}:${response.status}`);
        return valid;
      }));
      if (passed.every(Boolean)) covered.push(id);
    }
  }
  const unchanged = isDeepStrictEqual(before, await scopedSnapshot(context));
  check(unchanged, "PILOT_METHOD_GUARDS_CHANGED_SCOPED_DATABASE");
  if (unchanged) context.probed.push(...covered);
}
