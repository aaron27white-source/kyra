import { afterEach, describe, expect, it, vi } from "vitest";

import { attachWorkerToLiveSession } from "./live-prototype";

const attach = { sessionId: "live_test", businessId: "biz_test", callId: "call_test", channel: "voice" as const };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("attachWorkerToLiveSession", () => {
  it("sends an internal request ID and does not expose credentials", async () => {
    vi.stubEnv("INTERNAL_SERVICE_TOKEN", "private-internal-token");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }));
    await expect(attachWorkerToLiveSession(attach)).resolves.toBeUndefined();
    const [url, init] = fetch.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(url).toContain("/internal/live/attach");
    expect(headers.get("x-internal-service-token")).toBe("private-internal-token");
    expect(headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/i);
    expect(String(init?.body)).not.toContain("private-internal-token");
  });

  it("preserves only allowlisted startup diagnostics from a failed Worker", async () => {
    vi.stubEnv("INTERNAL_SERVICE_TOKEN", "private-internal-token");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ reason: "greeting_start_failed", errorCode: "greeting_audio_timeout" }), { status: 503 }));
    await expect(attachWorkerToLiveSession(attach)).rejects.toMatchObject({ status: 503, reason: "greeting_start_failed", code: "greeting_audio_timeout", requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i) });
  });

  it("retains request correlation on a timeout without exposing the transport error", async () => {
    vi.stubEnv("INTERNAL_SERVICE_TOKEN", "private-internal-token");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(Object.assign(new Error("secret-bearing transport body"), { name: "TimeoutError" }));
    await expect(attachWorkerToLiveSession(attach)).rejects.toMatchObject({ reason: "worker_attach_transport_failed", code: "worker_attach_timeout", requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i) });
  });
});
