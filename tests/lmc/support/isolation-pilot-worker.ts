import { once } from "node:events";
import { isDeepStrictEqual } from "node:util";
import { isPilotMode } from "@lobbystack/shared";
import { startHealthServer, type WorkerHealthState } from "../../../apps/worker/src/health";
import { auditRouteId, type AuditRoute } from "./isolation-inventory";
import { PILOT_AUDIT_METHODS } from "./isolation-pilot-inventory";

export async function probePilotWorker(routes: AuditRoute[]) {
  if (!isPilotMode(process.env)) throw new Error("PILOT_WORKER_BOUNDARY_REQUIRED");
  const failures: string[] = [], probed: string[] = [];
  const state: WorkerHealthState = { ready: true, redis: true, database: true, storage: true, activeJobs: 3 };
  let privateControllerCalls = 0;
  const server = startHealthServer(0, state, async (request, response) => {
    if (
      new URL(request.url ?? "/", "http://localhost").pathname ===
        "/internal/live/attach" &&
      request.method === "POST" &&
      request.headers["x-internal-service-token"] !==
        process.env.INTERNAL_SERVICE_TOKEN
    ) {
      response.writeHead(401);
      response.end();
      return true;
    }
    privateControllerCalls++;
    response.writeHead(202);
    response.end("private controller");
    return true;
  });
  try {
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("PILOT_WORKER_ADDRESS_MISSING");
    const base = `http://127.0.0.1:${address.port}`;
    const identities = [undefined, "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    for (const route of routes) {
      for (const method of route.methods) {
        const id = auditRouteId(route, method), before = structuredClone(state);
        let passed = true;
        for (const tenant of identities) {
          const response = await fetch(`${base}${route.path}${tenant ? `?businessId=${tenant}` : ""}`, { method, signal: AbortSignal.timeout(5000), headers: tenant ? { "x-business-id": tenant, "x-tenant-id": tenant, "x-user-id": tenant, "x-actor-type": "system" } : {} });
          const text = await response.text();
          const supported = method === "GET" || method === "HEAD";
          const expected = !supported || method === "HEAD" ? "" : JSON.stringify(route.path === "/healthz" || route.path === "/health/live" ? { ok: true } : { ok: true, ...before });
          if (response.status !== (supported ? 200 : 405) || text !== expected || (!supported && response.headers.get("allow") !== "GET, HEAD") || !isDeepStrictEqual(state, before)) {
            failures.push(`PILOT_WORKER_HEALTH:${id}:${tenant ? "forged-context" : "anonymous"}:${response.status}`);
            passed = false;
          }
        }
        if (passed) probed.push(id);
      }
    }
    for (const dependency of ["ready", "redis", "database", "storage"] as const) {
      state[dependency] = false;
      for (const [ready, live] of [["/health/ready", "/health/live"], ["/readyz", "/healthz"]] as const) {
        for (const method of PILOT_AUDIT_METHODS) {
          const supported = method === "GET" || method === "HEAD";
          for (const [path, expectedStatus, body] of [[ready, supported ? 503 : 405, { ok: false, ...state }], [live, supported ? 200 : 405, { ok: true }]] as const) {
            const response = await fetch(base + path, { method, signal: AbortSignal.timeout(5000) });
            const expected = !supported || method === "HEAD" ? "" : JSON.stringify(body);
            if (response.status !== expectedStatus || (await response.text()) !== expected) failures.push(`PILOT_WORKER_DEPENDENCY:${dependency}:${method}:${path}`);
          }
        }
      }
      state[dependency] = true;
    }
    for (const path of ["/internal/live/attach", "/__lmc_unknown", "/healthz/extra"]) {
      for (const method of PILOT_AUDIT_METHODS) {
        // This is the sole supported pilot exception, but missing the dedicated
        // internal token must stop before its private controller is reached.
        const response = await fetch(base + path, { method, signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN ?? "synthetic-test-service-key"}`, "x-business-id": identities[1]! } });
        const expected = path === "/internal/live/attach" && method === "POST" ? 401 : 404;
        if (response.status !== expected || (await response.text()) !== "") failures.push(`PILOT_WORKER_DENIED:${method}:${path}`);
      }
    }
    if (privateControllerCalls !== 0) failures.push("PILOT_PRIVATE_CONTROLLER_INVOKED");
    return { probed: failures.length ? [] : probed, failures };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
}
