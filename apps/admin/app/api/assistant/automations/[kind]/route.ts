import { NextResponse } from "next/server";

import { updateAutomation } from "@lobbystack/domain";
import { asApiResponse, readJson, requireOperatorBusiness } from "@/lib/api-helpers";
import { createDomainContext } from "@/lib/domain-context";

export const dynamic = "force-dynamic";

/** Turns a Tier 3 automation on or off, or edits its text. The domain enforces the tier. */
export async function PATCH(request: Request, { params }: { params: Promise<{ kind: string }> }) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request);
    const { kind } = await params;
    const body = (await readJson(request) ?? {}) as { enabled?: unknown; messageTemplate?: unknown };
    return NextResponse.json({ automation: await updateAutomation(createDomainContext(), { userId: session.user.id, businessId, kind, enabled: body.enabled, messageTemplate: body.messageTemplate }) });
  } catch (error) { return asApiResponse(error); }
}
