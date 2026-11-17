import { NextResponse } from "next/server";

import { asApiResponse } from "@/lib/api-helpers";
import { getSuperAdminOverview, requireSuperAdminSession } from "@/lib/superadmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const session = await requireSuperAdminSession(request.headers);
    return NextResponse.json(await getSuperAdminOverview(session.user.id));
  } catch (error) {
    return asApiResponse(error);
  }
}
