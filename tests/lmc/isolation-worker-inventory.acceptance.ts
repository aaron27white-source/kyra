import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";
import { discoverWorkerHttpRoutes } from "./support/isolation-worker-inventory";
import { discoverApiRoutes, auditRouteId } from "./support/isolation-inventory";

it("includes worker routes in the combined inventory without colliding with admin IDs", () => {
  const routes = discoverApiRoutes();
  expect(routes.filter((route) => route.surface === "worker")).toEqual(
    discoverWorkerHttpRoutes(),
  );
  const worker = routes.find((route) => route.path === "/health/live")!;
  expect(auditRouteId(worker, "GET")).toBe("worker:GET /health/live");
  expect(auditRouteId({ ...worker, surface: "admin" }, "GET")).toBe(
    "GET /health/live",
  );
});

it("discovers worker HTTP routes independently from reachable production source", () => {
  const routes = discoverWorkerHttpRoutes();
  expect(routes.map((route) => route.path).sort()).toEqual([
    "/health/live",
    "/health/ready",
    "/healthz",
    "/internal/live/attach",
    "/readyz",
  ]);
  expect(
    routes.every(
      (route) =>
        route.surface === "worker" &&
        ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"].every(
          (method) => route.methods.includes(method),
        ),
    ),
  ).toBe(true);
});

it("discovers newly added routing and rejects unresolved dynamic paths or listeners", () => {
  const root = mkdtempSync(join(tmpdir(), "lmc-worker-inventory-")),
    src = join(root, "apps/worker/src");
  try {
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "index.ts"), 'import "./http";');
    const file = join(src, "http.ts");
    writeFileSync(
      file,
      'import {createServer} from "node:http"; const server=createServer((request,response)=> {const path=new URL(request.url,"http://localhost").pathname;if(path==="/internal/new-probe")response.end("ok");});server.listen(0);',
    );
    expect(discoverWorkerHttpRoutes(root).map((route) => route.path)).toEqual([
      "/internal/new-probe",
    ]);
    writeFileSync(join(src, "index.ts"), 'import "./http";');
    const shared = join(root, "packages/shared/src");
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, "index.ts"), 'export { PILOT_WORKER_HEALTH_PATHS } from "./pilot";');
    writeFileSync(join(shared, "pilot.ts"), 'export const PILOT_WORKER_HEALTH_PATHS = new Set(["/new-from-shared-source"]);');
    writeFileSync(file, 'import { createServer } from "node:http"; import { PILOT_WORKER_HEALTH_PATHS as allowed } from "@lobbystack/shared"; const server = createServer((request,response)=> { const path=new URL(request.url,"http://localhost").pathname; if(!allowed.has(path))response.end(); }); server.listen(0);');
    expect(discoverWorkerHttpRoutes(root).map(route => route.path)).toEqual(["/new-from-shared-source"]);
    writeFileSync(join(shared, "pilot.ts"), 'export const PILOT_WORKER_HEALTH_PATHS = new Set([dynamicPath]);');
    expect(() => discoverWorkerHttpRoutes(root)).toThrow("UNRESOLVED_WORKER_PATH_SET");
    writeFileSync(file, 'import {createServer} from "node:http"; const server=createServer((request,response)=> {const path=new URL(request.url,"http://localhost").pathname;if(path==="/internal/new-probe")response.end("ok");});server.listen(0);');
    writeFileSync(join(src, "index.ts"), 'import("./" + selectedModule);');
    expect(() => discoverWorkerHttpRoutes(root)).toThrow(
      "UNRESOLVED_WORKER_MODULE",
    );
    writeFileSync(join(src, "index.ts"), 'require("./http");');
    expect(discoverWorkerHttpRoutes(root).map((route) => route.path)).toEqual([
      "/internal/new-probe",
    ]);
    writeFileSync(join(src, "index.ts"), 'import "./http";');
    writeFileSync(
      file,
      'import {createServer} from "node:http"; const server=createServer((request,response)=> {const path=new URL(request.url,"http://localhost").pathname;if(path.startsWith(prefix))response.end("ok");});server.listen(0);',
    );
    expect(() => discoverWorkerHttpRoutes(root)).toThrow(
      "UNRESOLVED_WORKER_ROUTING",
    );
    writeFileSync(
      file,
      'import fastify from "fastify";fastify().listen({port:0});',
    );
    expect(() => discoverWorkerHttpRoutes(root)).toThrow(
      "UNINVENTORIED_WORKER_LISTENER",
    );
  } finally {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("lmc-worker-inventory-")
    )
      throw new Error("UNSAFE_TEMP_CLEANUP");
    rmSync(root, { recursive: true, force: true });
  }
});

it("includes HTTP route handlers outside the admin API directory", () => {
  const paths = discoverApiRoutes()
    .filter((route) => route.surface === "admin")
    .map((route) => route.path);
  expect(paths).toEqual(
    expect.arrayContaining([
      "/oauth/sign-in",
      "/oauth/consent",
      "/embed.js",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server",
    ]),
  );
});
