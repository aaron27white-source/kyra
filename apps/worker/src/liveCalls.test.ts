import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  controllers: 0,
  controllerOptions: [] as Array<Record<string, (...args: never[]) => unknown>>,
  snapshot: vi.fn(),
  loadCaller: vi.fn(),
  createAgent: vi.fn(() => ({})),
  recordProductEvent: vi.fn(async (..._args: unknown[]) => "event_1"),
  providerHangup: vi.fn(async (..._args: unknown[]) => undefined),
  finishLiveCall: vi.fn(async (..._args: unknown[]) => false),
  controllerStart: vi.fn(async () => undefined),
  controllerCancel: vi.fn(),
  StartupError: class LiveCallStartupError extends Error {
    constructor(readonly reason: string, readonly errorCode?: string) { super(reason); }
  },
}));

vi.mock("@lobbystack/agent-core", () => ({
  createAgentModel: () => ({}),
  createReceptionistAgent: mocks.createAgent,
  LiveCallStartupError: mocks.StartupError,
  LiveCallController: class {
    constructor(options: Record<string, (...args: never[]) => unknown>) {
      mocks.controllers += 1;
      mocks.controllerOptions.push(options);
    }
    start() { return mocks.controllerStart(); }
    cancelStartup() { mocks.controllerCancel(); }
  },
}));
vi.mock("@lobbystack/domain", () => ({
  getCachedBusinessSnapshot: mocks.snapshot,
  loadLiveCallForPricing: mocks.loadCaller,
  finishLiveCall: mocks.finishLiveCall,
  LIVE_CALL_PROVIDER: "openai_live",
  recordProductEvent: mocks.recordProductEvent,
}));
vi.mock("@lobbystack/jobs", () => ({ renewVoicePresenceGateway: vi.fn(async () => undefined), updateVoicePresence: vi.fn(async () => undefined) }));
vi.mock("openai", () => ({ default: class { live = { sessions: { hangup: mocks.providerHangup } }; } }));

import { actualLiveCallEnd, createLiveCallHandler, parseAttachRequest, providerSeconds } from "./liveCalls";

function attachRequest(body: Record<string, unknown>): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { url: "/internal/live/attach", method: "POST", headers: { "x-internal-service-token": "token" } }) as unknown as IncomingMessage;
}

function response(): ServerResponse {
  let closeListener: (() => void) | undefined;
  const result = {
    writeHead: vi.fn(),
    end: vi.fn(),
    once: vi.fn((_event: string, listener: () => void) => { closeListener = listener; return result; }),
    off: vi.fn(() => result),
    destroyed: false,
    writableEnded: false,
    emitClose: () => { result.destroyed = true; closeListener?.(); },
  };
  return result as unknown as ServerResponse;
}

beforeEach(() => {
  mocks.controllers = 0;
  mocks.controllerOptions.length = 0;
  mocks.controllerStart.mockReset().mockResolvedValue(undefined);
  mocks.controllerCancel.mockReset();
  mocks.providerHangup.mockReset().mockResolvedValue(undefined);
  mocks.createAgent.mockClear();
  mocks.loadCaller.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("createLiveCallHandler", () => {
  it("uses the documented Live SIP hangup endpoint and logs the correlated accepted result", async () => {
    vi.stubEnv("LIVE_PROTOTYPE_ENABLED", "true");
    vi.stubEnv("INTERNAL_SERVICE_TOKEN", "token");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    mocks.snapshot.mockResolvedValue({ businessId: "biz_1", greeting: "Hi" });
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const handler = createLiveCallHandler({ domain: { db: {} as never } });
    await handler.handle(attachRequest({ sessionId: "live_sip_end", businessId: "biz_1", callId: "call_sip_end", channel: "voice" }), response());
    const options = mocks.controllerOptions.at(-1)!;
    await options.onHangup!("caller_finished" as never);
    expect(mocks.providerHangup).toHaveBeenCalledWith("live_sip_end");
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"event":"live.provider_hangup.requested"'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"event":"live.provider_hangup.accepted"'));
    expect(log.mock.calls.map(([value]) => value).join("\n")).toContain('"callId":"call_sip_end"');
    log.mockRestore();
  });

  it("does not treat an accepted request or an unconfirmed local close as SIP disconnection", () => {
    expect(actualLiveCallEnd({ closeReason: "close_requested", providerHangupOutcome: "unconfirmed", sessionConfirmedClosed: false, providerCallDisconnected: false }, "caller_finished", "voice")).toBe("connection_lost");
    expect(actualLiveCallEnd({ closeReason: "close_requested", providerHangupOutcome: "failed", sessionConfirmedClosed: true, providerCallDisconnected: false }, "caller_finished", "voice")).toBe("connection_lost");
  });

  it("records SIP disconnection only after a terminal Live close confirms an accepted hangup", () => {
    expect(actualLiveCallEnd({ closeReason: "close_requested", providerHangupOutcome: "accepted", sessionConfirmedClosed: true, providerCallDisconnected: true }, "caller_finished", "voice")).toBe("caller_finished");
    expect(actualLiveCallEnd({ closeReason: "remote_hangup", providerHangupOutcome: "not_requested", sessionConfirmedClosed: true, providerCallDisconnected: true }, "caller_finished", "voice")).toBe("caller_hung_up");
  });

  it("recovers trusted Caller ID from the tenant-scoped call record when SIP does not provide a valid number", async () => {
    vi.stubEnv("LIVE_PROTOTYPE_ENABLED", "true");
    vi.stubEnv("INTERNAL_SERVICE_TOKEN", "token");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    mocks.snapshot.mockResolvedValue({ businessId: "biz_1", greeting: "Hi" });
    mocks.loadCaller.mockResolvedValue({ startedAt: new Date(), callerPhone: "+14165550100" });
    const handler = createLiveCallHandler({ domain: { db: {} as never } });
    await handler.handle(attachRequest({ sessionId: "live_caller_id", businessId: "biz_1", callId: "call_caller_id", channel: "voice" }), response());
    expect(mocks.loadCaller).toHaveBeenCalledWith({ db: {} }, { businessId: "biz_1", callId: "call_caller_id" });
    expect(mocks.createAgent).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ callerPhone: "+14165550100" }) }));
  });

  it("opens one sideband when two attaches for a session overlap", async () => {
    vi.stubEnv("LIVE_PROTOTYPE_ENABLED", "true");
    vi.stubEnv("INTERNAL_SERVICE_TOKEN", "token");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    let release!: (value: unknown) => void;
    mocks.snapshot.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const handler = createLiveCallHandler({ domain: { db: {} as never } });
    const body = { sessionId: "live_1", businessId: "biz_1", callId: "call_1", channel: "voice" };
    const first = handler.handle(attachRequest(body), response());
    const second = handler.handle(attachRequest(body), response());
    await new Promise((resolve) => setTimeout(resolve, 10));
    release({ businessId: "biz_1", greeting: "Hi" });
    await Promise.all([first, second]);
    expect(mocks.controllers).toBe(1);
    expect(handler.activeCalls()).toBe(1);
  });

  it("does not acknowledge attach until controller startup has succeeded", async () => {
    vi.stubEnv("LIVE_PROTOTYPE_ENABLED", "true");
    vi.stubEnv("INTERNAL_SERVICE_TOKEN", "token");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    mocks.snapshot.mockResolvedValue({ businessId: "biz_1", greeting: "Hi" });
    let release!: () => void;
    mocks.controllerStart.mockReturnValueOnce(new Promise<undefined>((resolve) => { release = () => resolve(undefined); }));
    const handler = createLiveCallHandler({ domain: { db: {} as never } });
    const res = response();
    const attachBody = { sessionId: "live_ready", businessId: "biz_1", callId: "call_ready", channel: "voice" };
    const pending = handler.handle(attachRequest(attachBody), res);
    await vi.waitFor(() => expect(mocks.controllers).toBeGreaterThan(0));
    const duplicateResponse = response();
    const duplicate = handler.handle(attachRequest(attachBody), duplicateResponse);
    await Promise.resolve();
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(duplicateResponse.writeHead).not.toHaveBeenCalled();
    release();
    await Promise.all([pending, duplicate]);
    expect(res.writeHead).toHaveBeenCalledWith(202, { "content-type": "application/json" });
    expect(duplicateResponse.writeHead).toHaveBeenCalledWith(202, { "content-type": "application/json" });
  });

  it("cancels sideband startup when the Admin attach request disconnects", async () => {
    vi.stubEnv("LIVE_PROTOTYPE_ENABLED", "true");
    vi.stubEnv("INTERNAL_SERVICE_TOKEN", "token");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    mocks.snapshot.mockResolvedValue({ businessId: "biz_1", greeting: "Hi" });
    let failStartup!: () => void;
    mocks.controllerStart.mockReturnValueOnce(new Promise<undefined>((_resolve, reject) => { failStartup = () => reject(new mocks.StartupError("sideband_connection_failed", "attach_request_cancelled")); }));
    mocks.controllerCancel.mockImplementationOnce(() => failStartup());
    const handler = createLiveCallHandler({ domain: { db: {} as never } });
    const res = response() as ServerResponse & { emitClose: () => void };
    const pending = handler.handle(attachRequest({ sessionId: "live_cancelled", businessId: "biz_1", callId: "call_cancelled", channel: "voice" }), res);
    await vi.waitFor(() => expect(mocks.controllers).toBeGreaterThan(0));
    res.emitClose();
    await pending;
    expect(mocks.controllerCancel).toHaveBeenCalledOnce();
    expect(handler.activeCalls()).toBe(0);
  });

  it("returns a retryable startup failure instead of accepting a silent call", async () => {
    vi.stubEnv("LIVE_PROTOTYPE_ENABLED", "true");
    vi.stubEnv("INTERNAL_SERVICE_TOKEN", "token");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    mocks.snapshot.mockResolvedValue({ businessId: "biz_1", greeting: "Hi" });
    mocks.controllerStart.mockRejectedValueOnce(new mocks.StartupError("greeting_start_failed", "greeting_audio_timeout"));
    const handler = createLiveCallHandler({ domain: { db: {} as never } });
    const res = response();
    await handler.handle(attachRequest({ sessionId: "live_silent", businessId: "biz_1", callId: "call_silent", channel: "voice" }), res);
    expect(res.writeHead).toHaveBeenCalledWith(503, { "content-type": "application/json" });
    expect(handler.activeCalls()).toBe(0);
  });
});

describe("live call latency telemetry", () => {
  async function startCall() {
    vi.stubEnv("LIVE_PROTOTYPE_ENABLED", "true");
    vi.stubEnv("INTERNAL_SERVICE_TOKEN", "token");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    mocks.snapshot.mockResolvedValue({ businessId: "biz_1", greeting: "Hi" });
    mocks.recordProductEvent.mockClear();
    const handler = createLiveCallHandler({ domain: { db: {} as never } });
    await handler.handle(attachRequest({ sessionId: "live_2", businessId: "biz_1", callId: "call_2", channel: "web_voice", conversationId: "conv_2", callerPhone: "+14165550100" }), response());
    return mocks.controllerOptions.at(-1)!;
  }

  const delegation = { delegationId: "del_1", offsetMs: 4_000, transcriptWaitMs: 12, agentMs: 1_800, totalMs: 1_812, tools: ["getBusinessHours", "getBusinessHours"], answer: "We're open until 5.", failed: false };

  it("records voice.delegation_completed with timings and tool names only", async () => {
    const options = await startCall();
    options.onDelegation!(delegation as never);

    expect(mocks.recordProductEvent).toHaveBeenCalledWith({ db: {} }, {
      name: "voice.delegation_completed",
      businessId: "biz_1",
      distinctId: "system:business:biz_1",
      actorType: "worker",
      properties: { callId: "call_2", channel: "web_voice", provider: "openai_live", conversationId: "conv_2", agentMs: 1_800, totalMs: 1_812, tools: ["getBusinessHours"], toolCount: 2, failed: false },
    });
    expect(JSON.stringify(mocks.recordProductEvent.mock.calls)).not.toMatch(/open until|4165550100/);
  });

  it("records one voice.call_latency_recorded summary when the call closes", async () => {
    mocks.finishLiveCall.mockResolvedValueOnce(true);
    const options = await startCall();
    options.onClose!({
      sessionId: "live_2",
      durationMs: 60_000,
      delegations: [delegation, { ...delegation, delegationId: "del_2", totalMs: 3_000, failed: true }, { ...delegation, delegationId: "del_3", totalMs: 900 }],
      latency: { firstSpeechMs: 1_100, greetedFirst: true, answerGapsMs: [700, 400, 2_500, 900], speechSource: "audio" },
    } as never);
    await vi.waitFor(() => expect(mocks.finishLiveCall).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.recordProductEvent).toHaveBeenCalledWith({ db: {} }, expect.objectContaining({
      name: "voice.call_latency_recorded",
      businessId: "biz_1",
      properties: {
        callId: "call_2",
        channel: "web_voice",
        provider: "openai_live",
        conversationId: "conv_2",
        greetingMs: 1_100,
        firstSpeechMs: 1_100,
        greetedFirst: true,
        speechTimingSource: "audio",
        answerCount: 4,
        answerP50Ms: 700,
        answerP90Ms: 2_500,
        answerMaxMs: 2_500,
        delegationCount: 3,
        delegationFailedCount: 1,
        delegationP50TotalMs: 1_812,
        delegationMaxTotalMs: 3_000,
        durationMs: 60_000,
      },
    }));
  });

  it("skips the latency summary when a late re-attach finds the call already finished", async () => {
    mocks.finishLiveCall.mockResolvedValueOnce(false);
    const options = await startCall();
    options.onClose!({ sessionId: "live_2", durationMs: 1_000, delegations: [] } as never);
    await vi.waitFor(() => expect(mocks.finishLiveCall).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.recordProductEvent).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: "voice.call_latency_recorded" }));
  });

  it("never lets a telemetry failure reach the call", async () => {
    mocks.finishLiveCall.mockResolvedValueOnce(true);
    const options = await startCall();
    mocks.recordProductEvent.mockRejectedValueOnce(new Error("database unavailable"));
    mocks.recordProductEvent.mockImplementationOnce(() => { throw new Error("database unavailable"); });
    expect(() => options.onDelegation!(delegation as never)).not.toThrow();
    expect(() => options.onClose!({ sessionId: "live_2", durationMs: 1_000, delegations: [] } as never)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe("providerSeconds", () => {
  it("uses the seconds OpenAI reported", () => {
    expect(providerSeconds({ billedSeconds: 42, durationMs: 41_000 }, "web_voice")).toBe(42);
    expect(providerSeconds({ billedSeconds: 15, durationMs: 800 }, "web_voice")).toBe(15);
  });

  it("assumes OpenAI's 15-second WebRTC minimum when the report never arrived", () => {
    expect(providerSeconds({ durationMs: 5_472 }, "web_voice")).toBe(15);
    expect(providerSeconds({ durationMs: 90_000 }, "web_voice")).toBe(90);
  });

  it("uses the measured length for a phone call without a report", () => {
    expect(providerSeconds({ durationMs: 5_472 }, "voice")).toBe(5.472);
  });
});

describe("parseAttachRequest", () => {
  it("keeps only the fields the worker trusts", () => {
    expect(parseAttachRequest(JSON.stringify({ sessionId: "live_1", businessId: "biz_1", callId: "call_1", channel: "web_voice", intakeOnly: "yes", maxDurationMs: -1 })))
      .toEqual({ sessionId: "live_1", businessId: "biz_1", callId: "call_1", channel: "web_voice" });
  });
});
