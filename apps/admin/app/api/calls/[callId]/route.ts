import { NextResponse } from "next/server";

import { completeVoiceFollowUpTasks, getCallDetail } from "@lobbystack/domain";
import { asApiResponse, readJson, requireOperatorBusiness, withOperatorTransaction } from "@/lib/api-helpers";
import { createDomainContext } from "@/lib/domain-context";
import { isPilotMode } from "@lobbystack/shared";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  // The follow-up PATCH exists for legacy workspaces but is not in the pilot allowlist.
  const methods = isPilotMode(process.env) ? "GET, HEAD, OPTIONS" : "GET, HEAD, PATCH, OPTIONS";
  return new Response(null, { status: 204, headers: { Allow: methods } });
}

export async function GET(request: Request, { params }: { params: Promise<{ callId: string }> }) {
  try {
    const { callId } = await params;
    const detail = await withOperatorTransaction(request, async ({ session, businessId }) => await getCallDetail(createDomainContext(), { userId: session.user.id, businessId, callId }), { pilotCapability: "voice" });
    if (!detail) return NextResponse.json({ error: "Call not found.", code: "not_found" }, { status: 404 });
    return NextResponse.json(detail);
  } catch (error) {
    return asApiResponse(error);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ callId: string }> }) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request, { pilotCapability: "voice" });
    const body = await readJson(request) as { action?: string };
    if (!body || body.action !== "complete_follow_up") return NextResponse.json({ error: "action must be complete_follow_up." }, { status: 400 });
    const { callId } = await params;
    return NextResponse.json(await completeVoiceFollowUpTasks(createDomainContext(), { userId: session.user.id, businessId, callId }));
  } catch (error) {
    return asApiResponse(error);
  }
}
