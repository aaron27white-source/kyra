import { NextResponse } from "next/server";

import { setQuoteStatus } from "@lobbystack/domain";
import { isUuid } from "@lobbystack/shared";
import { asApiResponse, readJson, requireOperatorBusiness } from "@/lib/api-helpers";
import { createDomainContext } from "@/lib/domain-context";

export const dynamic = "force-dynamic";

/** Moves the quote to its next status. With textCustomer, it's texted to the customer too. */
export async function PATCH(request: Request, { params }: { params: Promise<{ quoteId: string }> }) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request);
    const { quoteId } = await params;
    if (!isUuid(quoteId)) return NextResponse.json({ error: "quoteId must be a UUID.", code: "invalid_request" }, { status: 400 });
    const body = (await readJson(request) ?? {}) as { status?: unknown; textCustomer?: unknown };
    return NextResponse.json({ quote: await setQuoteStatus(createDomainContext(), { userId: session.user.id, businessId, quoteId: quoteId, status: body.status, textCustomer: body.textCustomer === true }) });
  } catch (error) { return asApiResponse(error); }
}
