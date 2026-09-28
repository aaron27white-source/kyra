import { NextResponse } from "next/server";

import { markAppointmentCompleted } from "@lobbystack/domain";
import { isUuid } from "@lobbystack/shared";
import { asApiResponse, requireOperatorBusiness } from "@/lib/api-helpers";
import { createDomainContext } from "@/lib/domain-context";

export const dynamic = "force-dynamic";

/** Marks a job done. Tier 3 review requests key off this. */
export async function POST(request: Request, { params }: { params: Promise<{ appointmentId: string }> }) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request);
    const { appointmentId } = await params;
    if (!isUuid(appointmentId)) return NextResponse.json({ error: "appointmentId must be a UUID.", code: "invalid_request" }, { status: 400 });
    const changed = await markAppointmentCompleted(createDomainContext(), { userId: session.user.id, businessId, appointmentId });
    return changed ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Only a confirmed appointment can be marked done.", code: "not_found" }, { status: 404 });
  } catch (error) { return asApiResponse(error); }
}
