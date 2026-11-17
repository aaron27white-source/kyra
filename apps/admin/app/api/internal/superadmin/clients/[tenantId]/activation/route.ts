import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

import { activateManagedLmcClient, pauseManagedLmcClient, readManagedClientReadiness } from "@lobbystack/domain";
import { asApiResponse, getAppDatabase, readJson } from "@/lib/api-helpers";
import { getManagedActivationEnvironment } from "@/lib/superadmin-activation";
import { requireSuperAdminSession } from "@/lib/superadmin";

export const dynamic = "force-dynamic";
const tenantIdSchema = z.string().uuid();
const actionSchema = z.object({ action: z.enum(["activate", "pause"]) }).strict();

async function tenantId(context: { params: Promise<{ tenantId: string }> }) {
  return tenantIdSchema.safeParse((await context.params).tenantId);
}

export async function GET(request: Request, context: { params: Promise<{ tenantId: string }> }) {
  try {
    const session = await requireSuperAdminSession(request.headers);
    const parsed = await tenantId(context);
    if (!parsed.success) return NextResponse.json({ error: "Client not found." }, { status: 404 });
    return NextResponse.json(await readManagedClientReadiness({ db: getAppDatabase().db }, { actorUserId: session.user.id, tenantId: parsed.data, environment: getManagedActivationEnvironment() }));
  } catch (error) { return asApiResponse(error); }
}

export async function POST(request: Request, context: { params: Promise<{ tenantId: string }> }) {
  try {
    const session = await requireSuperAdminSession(request.headers);
    const parsed = await tenantId(context);
    if (!parsed.success) return NextResponse.json({ error: "Client not found." }, { status: 404 });
    const body = actionSchema.safeParse(await readJson(request));
    if (!body.success) return NextResponse.json({ error: "A valid activation action is required." }, { status: 400 });
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey || idempotencyKey.length > 160) return NextResponse.json({ error: "A bounded Idempotency-Key is required." }, { status: 400 });
    if (body.data.action === "pause") return NextResponse.json(await pauseManagedLmcClient({ db: getAppDatabase().db }, { actorUserId: session.user.id, tenantId: parsed.data, idempotencyKey, requestId: randomUUID() }));
    return NextResponse.json(await activateManagedLmcClient({ db: getAppDatabase().db }, { actorUserId: session.user.id, tenantId: parsed.data, idempotencyKey, requestId: randomUUID(), environment: getManagedActivationEnvironment() }));
  } catch (error) { return asApiResponse(error); }
}
