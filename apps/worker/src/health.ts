import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { isPilotMode, PILOT_WORKER_HEALTH_PATHS } from "@lobbystack/shared";

export type WorkerHealthState = {
  ready: boolean;
  redis: boolean;
  database: boolean;
  storage: boolean;
  activeJobs: number;
};

export type ExtraRouteHandler = (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;

export function startHealthServer(port: number, state: WorkerHealthState, extraRoutes?: ExtraRouteHandler): Server {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (isPilotMode(process.env)) {
      // This is the only non-health route exposed in pilot mode. The handler
      // supplied by index.ts is the verified attach wrapper, which checks the
      // internal token, bounded body, tenant/session/call association, and then
      // invokes the existing live-call controller. Never fall through to any
      // other worker controller from the pilot boundary.
      if (path === "/internal/live/attach" && request.method === "POST") {
        if (extraRoutes && await extraRoutes(request, response)) return;
        response.writeHead(404, { "cache-control": "no-store" });
        response.end();
        return;
      }
      // Gate before invoking any legacy controller, including authenticated calls.
      if (!PILOT_WORKER_HEALTH_PATHS.has(path)) {
        response.writeHead(404, { "cache-control": "no-store" });
        response.end();
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { allow: "GET, HEAD", "cache-control": "no-store" });
        response.end();
        return;
      }
    } else if (extraRoutes && await extraRoutes(request, response)) return;
    if (path === "/health/live" || path === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (path === "/health/ready" || path === "/readyz") {
      const ok = state.ready && state.redis && state.database && state.storage;
      response.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok, ...state }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  // "::" accepts IPv4 too; Railway private networking reaches the worker over IPv6.
  server.listen(port, "::");
  return server;
}
