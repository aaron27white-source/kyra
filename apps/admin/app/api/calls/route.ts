import { NextResponse } from "next/server";

import { listCalls, startCall } from "@lobbystack/domain";
import { asApiResponse, readJson, withOperatorTransaction } from "@/lib/api-helpers";
import { createDomainContext, createWorkerDomainContext } from "@/lib/domain-context";
import { isPilotMode } from "@lobbystack/shared";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  // `POST` is intentionally blocked by the pilot proxy. Keep Next's automatic
  // Allow header from advertising it while the pilot boundary is active.
  const methods = isPilotMode(process.env) ? "GET, HEAD, OPTIONS" : "GET, HEAD, POST, OPTIONS";
  return new Response(null, { status: 204, headers: { Allow: methods } });
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    return NextResponse.json(await withOperatorTransaction(request, async ({ session, businessId }) => await listCalls(createDomainContext(), {
      userId: session.user.id,
      businessId,
      ...(url.searchParams.get("search") ? { search: url.searchParams.get("search")! } : {}),
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(Number.isFinite(offset) ? { offset } : {}),
    }), { pilotCapability: "voice" }));
  } catch (error) { return asApiResponse(error); }
}

export async function POST(request: Request) {
  try {
    const body = await readJson(request) as { providerCallId?: string; from?: string; to?: string; transport?: string };
    if (!body.providerCallId || !body.from || !body.to) return NextResponse.json({ error: "businessId, providerCallId, from, and to are required." }, { status: 400 });
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId }) => await startCall(createWorkerDomainContext(), { businessId, provider: "twilio", providerCallId: body.providerCallId!, from: body.from!, to: body.to!, transport: body.transport ?? "voice" }), { minimumRole: "business_admin" }), { status: 201 });
  } catch (error) { return asApiResponse(error); }
}
