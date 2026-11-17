import { PILOT_ADMIN_ROUTES, PILOT_WORKER_HEALTH_PATHS } from "@lobbystack/shared";
import { discoverApiRoutes, type AuditRoute } from "./isolation-inventory";

export const PILOT_AUDIT_METHODS = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"];

/** Match policy entries to independently discovered handlers, never to a list of implemented probes. */
export function discoverPilotApiRoutes(
  discovered = discoverApiRoutes(),
  adminPolicy: typeof PILOT_ADMIN_ROUTES = PILOT_ADMIN_ROUTES,
): AuditRoute[] {
  const routes: AuditRoute[] = [];
  for (const policy of adminPolicy) {
    if (!policy.pattern.startsWith("/api/") && !["/healthz", "/readyz"].includes(policy.pattern)) continue;
    const exact = discovered.find(route => route.surface === "admin" && route.path === policy.pattern);
    const handler = exact ?? (policy.pattern.startsWith("/api/auth/") ? discovered.find(route => route.surface === "admin" && route.path === "/api/auth/[...all]") : undefined);
    if (!handler) throw new Error(`PILOT_HANDLER_MISSING:admin:${policy.pattern}`);
    const impossible = policy.methods.filter(method => !handler.methods.includes(method));
    if (impossible.length) throw new Error(`PILOT_METHOD_WITHOUT_HANDLER:${policy.pattern}:${impossible.join(",")}`);
    routes.push({ ...handler, path: policy.pattern, methods: [...PILOT_AUDIT_METHODS] });
  }
  for (const path of PILOT_WORKER_HEALTH_PATHS) {
    const handler = discovered.find(route => route.surface === "worker" && route.path === path);
    if (!handler) throw new Error(`PILOT_HANDLER_MISSING:worker:${path}`);
    routes.push({ ...handler, methods: [...PILOT_AUDIT_METHODS] });
  }
  const ids = routes.map(route => `${route.surface}:${route.path}`);
  if (new Set(ids).size !== routes.length) throw new Error("DUPLICATE_PILOT_ROUTE");
  return routes.sort((a, b) => `${a.surface}:${a.path}`.localeCompare(`${b.surface}:${b.path}`));
}
