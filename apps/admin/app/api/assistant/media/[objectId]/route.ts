import { NextResponse } from "next/server";

import { createObjectDownload } from "@lobbystack/domain";
import { isUuid } from "@lobbystack/shared";
import { getStorageProvider } from "@/lib/storage";
import { asApiResponse, requireOperatorBusiness } from "@/lib/api-helpers";
import { createDomainContext } from "@/lib/domain-context";

export const dynamic = "force-dynamic";

/** A short-lived download link for a customer's texted photo. Members of the owning business only. */
export async function GET(request: Request, { params }: { params: Promise<{ objectId: string }> }) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request);
    const { objectId } = await params;
    if (!isUuid(objectId)) return NextResponse.json({ error: "objectId must be a UUID.", code: "invalid_request" }, { status: 400 });
    return NextResponse.json(await createObjectDownload(createDomainContext(), { userId: session.user.id, businessId, objectId }, getStorageProvider()));
  } catch (error) { return asApiResponse(error); }
}
