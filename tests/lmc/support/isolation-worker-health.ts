import { once } from "node:events";
import { isDeepStrictEqual } from "node:util";
import {
  startHealthServer,
  type WorkerHealthState,
} from "../../../apps/worker/src/health";

/** Real Node server and HTTP transport; health reports global operational state, never business data. */
export async function probeWorkerHealth() {
  const failures: string[] = [],
    probed: string[] = [];
  const state: WorkerHealthState = {
    ready: true,
    redis: true,
    database: true,
    storage: true,
    activeJobs: 3,
  };
  const server = startHealthServer(0, state);
  try {
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("WORKER_HEALTH_ADDRESS_MISSING");
    const base = `http://127.0.0.1:${address.port}`;
    const methods = [
      "DELETE",
      "GET",
      "HEAD",
      "OPTIONS",
      "PATCH",
      "POST",
      "PUT",
    ];
    for (const path of ["/health/live", "/health/ready", "/healthz", "/readyz"])
      for (const method of methods) {
        const id = `worker:${method} ${path}`,
          before = structuredClone(state);
        let passed = true;
        for (const tenant of [
          undefined,
          "11111111-1111-4111-8111-111111111111",
          "22222222-2222-4222-8222-222222222222",
        ]) {
          const headers: Record<string, string> = tenant
            ? {
                "x-business-id": tenant,
                "x-tenant-id": tenant,
                "x-user-id": tenant,
                "x-actor-type": "system",
              }
            : {};
          const response = await fetch(
            `${base}${path}${tenant ? `?businessId=${tenant}&tenantId=${tenant}` : ""}`,
            { method, headers, signal: AbortSignal.timeout(5000) },
          );
          const text = await response.text();
          const expected =
            method === "HEAD"
              ? ""
              : JSON.stringify(
                  path === "/health/live" || path === "/healthz"
                    ? { ok: true }
                    : { ok: true, ...before },
                );
          if (
            response.status !== 200 ||
            text !== expected ||
            !isDeepStrictEqual(state, before)
          ) {
            failures.push(
              `WORKER_HEALTH_RESPONSE:${id}:${tenant ? "forged-context" : "anonymous"}`,
            );
            passed = false;
          }
        }
        if (passed) probed.push(id);
      }
    for (const dependency of [
      "ready",
      "redis",
      "database",
      "storage",
    ] as const) {
      state[dependency] = false;
      for (const [readyPath, livePath] of [
        ["/health/ready", "/health/live"],
        ["/readyz", "/healthz"],
      ])
        for (const method of methods) {
          const response = await fetch(`${base}${readyPath}`, {
            method,
            signal: AbortSignal.timeout(5000),
          });
          const text = await response.text();
          if (
            response.status !== 503 ||
            text !==
              (method === "HEAD" ? "" : JSON.stringify({ ok: false, ...state }))
          )
            failures.push(
              `WORKER_NOT_READY:${readyPath}:${dependency}:${method}`,
            );
          const live = await fetch(`${base}${livePath}`, {
            method,
            signal: AbortSignal.timeout(5000),
          });
          if (
            live.status !== 200 ||
            (await live.text()) !==
              (method === "HEAD" ? "" : JSON.stringify({ ok: true }))
          )
            failures.push(
              `WORKER_LIVENESS:${livePath}:${dependency}:${method}`,
            );
        }
      state[dependency] = true;
    }
    const unknown = await fetch(`${base}/__lmc_unknown_route`, {
      signal: AbortSignal.timeout(5000),
    });
    if (unknown.status !== 404 || (await unknown.text()) !== "")
      failures.push("WORKER_UNKNOWN_ROUTE");
    // No method counts as covered when its unavailable-state check failed.
    return { probed: failures.length ? [] : probed, failures };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
}
