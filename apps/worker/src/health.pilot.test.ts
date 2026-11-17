import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHealthServer } from "./health";

afterEach(() => vi.unstubAllEnvs());

describe("pilot worker HTTP boundary", () => {
  it.each([undefined, "true", "invalid"])("defaults closed in production (%s)", async flag => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LMC_PILOT_MODE", flag);
    const extra = vi.fn(async (_request, response) => {
      response.writeHead(200);
      response.end("private controller invoked");
      return true;
    });
    const server = startHealthServer(0, { ready: true, redis: true, database: true, storage: true, activeJobs: 0 }, extra);
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
        for (const path of ["/unknown", "/healthz/extra", "/healthz%2fextra"]) {
          expect((await fetch(base + path, { method })).status, `${method} ${path}`).toBe(404);
        }
        if (method !== "POST") expect((await fetch(base + "/internal/live/attach", { method })).status).toBe(404);
        for (const path of ["/healthz", "/readyz", "/health/live", "/health/ready"]) {
          expect((await fetch(base + path, { method })).status, `${method} ${path}`).toBe(["GET", "HEAD"].includes(method) ? 200 : 405);
        }
      }
      expect((await fetch(base + "/internal/live/attach", { method: "POST" })).status).toBe(200);
      expect(extra).toHaveBeenCalledTimes(1);
      expect(extra.mock.calls[0]?.[0].url).toBe("/internal/live/attach");
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("retains the existing internal controller when pilot mode is explicitly disabled", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("LMC_PILOT_MODE", "false");
    const extra = vi.fn(async (_request, response) => {
      response.writeHead(202);
      response.end();
      return true;
    });
    const server = startHealthServer(0, { ready: false, redis: false, database: false, storage: false, activeJobs: 0 }, extra);
    await once(server, "listening");
    try {
      expect((await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/live/attach`, { method: "POST" })).status).toBe(202);
      expect(extra).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
