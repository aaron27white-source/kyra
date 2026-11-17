import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { superAdminDraftWriteSchema } from "@lobbystack/contracts";
import { readManagedLmcDraft, updateManagedLmcDraft } from "@lobbystack/domain";
import { asApiResponse, getAppDatabase, readJson } from "@/lib/api-helpers";
import { requireSuperAdminSession } from "@/lib/superadmin";

export const dynamic = "force-dynamic";
const tenantIdSchema = z.string().uuid();

export async function GET(request: Request, context: { params: Promise<{ tenantId: string }> }) {
  try {
    const session = await requireSuperAdminSession(request.headers);
    const parsedTenantId = tenantIdSchema.safeParse((await context.params).tenantId);
    if (!parsedTenantId.success) return NextResponse.json({ error: "Client draft not found." }, { status: 404 });
    const tenantId = parsedTenantId.data;
    return NextResponse.json(await readManagedLmcDraft({ db: getAppDatabase().db }, { actorUserId: session.user.id, tenantId }));
  } catch (error) { return asApiResponse(error); }
}

export async function PUT(request: Request, context: { params: Promise<{ tenantId: string }> }) {
  try {
    const session = await requireSuperAdminSession(request.headers);
    const parsedTenantId = tenantIdSchema.safeParse((await context.params).tenantId);
    if (!parsedTenantId.success) return NextResponse.json({ error: "Client draft not found." }, { status: 404 });
    const tenantId = parsedTenantId.data;
    const parsed = superAdminDraftWriteSchema.safeParse(await readJson(request));
    if (!parsed.success || parsed.data.expectedRevision === undefined) return NextResponse.json({ error: "A valid draft and expectedRevision are required." }, { status: 400 });
    return NextResponse.json(await updateManagedLmcDraft({ db: getAppDatabase().db }, { actorUserId: session.user.id, tenantId, expectedRevision: parsed.data.expectedRevision, requestId: randomUUID(), draft: parsed.data.draft }));
  } catch (error) { return asApiResponse(error); }
}
