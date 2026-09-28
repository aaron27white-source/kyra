import { NextResponse } from "next/server";

import { createInvoice, listInvoices } from "@lobbystack/domain";
import { asApiResponse, readJson, requireOperatorBusiness } from "@/lib/api-helpers";
import { createDomainContext } from "@/lib/domain-context";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request);
    return NextResponse.json({ invoices: await listInvoices(createDomainContext(), { userId: session.user.id, businessId }) });
  } catch (error) { return asApiResponse(error); }
}

export async function POST(request: Request) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request);
    const body = (await readJson(request) ?? {}) as Record<string, unknown>;
    return NextResponse.json({ invoice: await createInvoice(createDomainContext(), { userId: session.user.id, businessId, body }) }, { status: 201 });
  } catch (error) { return asApiResponse(error); }
}
