import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createAgentModel, createReceptionistAgent, LiveCallController, LiveCallStartupError, type AgentChannel, type CallControl, type LiveCallSummary } from "@lobbystack/agent-core";
import {
  blockLiveCaller,
  finishLiveCall,
  getCachedBusinessSnapshot,
  loadLiveCallForPricing,
  markLiveCallMediaStarted,
  persistCallRecording,
  prepareLiveCallTransfer,
  recordLiveCallTransferResult,
  saveLiveCallTurn,
  type BinaryStorageProvider,
  type DomainContext,
  type LiveCallEnd,
} from "@lobbystack/domain";
import { renewVoicePresenceGateway, updateVoicePresence } from "@lobbystack/jobs";
import OpenAI from "openai";

import { recordLiveCallLatency, recordLiveDelegation } from "./liveCallTelemetry";

export const LIVE_ATTACH_PATH = "/internal/live/attach";
const MAX_BODY_BYTES = 16 * 1024;

/** Where the call came from: a phone number (SIP) or a browser (WebRTC). */
type LiveChannel = Extract<AgentChannel, "voice" | "web_voice">;

type AttachRequest = {
  sessionId: string;
  businessId: string;
  callId: string;
  channel: LiveChannel;
  /** The call's own conversation, where messages taken on the call are filed. */
  conversationId?: string;
  callerPhone?: string;
  /** Browser calls stop here; it comes from the plan's remaining minutes. */
  maxDurationMs?: number;
  /** Prospect demos only answer questions and take messages. */
  intakeOnly?: boolean;
  /** Kyra callbacks open with "returning your call" instead of the inbound greeting. */
  greetingOverride?: string;
};

const SILENCE_TIMEOUT_MS = 75_000;
const MAX_PHONE_CALL_MS = 30 * 60_000;
const PRESENCE_INTERVAL_MS = 10_000;
// OpenAI finalizes the stored recording shortly after the session closes.
const RECORDING_ATTEMPTS = 12;
const RECORDING_RETRY_MS = 5_000;

// OpenAI bills 15 seconds when it creates a WebRTC session and credits it
// against talk time once the session runs, so a browser call never costs less.
const WEBRTC_MINIMUM_SECONDS = 15;

/**
 * The seconds OpenAI bills for a call. OpenAI reports them when the session
 * closes; if the sideband dropped first we only have our own measurement.
 */
export function providerSeconds(summary: Pick<LiveCallSummary, "billedSeconds" | "durationMs">, channel: LiveChannel): number {
  if (summary.billedSeconds !== undefined) return summary.billedSeconds;
  const measured = summary.durationMs / 1000;
  return channel === "web_voice" ? Math.max(WEBRTC_MINIMUM_SECONDS, measured) : measured;
}

function endFromCloseReason(reason: string | undefined): LiveCallEnd {
  switch (reason) {
    case "close_requested": return "caller_finished";
    case "remote_hangup": return "caller_hung_up";
    case "expired": return "session_expired";
    case "content": return "content_blocked";
    default: return "connection_lost";
  }
}

export function actualLiveCallEnd(summary: Pick<LiveCallSummary, "closeReason" | "sessionConfirmedClosed" | "providerHangupOutcome" | "providerCallDisconnected">, requestedEnd: LiveCallEnd | undefined, channel: LiveChannel): LiveCallEnd {
  if (requestedEnd === "transferred") return "transferred";
  if (summary.closeReason === "remote_hangup") return "caller_hung_up";
  if (summary.closeReason === "expired") return "session_expired";
  if (summary.closeReason === "content") return "content_blocked";
  if (!summary.sessionConfirmedClosed) return "connection_lost";
  if (channel === "voice" && !summary.providerCallDisconnected) return "connection_lost";
  if (summary.closeReason === "close_requested" && summary.providerHangupOutcome === "accepted") return requestedEnd ?? "caller_finished";
  return endFromCloseReason(summary.closeReason);
}

export function isLivePrototypeEnabled(): boolean {
  return process.env.LIVE_PROTOTYPE_ENABLED === "true";
}

function tokenMatches(presented: string | undefined): boolean {
  const expected = process.env.INTERNAL_SERVICE_TOKEN;
  if (!expected || !presented) return false;
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readBody(request: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function parseAttachRequest(raw: string): AttachRequest | undefined {
  const body = JSON.parse(raw) as Partial<AttachRequest>;
  if (typeof body.sessionId !== "string" || typeof body.businessId !== "string" || typeof body.callId !== "string") return undefined;
  if (body.channel !== "voice" && body.channel !== "web_voice") return undefined;
  return {
    sessionId: body.sessionId,
    businessId: body.businessId,
    callId: body.callId,
    channel: body.channel,
    ...(typeof body.conversationId === "string" ? { conversationId: body.conversationId } : {}),
    ...(typeof body.callerPhone === "string" ? { callerPhone: body.callerPhone } : {}),
    ...(typeof body.maxDurationMs === "number" && body.maxDurationMs > 0 ? { maxDurationMs: body.maxDurationMs } : {}),
    ...(body.intakeOnly === true ? { intakeOnly: true } : {}),
    ...(typeof body.greetingOverride === "string" && body.greetingOverride.trim() ? { greetingOverride: body.greetingOverride.trim().slice(0, 400) } : {}),
  };
}

function reply(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function safeCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[a-z0-9_.-]{1,80}$/i.test(code) ? code : undefined;
}

function logError(sessionId: string, operation: string) {
  return (error: unknown) => console.error(JSON.stringify({
    event: "live.worker.operation_failed",
    sessionId,
    operation,
    ...(safeCode(error) ? { errorCode: safeCode(error) } : {}),
  }));
}

/**
 * Holds every GPT-Live call this worker is running. Next.js records the call
 * and creates or accepts the OpenAI session, then calls this endpoint so the
 * worker holds the sideband for the rest of the call.
 */
export function createLiveCallHandler(input: { domain: DomainContext }) {
  const active = new Map<string, { request: AttachRequest; controller: LiveCallController }>();
  // Sessions whose attach is still loading, so an overlapping duplicate attach
  // doesn't open a second sideband that would answer the same delegations.
  const starting = new Map<string, Promise<void>>();
  // Call records still being finalized, so shutdown can wait for them.
  const finishing = new Set<Promise<void>>();
  const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 }) : undefined;
  const model = createAgentModel();
  // The dashboard's live-call count trusts a call only while its owner renews
  // this id, so a crashed worker's calls stop counting.
  const presenceOwner = `worker:${randomUUID()}`;
  let storage: BinaryStorageProvider | undefined;
  let presenceTimer: ReturnType<typeof setInterval> | undefined;

  function setPresence(request: AttachRequest, isActive: boolean): void {
    void updateVoicePresence({ businessId: request.businessId, callId: request.callId, active: isActive, gatewayId: presenceOwner }).catch(logError(request.sessionId, "presence update failed"));
  }

  // The dashboard shows "unavailable" rather than 0 unless some owner has a
  // fresh heartbeat, so renew it even with no calls running.
  function renewPresence(): void {
    void renewVoicePresenceGateway(presenceOwner).catch(logError("-", "presence renewal failed"));
    for (const { request } of active.values()) setPresence(request, true);
  }
  if (isLivePrototypeEnabled() && process.env.REDIS_URL) {
    presenceTimer = setInterval(renewPresence, PRESENCE_INTERVAL_MS);
    presenceTimer.unref();
    renewPresence();
  }

  // Copies OpenAI's stored stereo recording into our storage so it follows the
  // plan's retention like every other call recording.
  async function saveRecording(request: AttachRequest, durationMs: number): Promise<void> {
    if (!client || !storage) return;
    for (let attempt = 1; attempt <= RECORDING_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, RECORDING_RETRY_MS));
      try {
        const response = await client.live.sessions.downloadRecording(request.sessionId);
        const body = new Uint8Array(await response.arrayBuffer());
        await persistCallRecording(input.domain, { businessId: request.businessId, callId: request.callId, durationMs, contentType: "audio/wav", body }, storage);
        return;
      } catch (error) {
        const status = typeof error === "object" && error !== null && "status" in error ? (error as { status?: number }).status : undefined;
        // 404/409 mean it isn't ready yet; anything else won't get better.
        if (status !== 404 && status !== 409) return logError(request.sessionId, "recording unavailable")(error);
      }
    }
    console.warn(JSON.stringify({ event: "live.recording.unavailable", sessionId: request.sessionId, reason: "not_ready" }));
  }

  async function attach(request: AttachRequest, signal?: AbortSignal): Promise<void> {
    if (!client || !model) throw new Error("OPENAI_API_KEY and a text model are required for live calls.");
    if (signal?.aborted) throw new LiveCallStartupError("sideband_connection_failed", "attach_request_cancelled");
    const pending = starting.get(request.sessionId);
    if (pending) return pending;
    if (active.has(request.sessionId)) return;
    const startup = startCall(request, client, model, signal);
    starting.set(request.sessionId, startup);
    try {
      await startup;
    } finally {
      if (starting.get(request.sessionId) === startup) starting.delete(request.sessionId);
    }
  }

  async function startCall(request: AttachRequest, client: OpenAI, model: NonNullable<ReturnType<typeof createAgentModel>>, signal?: AbortSignal): Promise<void> {
    const snapshot = await getCachedBusinessSnapshot(input.domain, { businessId: request.businessId });
    if (!snapshot) throw new Error("The business has no published snapshot.");
    if (signal?.aborted) throw new LiveCallStartupError("sideband_connection_failed", "attach_request_cancelled");
    const phone = request.channel === "voice";
    const call = { businessId: request.businessId, callId: request.callId };
    const requestPhoneIsValid = typeof request.callerPhone === "string" && /^\+[1-9]\d{7,14}$/.test(request.callerPhone);
    const callRecordPhone = phone && !requestPhoneIsValid ? (await loadLiveCallForPricing(input.domain, call))?.callerPhone : undefined;
    const callerPhone = requestPhoneIsValid ? request.callerPhone : callRecordPhone ?? request.callerPhone;
    if (callRecordPhone && !requestPhoneIsValid) console.info(JSON.stringify({ event: "live.caller_id.recovered_from_call_record", businessId: request.businessId, callId: request.callId, sessionId: request.sessionId }));
    const telemetryCall = { ...call, channel: request.channel, ...(request.conversationId ? { conversationId: request.conversationId } : {}) };
    let end: LiveCallEnd | undefined;
    let controller: LiveCallController | undefined;

    const hangup = async () => {
      // SIP calls hang up at the provider; closing the session ends a browser call.
      if (phone) {
        await client.live.sessions.hangup(request.sessionId);
        return "provider" as const;
      }
      controller?.endSession();
      return "session" as const;
    };

    const callControl: CallControl = {
      hangup: async (reason) => {
        end = reason;
        if (reason === "abuse" && phone) await blockLiveCaller(input.domain, call);
        controller?.requestEndCall(reason);
      },
      ...(phone ? {
        transfer: async (destination: string) => {
          if (!(await prepareLiveCallTransfer(input.domain, call))) return false;
          try {
            await client.live.sessions.refer(request.sessionId, { target_uri: `tel:${destination}` });
            end = "transferred";
            await recordLiveCallTransferResult(input.domain, { ...call, ok: true });
            return true;
          } catch (error) {
            logError(request.sessionId, "transfer failed")(error);
            await recordLiveCallTransferResult(input.domain, { ...call, ok: false });
            return false;
          }
        },
      } : {}),
    };

    const agent = createReceptionistAgent({
      model,
      context: {
        domain: input.domain,
        snapshot,
        channel: request.channel,
        callId: request.callId,
        sessionId: request.sessionId,
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
        callControl,
        ...(callerPhone ? { callerPhone } : {}),
        ...(request.intakeOnly ? { intakeOnly: true } : {}),
      },
    });

    const finish = async (summary: LiveCallSummary) => {
      const seconds = providerSeconds(summary, request.channel);
      const measuredSeconds = summary.durationMs / 1000;
      const actualEnd = actualLiveCallEnd(summary, end, request.channel);
      const completed = await finishLiveCall(input.domain, { ...call, seconds, measuredSeconds, end: actualEnd, channel: request.channel });
      // Only the attach that finished the call keeps its recording and reports
      // its latency, so a late retry that re-attaches to an ended call doesn't
      // copy the recording or record the call's latency twice.
      if (!completed) return;
      recordLiveCallLatency(input.domain, telemetryCall, summary);
      void saveRecording(request, measuredSeconds * 1000);
    };

    controller = new LiveCallController({
      client,
      sessionId: request.sessionId,
      callId: request.callId,
      channel: request.channel,
      agent,
      greeting: request.greetingOverride ?? snapshot.greeting,
      silenceTimeoutMs: SILENCE_TIMEOUT_MS,
      maxDurationMs: phone ? MAX_PHONE_CALL_MS : request.maxDurationMs ?? MAX_PHONE_CALL_MS,
      onStarted: () => void markLiveCallMediaStarted(input.domain, call).catch(logError(request.sessionId, "media start not recorded")),
      onTurn: (turn) => void saveLiveCallTurn(input.domain, { ...call, ...turn }).catch(logError(request.sessionId, "transcript save failed")),
      onTimeout: (reason) => {
        end = reason;
        controller?.endCallNow(reason);
      },
      onEndIntent: (reason, source) => {
        end = reason;
        console.info(JSON.stringify({ event: "live.end_intent", businessId: request.businessId, callId: request.callId, sessionId: request.sessionId, reason, source }));
      },
      onHangup: async (reason) => {
        console.info(JSON.stringify({ event: "live.provider_hangup.requested", businessId: request.businessId, callId: request.callId, sessionId: request.sessionId, reason, transport: phone ? "sip" : "session" }));
        const transport = await hangup();
        console.info(JSON.stringify({ event: "live.provider_hangup.accepted", businessId: request.businessId, callId: request.callId, sessionId: request.sessionId, reason, transport }));
      },
      onDelegation: (timing) => {
        console.info(JSON.stringify({ event: "live.delegation", sessionId: request.sessionId, agentMs: timing.agentMs, totalMs: timing.totalMs, tools: timing.tools, failed: timing.failed }));
        recordLiveDelegation(input.domain, telemetryCall, timing);
      },
      onClose: (summary) => {
        active.delete(request.sessionId);
        setPresence(request, false);
        console.info(JSON.stringify({
          event: "live.closed",
          businessId: request.businessId,
          callId: request.callId,
          sessionId: summary.sessionId,
          channel: request.channel,
          durationMs: summary.durationMs,
          billedSeconds: summary.billedSeconds,
          end: actualLiveCallEnd(summary, end, request.channel),
          requestedEnd: end,
          closeReason: summary.closeReason,
          hangupState: summary.hangupState,
          hangupSource: summary.hangupSource,
          providerHangupOutcome: summary.providerHangupOutcome,
          sessionConfirmedClosed: summary.sessionConfirmedClosed,
          providerCallDisconnected: summary.providerCallDisconnected,
          delegations: summary.delegations.length,
        }));
        const pending = finish(summary).catch(logError(request.sessionId, "finish failed"));
        finishing.add(pending);
        void pending.finally(() => finishing.delete(pending));
      },
    });
    active.set(request.sessionId, { request, controller });
    setPresence(request, true);
    const cancelStartup = () => controller?.cancelStartup();
    signal?.addEventListener("abort", cancelStartup, { once: true });
    try {
      const startup = controller.start();
      if (signal?.aborted) cancelStartup();
      await startup;
      console.info(JSON.stringify({ event: "live.call.ready", sessionId: request.sessionId, businessId: request.businessId, channel: request.channel }));
    } catch (error) {
      active.delete(request.sessionId);
      setPresence(request, false);
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancelStartup);
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== LIVE_ATTACH_PATH || !isLivePrototypeEnabled()) return false;
    if (request.method !== "POST") {
      reply(response, 405, { error: "Method not allowed." });
      return true;
    }
    if (!tokenMatches(request.headers["x-internal-service-token"] as string | undefined)) {
      reply(response, 401, { error: "Unauthorized." });
      return true;
    }
    let attachIdentity: Pick<AttachRequest, "sessionId" | "businessId" | "callId"> | undefined;
    const requestIdValue = request.headers["x-request-id"];
    const requestId = typeof requestIdValue === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(requestIdValue) ? requestIdValue : undefined;
    const attachAbort = new AbortController();
    const onResponseClose = () => {
      if (!response.writableEnded) attachAbort.abort();
    };
    response.once("close", onResponseClose);
    try {
      const body = parseAttachRequest(await readBody(request));
      if (!body) {
        reply(response, 400, { error: "sessionId, businessId, callId and channel are required." });
        return true;
      }
      attachIdentity = body;
      console.info(JSON.stringify({ event: "live.attach.received", sessionId: body.sessionId, businessId: body.businessId, callId: body.callId, ...(requestId ? { requestId } : {}) }));
      await attach(body, attachAbort.signal);
      if (!response.destroyed && !response.writableEnded) reply(response, 202, { ok: true });
    } catch (error) {
      const startup = error instanceof LiveCallStartupError ? error : undefined;
      console.error(JSON.stringify({
        event: "live.attach.failed",
        operation: startup ? "controller_start" : "worker_attach",
        reason: startup ? startup.reason : "call_setup_failed",
        ...(startup?.errorCode ? { errorCode: startup.errorCode } : {}),
        ...(attachIdentity ? { sessionId: attachIdentity.sessionId, businessId: attachIdentity.businessId, callId: attachIdentity.callId } : {}),
        ...(requestId ? { requestId } : {}),
      }));
      if (!response.destroyed && !response.writableEnded) {
        reply(response, startup ? 503 : 500, {
          error: startup ? "voice_startup_failed" : "attach_failed",
          ...(startup ? { reason: startup.reason, ...(startup.errorCode ? { errorCode: startup.errorCode } : {}) } : {}),
        });
      }
    } finally {
      response.off("close", onResponseClose);
    }
    return true;
  }

  return {
    handle,
    setStorage: (provider: BinaryStorageProvider) => { storage = provider; },
    activeCalls: () => active.size,
    closeAll: async () => {
      if (presenceTimer) clearInterval(presenceTimer);
      // close() finishes synchronously, so every call is in `finishing` afterwards.
      const hangups = [...active.values()].map(({ controller }) => controller.close());
      await Promise.allSettled([...hangups, ...finishing]);
    },
  };
}
