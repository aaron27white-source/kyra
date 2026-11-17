import { asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { businessHours } from "@lobbystack/db";
import { replaceBusinessHoursInTransaction } from "@lobbystack/domain";
import { asApiResponse, jsonError, readJson, withOperatorTransaction } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

type HoursWindow = {
  dayOfWeek: number;
  openMinutes: number;
  closeMinutes: number;
};

function parseHours(value: unknown): HoursWindow[] {
  if (!Array.isArray(value) || value.length > 7) throw jsonError("hours must contain at most seven weekdays.");
  const days = new Set<number>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw jsonError("Each hours entry is invalid.");
    const row = entry as Record<string, unknown>;
    if (![row.dayOfWeek, row.openMinutes, row.closeMinutes].every(Number.isInteger)) throw jsonError("Hours values must be integers.");
    const dayOfWeek = row.dayOfWeek as number;
    const openMinutes = row.openMinutes as number;
    const closeMinutes = row.closeMinutes as number;
    if (dayOfWeek < 0 || dayOfWeek > 6 || days.has(dayOfWeek)) throw jsonError("Each weekday may appear once.");
    if (openMinutes < 0 || closeMinutes > 1_440 || closeMinutes <= openMinutes) throw jsonError("Closing time must be after opening time.");
    days.add(dayOfWeek);
    return {
      dayOfWeek,
      openMinutes,
      closeMinutes,
    };
  });
}

export async function GET(request: Request) {
  try {
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => ({
      hours: await tx
        .select({
          dayOfWeek: businessHours.dayOfWeek,
          openMinutes: businessHours.openMinutes,
          closeMinutes: businessHours.closeMinutes,
        })
        .from(businessHours)
        .where(eq(businessHours.businessId, businessId))
        .orderBy(asc(businessHours.dayOfWeek)),
    }), { pilotCapability: "business_profile" }));
  } catch (error) {
    return asApiResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const body = await readJson(request);
    const hours = parseHours(body && typeof body === "object" && !Array.isArray(body) ? (body as { hours?: unknown }).hours : undefined);
    await withOperatorTransaction(request, async ({ businessId, tx }) => {
      await replaceBusinessHoursInTransaction(tx, { businessId, hours });
    }, { minimumRole: "business_admin", pilotCapability: "business_profile" });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return asApiResponse(error);
  }
}
