import { NextResponse } from "next/server";

import { getAssistantSettings, updateAssistantSettings } from "@lobbystack/domain";
import { asApiResponse, readJson, requireOperatorBusiness } from "@/lib/api-helpers";
import { createDomainContext } from "@/lib/domain-context";

export const dynamic = "force-dynamic";

/** Kyra settings: tier, missed calls, the voice switch. Tier changes need a platform admin. */
export async function GET(request: Request) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request);
    return NextResponse.json({ settings: await getAssistantSettings(createDomainContext(), { userId: session.user.id, businessId }) });
  } catch (error) { return asApiResponse(error); }
}

export async function PATCH(request: Request) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request);
    return NextResponse.json({ settings: await updateAssistantSettings(createDomainContext(), { userId: session.user.id, businessId, patch: await readJson(request) }) });
  } catch (error) { return asApiResponse(error); }
}
