import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { inviteManagedLmcOwner } from "@lobbystack/domain";
import { asApiResponse, getAppDatabase } from "@/lib/api-helpers";
import { requireSuperAdminSession } from "@/lib/superadmin";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ tenantId: string }> }) {
  try {
    const session = await requireSuperAdminSession(request.headers);
    const parsedTenantId = z.string().uuid().safeParse((await context.params).tenantId);
    if (!parsedTenantId.success) return NextResponse.json({ error: "Client draft not found." }, { status: 404 });
    const tenantId = parsedTenantId.data;
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey || idempotencyKey.length > 160) return NextResponse.json({ error: "A bounded Idempotency-Key is required." }, { status: 400 });
    const appBaseUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";
    const result = await inviteManagedLmcOwner({ db: getAppDatabase().db }, { actorUserId: session.user.id, tenantId, idempotencyKey, requestId: randomUUID(), appBaseUrl });
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (error) { return asApiResponse(error); }
}
