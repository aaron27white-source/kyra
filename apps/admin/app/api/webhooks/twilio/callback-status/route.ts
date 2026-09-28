import { NextResponse } from "next/server";

import { recordCallbackOutcome } from "@lobbystack/domain";
import { normalizeTwilioFormFields, resolveTwilioWebhookUrl, validateTwilioSignature } from "@lobbystack/shared";
import { createWorkerDomainContext } from "@/lib/domain-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Kyra: status of an outbound AI callback. The opaque token in the query
 * string (signed as part of the URL) maps to the missed call. Not reached
 * means the customer gets the text-back instead.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  const params = normalizeTwilioFormFields(new URLSearchParams(rawBody));
  const valid = await validateTwilioSignature({ authToken: process.env.TWILIO_AUTH_TOKEN, signatureHeader: request.headers.get("x-twilio-signature"), url: resolveTwilioWebhookUrl(request.url, process.env.TWILIO_CALLBACK_STATUS_URL), params });
  if (!valid) return new NextResponse("Unauthorized", { status: 401 });
  const token = new URL(request.url).searchParams.get("token") ?? "";
  try {
    await recordCallbackOutcome(createWorkerDomainContext(), { token, callStatus: params.CallStatus ?? "", ...(params.CallDuration ? { durationSeconds: Number(params.CallDuration) } : {}) });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error("[kyra] callback status failed", error instanceof Error ? error.name : typeof error);
    return new NextResponse("Temporary webhook failure.", { status: 500 });
  }
}
