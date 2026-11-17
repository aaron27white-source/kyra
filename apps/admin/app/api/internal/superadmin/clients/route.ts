import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { superAdminClientDraftSchema } from "@lobbystack/contracts";
import { provisionManagedLmcClient } from "@lobbystack/domain";

import { asApiResponse, getAppDatabase, parsePagination, readJson } from "@/lib/api-helpers";
import { listSuperAdminClients, requireSuperAdminSession } from "@/lib/superadmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const session = await requireSuperAdminSession(request.headers);
    const { limit, offset } = parsePagination(request, { limit: 25, maxLimit: 100 });
    const search = new URL(request.url).searchParams.get("search") ?? "";
    const result = await listSuperAdminClients({ userId: session.user.id, search, limit, offset });
    return NextResponse.json({ ...result, pagination: { limit, offset, total: result.total, hasNext: result.hasNext } });
  } catch (error) {
    return asApiResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireSuperAdminSession(request.headers);
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey || idempotencyKey.length > 160) return NextResponse.json({ error: "A bounded Idempotency-Key is required." }, { status: 400 });
    const body = await readJson(request) as { draft?: unknown };
    const parsed = superAdminClientDraftSchema.safeParse(body?.draft);
    if (!parsed.success) return NextResponse.json({ error: "Invalid client draft.", issues: parsed.error.issues }, { status: 400 });
    const result = await provisionManagedLmcClient({ db: getAppDatabase().db }, { actorUserId: session.user.id, idempotencyKey, requestId: randomUUID(), draft: parsed.data });
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (error) { return asApiResponse(error); }
}
