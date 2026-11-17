import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

import { setManagedLmcVoiceEnabled } from "@lobbystack/domain";
import { asApiResponse, getAppDatabase, readJson } from "@/lib/api-helpers";
import { requireSuperAdminSession } from "@/lib/superadmin";

export const dynamic = "force-dynamic";
const tenantIdSchema = z.string().uuid();
const inputSchema = z.object({ enabled: z.boolean() }).strict();

export async function PATCH(request: Request, context: { params: Promise<{ tenantId: string }> }) {
  try {
    const session = await requireSuperAdminSession(request.headers);
    const tenantId = tenantIdSchema.safeParse((await context.params).tenantId);
    if (!tenantId.success) return NextResponse.json({ error: "Client not found." }, { status: 404 });
    const body = inputSchema.safeParse(await readJson(request));
    if (!body.success) return NextResponse.json({ error: "A valid voice feature state is required." }, { status: 400 });
    return NextResponse.json(await setManagedLmcVoiceEnabled({ db: getAppDatabase().db }, {
      actorUserId: session.user.id, tenantId: tenantId.data, enabled: body.data.enabled, requestId: randomUUID(),
    }));
  } catch (error) { return asApiResponse(error); }
}
