import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { businesses, phoneNumbers } from "@lobbystack/db";
import { asApiResponse, withOperatorTransaction } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const result = await withOperatorTransaction(request, async ({ businessId, tx }) => {
      const [business] = await tx.select({ voiceEnabled: businesses.lmcVoiceEnabled }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
      if (!business?.voiceEnabled) return { voiceEnabled: false as const, phoneNumber: null };
      const [number] = await tx.select({ e164: phoneNumbers.e164, status: phoneNumbers.status, voiceEnabled: phoneNumbers.voiceEnabled, voiceWebhookStatus: phoneNumbers.voiceWebhookStatus })
        .from(phoneNumbers).where(eq(phoneNumbers.businessId, businessId)).limit(1);
      return { voiceEnabled: true as const, phoneNumber: number ?? null };
    }, { pilotCapability: "voice" });
    if (!result.voiceEnabled) return NextResponse.json({ error: "Voice is not enabled for this workspace." }, { status: 404 });
    return NextResponse.json({ phoneNumber: result.phoneNumber });
  } catch (error) { return asApiResponse(error); }
}
