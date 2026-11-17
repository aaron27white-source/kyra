import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { acceptInvitation, previewInvitation } from "@lobbystack/domain";
import { asApiResponse, readJson, requireApiSession } from "@/lib/api-helpers";
import { createDomainContext } from "@/lib/domain-context";
import { getAuthDatabase } from "@/lib/auth";
import { users } from "@lobbystack/db";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const token = new URL(request.url).searchParams.get("token")?.trim();
    if (!token) return NextResponse.json({ invitation: null });
    const tokenHash = createHash("sha256").update(token).digest("hex");
    return NextResponse.json({ invitation: await previewInvitation(createDomainContext(), { tokenHash }) });
  } catch (error) {
    return asApiResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireApiSession(request);
    const [identity] = await getAuthDatabase().db.select({ email: users.email, verified: users.emailVerified }).from(users).where(eq(users.id, session.user.id)).limit(1);
    if (!identity?.verified) return NextResponse.json({ error: "A verified email is required." }, { status: 403 });
    const body = await readJson(request);
    if (typeof body !== "object" || body === null || Array.isArray(body) || typeof (body as { token?: unknown }).token !== "string") {
      throw new Error("An invitation token is required.");
    }
    const tokenHash = createHash("sha256").update((body as { token: string }).token).digest("hex");
    return NextResponse.json(await acceptInvitation(createDomainContext(), { userId: session.user.id, tokenHash, verifiedEmail: identity.email }));
  } catch (error) {
    return asApiResponse(error);
  }
}
