import { NextResponse } from "next/server";

import { createObjectDownload, createUpload, finalizeUpload } from "@lobbystack/domain";
import { uploadCreateRequestSchema, uploadDownloadRequestSchema, uploadFinalizeRequestSchema } from "@lobbystack/contracts";
import { asApiResponse, readJson, requireOperatorBusiness } from "@/lib/api-helpers";
import { createDomainContext } from "@/lib/domain-context";
import { getStorageProvider } from "@/lib/storage";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: { Allow: "POST, PUT, OPTIONS" },
  });
}

export async function GET(request: Request) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request, { pilotCapability: "knowledge" });
    const url = new URL(request.url);
    const input = uploadDownloadRequestSchema.parse({
      businessId: url.searchParams.get("businessId"),
      objectId: url.searchParams.get("objectId"),
      ...(url.searchParams.get("range") ? { range: url.searchParams.get("range") } : {}),
    });
    if (input.businessId !== businessId) return NextResponse.json({ error: "businessId does not match the active workspace." }, { status: 400 });
    return NextResponse.json(await createObjectDownload(createDomainContext(), {
      ...input, businessId,
      userId: session.user.id,
    }, getStorageProvider()));
  } catch (error) { return asApiResponse(error); }
}

export async function POST(request: Request) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request, { pilotCapability: "knowledge" });
    const body = uploadCreateRequestSchema.parse(await readJson(request));
    if (body.businessId !== businessId) return NextResponse.json({ error: "businessId does not match the active workspace." }, { status: 400 });
    return NextResponse.json(await createUpload(createDomainContext(), { ...body, businessId, userId: session.user.id, ...(body.checksum !== undefined ? { checksum: body.checksum } : {}) }, getStorageProvider()), { status: 201 });
  } catch (error) { return asApiResponse(error); }
}

export async function PUT(request: Request) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request, { pilotCapability: "knowledge" });
    const body = uploadFinalizeRequestSchema.parse(await readJson(request));
    if (body.businessId !== businessId) return NextResponse.json({ error: "businessId does not match the active workspace." }, { status: 400 });
    await finalizeUpload(createDomainContext(), { ...body, businessId, userId: session.user.id, ...(body.checksum !== undefined ? { checksum: body.checksum } : {}) }, getStorageProvider());
    return NextResponse.json({ ok: true });
  } catch (error) { return asApiResponse(error); }
}
