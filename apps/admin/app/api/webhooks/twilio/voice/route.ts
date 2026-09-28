import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { recordMissedCall } from "@lobbystack/domain";
import { normalizeTwilioFormFields, resolveTwilioWebhookUrl, validateTwilioSignature } from "@lobbystack/shared";
import { getAppDatabase } from "@/lib/api-helpers";
import { createWorkerDomainContext } from "@/lib/domain-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A generic line if anything goes wrong: never leave a caller in silence.
const FALLBACK_GREETING = "Thanks for calling. Nobody can pick up right now. Please call back shortly.";

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[char]!));
}

function say(text: string): NextResponse {
  return new NextResponse(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna-Neural">${escapeXml(text)}</Say><Hangup/></Response>`, { status: 200, headers: { "content-type": "text/xml" } });
}

/**
 * Kyra Tier 1: a missed call forwarded from the business's own line. Twilio
 * signs the request; the business comes from the dialled number, never from
 * anything the caller controls.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  const params = normalizeTwilioFormFields(new URLSearchParams(rawBody));
  const valid = await validateTwilioSignature({ authToken: process.env.TWILIO_AUTH_TOKEN, signatureHeader: request.headers.get("x-twilio-signature"), url: resolveTwilioWebhookUrl(request.url, process.env.TWILIO_VOICE_WEBHOOK_URL), params });
  if (!valid) return new NextResponse("Unauthorized", { status: 401 });
  const callSid = params.CallSid ?? "";
  const from = params.From ?? "";
  const to = params.To ?? "";
  if (!/^CA[0-9a-f]{32}$/.test(callSid) || !to) return say(FALLBACK_GREETING);
  try {
    const resolved = await getAppDatabase().db.execute<{ business_id: string }>(sql`select app.resolve_business_by_phone(${to}) as business_id`);
    const businessId = resolved.rows[0]?.business_id;
    if (!businessId) return say(FALLBACK_GREETING);
    const result = await recordMissedCall(createWorkerDomainContext(), { businessId, providerCallId: callSid, from, to });
    return say(result.greeting);
  } catch (error) {
    console.error("[kyra] missed-call webhook failed", error instanceof Error ? error.name : typeof error);
    return say(FALLBACK_GREETING);
  }
}
