import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ unwrap: vi.fn(), reject: vi.fn(), accept: vi.fn(), hangup: vi.fn(), execute: vi.fn(), snapshot: vi.fn(), startLivePhoneCall: vi.fn(), finishLiveCall: vi.fn(), attach: vi.fn() }));

vi.mock("@lobbystack/agent-core/live/session", () => ({ buildPhoneSessionConfig: vi.fn() }));
vi.mock("@lobbystack/domain", () => ({ finishLiveCall: mocks.finishLiveCall, getCachedBusinessSnapshot: mocks.snapshot, startLivePhoneCall: mocks.startLivePhoneCall }));
vi.mock("@/lib/api-helpers", () => ({ getAppDatabase: () => ({ db: { execute: mocks.execute } }) }));
vi.mock("@/lib/domain-context", () => ({ createWorkerDomainContext: () => ({}) }));
vi.mock("@/lib/live-prototype", () => ({
  attachWorkerToLiveSession: mocks.attach,
  getLiveClient: () => ({ webhooks: { unwrap: mocks.unwrap }, live: { sessions: { reject: mocks.reject, accept: mocks.accept, hangup: mocks.hangup } } }),
}));

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("LIVE_PROTOTYPE_ENABLED", "true");
  mocks.reject.mockResolvedValue(undefined);
  mocks.hangup.mockResolvedValue(undefined);
  mocks.execute.mockResolvedValue({ rows: [{ business_id: null }] });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("POST /api/webhooks/openai/live", () => {
  it("leaves an unknown call for the other deployment without logging phone numbers or caller identity", async () => {
    const warn = vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.unwrap.mockResolvedValue({
      type: "live.transport.incoming",
      data: {
        session_id: "live_1",
        sip_headers: [
          { name: "To", value: "<sip:proj_1@sip.api.openai.com>" },
          { name: "Diversion", value: "<sip:+15815550100@example.com>" },
          { name: "From", value: "\"Sam Lee\" <sip:+14165550134@example.com>" },
        ],
      },
    });

    const response = await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));

    expect(response.status).toBe(200);
    expect(mocks.reject).not.toHaveBeenCalled();
    expect(mocks.accept).not.toHaveBeenCalled();
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).not.toContain("+15815550100");
    expect(logged).not.toContain("4165550134");
    expect(logged).not.toContain("Sam Lee");
  });

  it("uses the tenant voice feature gate in pilot mode and leaves disabled calls untouched", async () => {
    vi.stubEnv("LMC_PILOT_MODE", "true");
    mocks.unwrap.mockResolvedValue({ type: "live.transport.incoming", data: { session_id: "live_pilot", sip_headers: [{ name: "Diversion", value: "<sip:+15815550100@example.com>" }, { name: "From", value: "<sip:+14165550134@example.com>" }] } });
    const response = await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));
    expect(response.status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.reject).not.toHaveBeenCalled();
    expect(mocks.accept).not.toHaveBeenCalled();
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });

  it("finishes answering a retried call without touching its record", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ business_id: "biz_1" }] });
    mocks.snapshot.mockResolvedValue({ businessId: "biz_1", greeting: "Hi" });
    mocks.startLivePhoneCall.mockResolvedValue({ callId: "call_1", conversationId: "conv_1", duplicate: true, blocked: false });
    // The first delivery already accepted it, so accepting again fails.
    mocks.accept.mockRejectedValue(new Error("already accepted"));
    mocks.attach.mockResolvedValue(undefined);
    mocks.unwrap.mockResolvedValue({
      type: "live.transport.incoming",
      data: { session_id: "live_1", sip_headers: [{ name: "Diversion", value: "<sip:+15815550100@example.com>" }, { name: "From", value: "<sip:+14165550134@example.com>" }] },
    });

    const response = await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));

    expect(response.status).toBe(200);
    expect(mocks.attach).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "live_1", callId: "call_1", channel: "voice" }));
    expect(mocks.finishLiveCall).not.toHaveBeenCalled();
  });

  it("hangs up, records setup failure, and logs only sanitized attach diagnostics", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.execute.mockResolvedValue({ rows: [{ business_id: "biz_1" }] });
    mocks.snapshot.mockResolvedValue({ businessId: "biz_1", greeting: "Hi" });
    mocks.startLivePhoneCall.mockResolvedValue({ callId: "call_1", conversationId: "conv_1", duplicate: false, blocked: false, ended: false });
    mocks.accept.mockResolvedValue(undefined);
    mocks.attach.mockRejectedValue(Object.assign(new Error("do not log provider response or token"), { status: 503, reason: "greeting_start_failed", requestId: "req_123", token: "secret" }));
    mocks.unwrap.mockResolvedValue({ type: "live.transport.incoming", data: { session_id: "live_1", sip_headers: [{ name: "Diversion", value: "<sip:+15815550100@example.com>" }, { name: "From", value: "<sip:+14165550134@example.com>" }] } });

    const response = await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));

    expect(response.status).toBe(200);
    expect(mocks.hangup).toHaveBeenCalledWith("live_1");
    expect(mocks.finishLiveCall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ callId: "call_1", seconds: 0, end: "setup_failed" }));
    const info = infoLog.mock.calls.flat().join(" ");
    expect(info).toContain('"event":"live.provider_hangup.requested"');
    expect(info).toContain('"event":"live.provider_hangup.accepted"');
    expect(info).toContain('"reason":"greeting_start_failed"');
    const logged = errorLog.mock.calls.flat().join(" ");
    expect(logged).toContain("greeting_start_failed");
    expect(logged).toContain("req_123");
    expect(logged).toContain("503");
    expect(logged).not.toContain("provider response");
    expect(logged).not.toContain("secret");
    expect(logged).not.toContain("+14165550134");
  });

  it("records OpenAI acceptance failure as a zero-duration setup failure", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.execute.mockResolvedValue({ rows: [{ business_id: "biz_1" }] });
    mocks.snapshot.mockResolvedValue({ businessId: "biz_1", greeting: "Hi" });
    mocks.startLivePhoneCall.mockResolvedValue({ callId: "call_1", conversationId: "conv_1", duplicate: false, blocked: false, ended: false });
    mocks.accept.mockRejectedValue(Object.assign(new Error("private provider response with secret"), { status: 400, code: "invalid_session_config" }));
    mocks.unwrap.mockResolvedValue({ type: "live.transport.incoming", data: { session_id: "live_accept_error", sip_headers: [{ name: "Diversion", value: "<sip:+15815550100@example.com>" }] } });

    const response = await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));

    expect(response.status).toBe(200);
    expect(mocks.reject).toHaveBeenCalledWith("live_accept_error", { status_code: 503 });
    expect(mocks.hangup).toHaveBeenCalledWith("live_accept_error");
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(mocks.finishLiveCall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ callId: "call_1", seconds: 0, end: "setup_failed" }));
    const logged = errorLog.mock.calls.flat().join(" ");
    expect(logged).toContain("openai_session_accept_failed");
    expect(logged).toContain("invalid_session_config");
    expect(logged).toContain("400");
    expect(logged).not.toContain("private provider response");
    expect(logged).not.toContain("secret");
  });

  it("does not swallow a failed attach for an open duplicate call", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ business_id: "biz_1" }] });
    mocks.startLivePhoneCall.mockResolvedValue({ callId: "call_1", conversationId: "conv_1", duplicate: true, blocked: false, ended: false });
    mocks.accept.mockRejectedValue(new Error("already accepted"));
    mocks.attach.mockRejectedValue(Object.assign(new Error("attach did not start"), { status: 503, reason: "sideband_connection_failed", requestId: "req_duplicate" }));
    mocks.unwrap.mockResolvedValue({ type: "live.transport.incoming", data: { session_id: "live_duplicate", sip_headers: [{ name: "Diversion", value: "<sip:+15815550100@example.com>" }] } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));

    expect(response.status).toBe(200);
    expect(mocks.hangup).toHaveBeenCalledWith("live_duplicate");
    expect(mocks.finishLiveCall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ callId: "call_1", seconds: 0, end: "setup_failed" }));
  });

  it("does not retry a call whose setup failure has already finalized it", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ business_id: "biz_1" }] });
    mocks.startLivePhoneCall.mockResolvedValue({ callId: "call_1", conversationId: "conv_1", duplicate: true, blocked: false, ended: true });
    mocks.unwrap.mockResolvedValue({ type: "live.transport.incoming", data: { session_id: "live_1", sip_headers: [{ name: "Diversion", value: "<sip:+15815550100@example.com>" }] } });

    const response = await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));

    expect(response.status).toBe(200);
    expect(mocks.reject).toHaveBeenCalledWith("live_1", { status_code: 486 });
    expect(mocks.accept).not.toHaveBeenCalled();
    expect(mocks.attach).not.toHaveBeenCalled();
  });

  it("leaves the call alone when the number lookup fails", async () => {
    mocks.execute.mockRejectedValue(new Error("connection terminated"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.unwrap.mockResolvedValue({ type: "live.transport.incoming", data: { session_id: "live_1", sip_headers: [{ name: "Diversion", value: "<sip:+15815550100@example.com>" }] } });
    const response = await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));
    expect(response.status).toBe(503);
    expect(mocks.reject).not.toHaveBeenCalled();
  });

  it("rejects a call with no dialled number", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.unwrap.mockResolvedValue({ type: "live.transport.incoming", data: { session_id: "live_1", sip_headers: [{ name: "To", value: "<sip:proj_1@sip.api.openai.com>" }] } });
    const response = await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));
    expect(response.status).toBe(200);
    expect(mocks.reject).toHaveBeenCalledWith("live_1", { status_code: 404 });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
