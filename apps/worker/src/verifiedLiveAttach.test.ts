import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ canAttach: vi.fn() }));
vi.mock("@lobbystack/domain", () => ({ canAttachLiveCall: mocks.canAttach }));

import { startHealthServer } from "./health";
import { createVerifiedLiveAttachHandler } from "./verifiedLiveAttach";

const businessId = "11111111-1111-4111-8111-111111111111";
const callId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";
const attachBody = { sessionId: "live_session_1", businessId, callId, conversationId, channel: "voice" };

function inputHandle() {
  return vi.fn(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ accepted: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    return true;
  });
}

async function withPilotServer(run: (base: string, handle: ReturnType<typeof inputHandle>) => Promise<void>) {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("LMC_PILOT_MODE", "true");
  vi.stubEnv("LIVE_PROTOTYPE_ENABLED", "true");
  vi.stubEnv("INTERNAL_SERVICE_TOKEN", "internal-secret");
  const handle = inputHandle();
  const verified = createVerifiedLiveAttachHandler({ domain: { db: {} as never }, handle });
  const server = startHealthServer(0, { ready: true, redis: true, database: true, storage: true, activeJobs: 0 }, verified);
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try { await run(base, handle); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("pilot authenticated live attach", () => {
  it("routes a valid authenticated attach through the verified handler", async () => {
    mocks.canAttach.mockResolvedValue(true);
    await withPilotServer(async (base, handle) => {
      const response = await fetch(`${base}/internal/live/attach`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-service-token": "internal-secret" },
        body: JSON.stringify(attachBody),
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ accepted: attachBody });
      expect(mocks.canAttach).toHaveBeenCalledWith({ db: expect.anything() }, attachBody);
      expect(handle).toHaveBeenCalledOnce();
    });
  });

  it("rejects an unauthenticated attach before admission or controller dispatch", async () => {
    await withPilotServer(async (base, handle) => {
      const response = await fetch(`${base}/internal/live/attach`, { method: "POST", body: JSON.stringify(attachBody) });
      expect(response.status).toBe(401);
      expect(mocks.canAttach).not.toHaveBeenCalled();
      expect(handle).not.toHaveBeenCalled();
    });
  });

  it("rejects cross-tenant or otherwise unassociated session identities", async () => {
    mocks.canAttach.mockResolvedValue(false);
    await withPilotServer(async (base, handle) => {
      const response = await fetch(`${base}/internal/live/attach`, {
        method: "POST",
        headers: { "x-internal-service-token": "internal-secret" },
        body: JSON.stringify({ ...attachBody, businessId: "44444444-4444-4444-8444-444444444444" }),
      });
      expect(response.status).toBe(404);
      expect(mocks.canAttach).toHaveBeenCalledOnce();
      expect(handle).not.toHaveBeenCalled();
    });
  });

  it("keeps every other non-health Worker endpoint blocked in pilot mode", async () => {
    await withPilotServer(async (base, handle) => {
      for (const [path, method] of [["/internal/jobs", "POST"], ["/internal/live/attach/extra", "POST"], ["/internal/live/attach", "GET"]] as const) {
        expect((await fetch(base + path, { method })).status, `${method} ${path}`).toBe(404);
      }
      expect(handle).not.toHaveBeenCalled();
      expect(mocks.canAttach).not.toHaveBeenCalled();
    });
  });

  it("rejects oversized payloads without passing them to the controller", async () => {
    await withPilotServer(async (base, handle) => {
      const request = Object.assign(Readable.from([Buffer.alloc(16 * 1024 + 1)]), {
        url: "/internal/live/attach",
        method: "POST",
        headers: { "x-internal-service-token": "internal-secret" },
      }) as unknown as IncomingMessage;
      const response = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
      const verified = createVerifiedLiveAttachHandler({ domain: { db: {} as never }, handle });
      await verified(request, response);
      expect(response.writeHead).toHaveBeenCalledWith(413, { "content-type": "application/json" });
      expect(handle).not.toHaveBeenCalled();
    });
  });
});
