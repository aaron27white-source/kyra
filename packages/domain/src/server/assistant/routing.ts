import { and, eq } from "drizzle-orm";

import { enqueueOutbox, phoneNumbers, withBusinessTransaction, type DatabaseTransaction } from "@lobbystack/db";
import { tierAllows } from "@lobbystack/shared";

import type { DomainContext } from "../context";
import { loadAssistantSettings } from "./settings";

/**
 * Where a business's calls go. Tier 1 answers only missed calls, through our
 * voice webhook. Tier 2 and up put the number on the SIP trunk so the AI
 * answers every call live.
 */
export type CallRouting = "missed_call_webhook" | "sip_trunk";

export async function callRoutingFor(tx: DatabaseTransaction, businessId: string): Promise<CallRouting> {
  const settings = await loadAssistantSettings(tx, businessId);
  return tierAllows(settings, "live_receptionist") ? "sip_trunk" : "missed_call_webhook";
}

export async function loadCallRouting(context: DomainContext, input: { businessId: string }): Promise<{ routing: CallRouting; numbers: Array<{ id: string; providerPhoneId: string }> }> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const routing = await callRoutingFor(tx, input.businessId);
    const rows = await tx.select({ id: phoneNumbers.id, providerPhoneId: phoneNumbers.providerPhoneId }).from(phoneNumbers).where(and(eq(phoneNumbers.businessId, input.businessId), eq(phoneNumbers.status, "active")));
    return { routing, numbers: rows.flatMap((row) => row.providerPhoneId ? [{ id: row.id, providerPhoneId: row.providerPhoneId }] : []) };
  });
}

export async function recordCallRouting(context: DomainContext, input: { businessId: string; phoneNumberId: string; target: string; error?: string }): Promise<void> {
  await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    await tx.update(phoneNumbers).set({ voiceWebhookTargetUrl: input.target, voiceWebhookStatus: input.error ? "failed" : "synced", voiceWebhookLastSyncedAt: new Date(), voiceWebhookLastError: input.error ?? null, updatedAt: new Date() })
      .where(and(eq(phoneNumbers.id, input.phoneNumberId), eq(phoneNumbers.businessId, input.businessId)));
  });
}

export async function queueCallRoutingInTransaction(tx: DatabaseTransaction, businessId: string, reason: string): Promise<void> {
  await enqueueOutbox(tx, { topic: "phoneNumber.applyRouting", businessId, aggregateType: "business", aggregateId: businessId, dedupeKey: `routing:${businessId}:${reason}:${Date.now()}`, payload: {} });
}
