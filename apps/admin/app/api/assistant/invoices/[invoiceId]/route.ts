import { NextResponse } from "next/server";

import { setInvoiceStatus } from "@lobbystack/domain";
import { isUuid } from "@lobbystack/shared";
import { asApiResponse, readJson, requireOperatorBusiness } from "@/lib/api-helpers";
import { createDomainContext } from "@/lib/domain-context";

export const dynamic = "force-dynamic";

/** Moves the invoice to its next status. With textCustomer, it's texted to the customer too. */
export async function PATCH(request: Request, { params }: { params: Promise<{ invoiceId: string }> }) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request);
    const { invoiceId } = await params;
    if (!isUuid(invoiceId)) return NextResponse.json({ error: "invoiceId must be a UUID.", code: "invalid_request" }, { status: 400 });
    const body = (await readJson(request) ?? {}) as { status?: unknown; textCustomer?: unknown };
    return NextResponse.json({ invoice: await setInvoiceStatus(createDomainContext(), { userId: session.user.id, businessId, invoiceId: invoiceId, status: body.status, textCustomer: body.textCustomer === true }) });
  } catch (error) { return asApiResponse(error); }
}
