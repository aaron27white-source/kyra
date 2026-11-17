import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { buildPhoneSessionConfig } from "@lobbystack/agent-core/live/session";
import { finishLiveCall, getCachedBusinessSnapshot, loadCallbackContext, resolveMissedCallCallback, startLivePhoneCall } from "@lobbystack/domain";
import { ASSISTANT_NAME, isPilotMode } from "@lobbystack/shared";
import type { BusinessContextSnapshot } from "@lobbystack/shared";
import { getAppDatabase } from "@/lib/api-helpers";
import { createWorkerDomainContext } from "@/lib/domain-context";
import { attachWorkerToLiveSession, getLiveClient } from "@/lib/live-prototype";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// SIP "To"/"From" headers look like `<sip:+15551234567@host>`, `"Name" <sip:...>`
// or `tel:+1555...`. Carriers sometimes drop the "+", so restore it.
function phoneFromSipHeader(value: string | undefined): string | undefined {
  const digits = value?.match(/(?:sip|tel):(\+?\d{6,15})\b/)?.[1];
  if (!digits) return undefined;
  return digits.startsWith("+") ? digits : `+${digits.length === 10 ? `1${digits}` : digits}`;
}

// OpenAI calls this when Twilio routes a call to our project's SIP endpoint.
// We pick the business from the dialled number, accept with client delegation,
// and hand the session to the worker.
export async function POST(request: Request) {
  if (process.env.LIVE_PROTOTYPE_ENABLED !== "true") return new NextResponse(null, { status: 404 });
  const client = getLiveClient();
  let event;
  try {
    event = await client.webhooks.unwrap(await request.text(), request.headers);
  } catch {
    return new NextResponse("Invalid signature.", { status: 400 });
  }
  if (event.type !== "live.transport.incoming") return new NextResponse(null, { status: 200 });

  const sessionId = event.data.session_id;
  const header = (name: string) => event.data.sip_headers.find((item) => item.name.toLowerCase() === name)?.value;
  // Kyra AI callback: our own outbound call, bridged to OpenAI with an opaque
  // token header. The token (not any number) decides the business.
  const callbackToken = header("x-key20-callback");
  if (callbackToken) {
    const domain = createWorkerDomainContext();
    const callback = await resolveMissedCallCallback(domain, callbackToken).catch(() => null);
    if (!callback) {
      await client.live.sessions.reject(sessionId, { status_code: 404 }).catch(() => undefined);
      return new NextResponse(null, { status: 200 });
    }
    try {
      const [snapshot, context] = await Promise.all([getCachedBusinessSnapshot(domain, { businessId: callback.businessId }), loadCallbackContext(domain, callback)]);
      if (!snapshot || !context) {
        await client.live.sessions.reject(sessionId, { status_code: 503 });
        return new NextResponse(null, { status: 200 });
      }
      const greetingOverride = `Hi, this is ${ASSISTANT_NAME}, the virtual receptionist for ${snapshot.displayName}, returning your call. This call may be recorded. How can I help?`;
      return await answerCall(client, { sessionId, businessId: callback.businessId, snapshot, from: context.callerPhone, to: phoneFromSipHeader(header("from")) ?? "callback", greetingOverride });
    } catch {
      console.error(JSON.stringify({ event: "live.setup.failed", operation: "callback_setup", reason: "call_setup_failed", sessionId, businessId: callback.businessId }));
      await client.live.sessions.reject(sessionId, { status_code: 503 }).catch(() => undefined);
      return new NextResponse(null, { status: 200 });
    }
  }
  // Twilio trunks rewrite "To" to our OpenAI SIP URI and keep the dialled
  // number in "Diversion".
  const to = phoneFromSipHeader(header("diversion")) ?? phoneFromSipHeader(header("to"));
  const from = phoneFromSipHeader(header("from"));
  // Only the dialled-number headers: "From" is the caller's own number.
  const routingHeaderNames = event.data.sip_headers.filter((item) => ["to", "diversion", "p-called-party-id"].includes(item.name.toLowerCase())).map((item) => item.name.toLowerCase());
  if (!to) {
    // No deployment can route a call without a dialled number.
    console.warn(JSON.stringify({ event: "live.inbound.rejected", reason: "missing_dialled_number", sessionId, routingHeaderNames }));
    await client.live.sessions.reject(sessionId, { status_code: 404 }).catch(() => undefined);
    return new NextResponse(null, { status: 200 });
  }

  // Staging and production share one OpenAI project, so OpenAI sends every
  // incoming call to both. Only the deployment that owns the number may accept
  // or reject it; until ownership is known, this deployment leaves the call alone.
  let businessId: string | null | undefined;
  try {
    const resolved = isPilotMode(process.env)
      ? await getAppDatabase().db.execute<{ business_id: string | null }>(sql`select app.resolve_lmc_live_business_by_phone(${to}) as business_id`)
      : await getAppDatabase().db.execute<{ business_id: string | null }>(sql`select app.resolve_business_by_phone(${to}) as business_id`);
    businessId = resolved.rows[0]?.business_id;
  } catch {
    // Ownership is unknown: don't reject a call that may belong to the other
    // deployment. A 503 makes OpenAI deliver the event again.
    console.error(JSON.stringify({ event: "live.inbound.lookup_failed", reason: "tenant_resolution_unavailable", sessionId }));
    return new NextResponse(null, { status: 503 });
  }
  if (!businessId) {
    console.info(JSON.stringify({ event: "live.inbound.ignored", reason: "number_not_enabled_here", sessionId, routingHeaderNames }));
    return new NextResponse(null, { status: 200 });
  }

  try {
    const snapshot = await getCachedBusinessSnapshot(createWorkerDomainContext(), { businessId });
    if (!snapshot) {
      console.warn(JSON.stringify({ event: "live.inbound.rejected", reason: "snapshot_unavailable", sessionId, businessId }));
      await client.live.sessions.reject(sessionId, { status_code: 503 });
      return new NextResponse(null, { status: 200 });
    }
    return await answerCall(client, { sessionId, businessId, snapshot, from, to });
  } catch {
    console.error(JSON.stringify({ event: "live.setup.failed", operation: "inbound_setup", reason: "call_setup_failed", sessionId, businessId }));
    await client.live.sessions.reject(sessionId, { status_code: 503 }).catch(() => undefined);
    return new NextResponse(null, { status: 200 });
  }
}

type LiveClient = ReturnType<typeof getLiveClient>;

function safeProviderError(error: unknown): { status?: number; code?: string; requestId?: string } {
  if (!error || typeof error !== "object") return {};
  const value = error as { status?: unknown; code?: unknown; errorCode?: unknown; requestId?: unknown; request_id?: unknown };
  const code = value.code ?? value.errorCode;
  const requestId = value.requestId ?? value.request_id;
  return {
    ...(typeof value.status === "number" && Number.isInteger(value.status) ? { status: value.status } : {}),
    ...(typeof code === "string" && /^[a-z0-9_.-]{1,80}$/i.test(code) ? { code } : {}),
    ...(typeof requestId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(requestId) ? { requestId } : {}),
  };
}

function logSetupFailure(reason: string, input: { sessionId: string; businessId: string }, error?: unknown, operation = reason): void {
  console.error(JSON.stringify({ event: "live.setup.failed", operation, reason, ...input, ...safeProviderError(error) }));
}

async function hangupAfterSetupFailure(client: LiveClient, input: { sessionId: string; businessId: string }, reason: string): Promise<void> {
  console.info(JSON.stringify({ event: "live.provider_hangup.requested", ...input, reason, transport: "sip" }));
  try {
    await client.live.sessions.hangup(input.sessionId);
    console.info(JSON.stringify({ event: "live.provider_hangup.accepted", ...input, reason, transport: "sip" }));
  } catch (error) {
    logSetupFailure("provider_hangup_failed", input, error, "provider_hangup");
  }
}

// Reserves minutes and records the call before accepting it, the same way the
// Twilio media path does, so billing and limits behave identically.
async function answerCall(client: LiveClient, input: { sessionId: string; businessId: string; snapshot: BusinessContextSnapshot; from: string | undefined; to: string; greetingOverride?: string }) {
  const domain = createWorkerDomainContext();
  let call: Awaited<ReturnType<typeof startLivePhoneCall>>;
  try {
    call = await startLivePhoneCall(domain, { businessId: input.businessId, sessionId: input.sessionId, from: input.from ?? "unknown", to: input.to });
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "voice_limit_reached") {
      // 486 Busy Here: the caller hears a busy signal rather than an answer
      // the business can't pay for.
      await client.live.sessions.reject(input.sessionId, { status_code: 486 });
      return new NextResponse(null, { status: 200 });
    }
    throw error;
  }
  // Never revive an already finalized call record on webhook redelivery.
  if (call.duplicate && call.ended) {
    console.info(JSON.stringify({ event: "live.setup.duplicate_ignored", reason: "call_already_ended", sessionId: input.sessionId, businessId: input.businessId }));
    await client.live.sessions.reject(input.sessionId, { status_code: 486 }).catch(() => undefined);
    return new NextResponse(null, { status: 200 });
  }
  if (call.blocked) {
    await client.live.sessions.reject(input.sessionId, { status_code: 603 });
    // Closes the record so the minute reservation doesn't stay open.
    await finishLiveCall(domain, { businessId: input.businessId, callId: call.callId, seconds: 0, end: "blocked_contact" });
    return new NextResponse(null, { status: 200 });
  }
  // On retry, accept may fail because OpenAI already accepted the session. The
  // awaited worker attach is authoritative: it returns success only after a
  // live sideband and first output audio are established.
  let accepted = false;
  if (!call.duplicate) {
    try {
      await client.live.sessions.accept(input.sessionId, { session: buildPhoneSessionConfig(input.snapshot) });
      accepted = true;
    } catch (error) {
      logSetupFailure("openai_session_accept_failed", { sessionId: input.sessionId, businessId: input.businessId }, error, "session_accept");
      await hangupAfterSetupFailure(client, { sessionId: input.sessionId, businessId: input.businessId }, "setup_failed");
      await finishLiveCall(domain, { businessId: input.businessId, callId: call.callId, seconds: 0, end: "setup_failed" }).catch((finalizeError) => logSetupFailure("setup_failure_finalize_failed", { sessionId: input.sessionId, businessId: input.businessId }, finalizeError, "call_finalize"));
      throw error;
    }
  } else {
    try {
      await client.live.sessions.accept(input.sessionId, { session: buildPhoneSessionConfig(input.snapshot) });
      accepted = true;
    } catch {
      console.info(JSON.stringify({ event: "live.session.accept_retry_skipped", reason: "duplicate_delivery", sessionId: input.sessionId, businessId: input.businessId }));
    }
  }
  if (accepted) console.info(JSON.stringify({ event: "live.session.accepted", sessionId: input.sessionId, businessId: input.businessId }));
  try {
    await attachWorkerToLiveSession({ sessionId: input.sessionId, businessId: input.businessId, callId: call.callId, conversationId: call.conversationId, channel: "voice", ...(input.from ? { callerPhone: input.from } : {}), ...(input.greetingOverride ? { greetingOverride: input.greetingOverride } : {}) });
  } catch (error) {
    // Without the worker nobody answers delegations, so end the call cleanly.
    const attach = error && typeof error === "object" && "reason" in error && typeof error.reason === "string" ? error.reason : undefined;
    logSetupFailure(attach ?? "worker_attach_failed", { sessionId: input.sessionId, businessId: input.businessId }, error, "worker_attach");
    await hangupAfterSetupFailure(client, { sessionId: input.sessionId, businessId: input.businessId }, attach ?? "worker_attach_failed");
    await finishLiveCall(domain, { businessId: input.businessId, callId: call.callId, seconds: 0, end: "setup_failed" }).catch((finalizeError) => logSetupFailure("setup_failure_finalize_failed", { sessionId: input.sessionId, businessId: input.businessId }, finalizeError, "call_finalize"));
    throw error;
  }
  return new NextResponse(null, { status: 200 });
}
