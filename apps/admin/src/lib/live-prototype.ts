import { randomUUID } from "node:crypto";
import OpenAI from "openai";

import { jsonError } from "./api-helpers";

type WorkerAttachInput = { sessionId: string; businessId: string; callId: string; channel: "voice" | "web_voice"; conversationId?: string; callerPhone?: string; maxDurationMs?: number; intakeOnly?: boolean; greetingOverride?: string };

let client: OpenAI | undefined;

export function requireLivePrototype(): void {
  if (process.env.LIVE_PROTOTYPE_ENABLED !== "true") throw jsonError("The GPT-Live prototype is off.", 404, "live_prototype_disabled");
}

export function getLiveClient(): OpenAI {
  if (!process.env.OPENAI_API_KEY) throw jsonError("OPENAI_API_KEY is not set.", 503, "openai_unconfigured");
  client ??= new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    maxRetries: 0,
    ...(process.env.OPENAI_WEBHOOK_SECRET ? { webhookSecret: process.env.OPENAI_WEBHOOK_SECRET } : {}),
  });
  return client;
}

function workerUrl(): string {
  return process.env.WORKER_INTERNAL_URL ?? `http://127.0.0.1:${process.env.WORKER_PORT ?? 3002}`;
}

// OpenAI replays only the last 3 seconds to a late sideband, so the worker must
// attach right after the session exists. This is a direct call, not a queued job.
export async function attachWorkerToLiveSession(input: WorkerAttachInput): Promise<void> {
  const token = process.env.INTERNAL_SERVICE_TOKEN;
  if (!token) throw new Error("INTERNAL_SERVICE_TOKEN is not set.");
  const requestId = randomUUID();
  let response: Response;
  try {
    response = await fetch(`${workerUrl()}/internal/live/attach`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-service-token": token, "x-request-id": requestId },
      body: JSON.stringify(input),
      // A sleeping staging worker needs a few seconds to wake.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    const timedOut = cause instanceof Error && cause.name === "TimeoutError";
    const error = new Error("Worker attach request did not complete.") as Error & { requestId: string; reason: string; code?: string };
    error.requestId = requestId;
    error.reason = "worker_attach_transport_failed";
    if (timedOut) error.code = "worker_attach_timeout";
    throw error;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: unknown; reason?: unknown; errorCode?: unknown } | null;
    const reason = typeof body?.reason === "string" && /^[a-z0-9_.-]{1,80}$/i.test(body.reason) ? body.reason : "worker_attach_rejected";
    const error = new Error("Worker attach failed.") as Error & { status: number; requestId: string; reason: string };
    error.status = response.status;
    error.requestId = requestId;
    error.reason = reason;
    const code = typeof body?.errorCode === "string" && /^[a-z0-9_.-]{1,80}$/i.test(body.errorCode) ? body.errorCode : undefined;
    if (code) Object.assign(error, { code });
    throw error;
  }
}
