import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import {
  lmcLeads,
  lmcSuppressions,
  lmcEvents,
  lmcJobs,
  type DatabaseTransaction,
} from "@lobbystack/db";

export async function suppressLmcEmail(
  tx: DatabaseTransaction,
  tenantId: string,
  email: string,
  reason: "opt_out" | "bounce" | "complaint",
  now: Date,
) {
  // Lock all conversations for the address so concurrent send transactions finish before suppression commits.
  await tx
    .select({ id: lmcLeads.id })
    .from(lmcLeads)
    .where(and(eq(lmcLeads.tenantId, tenantId), eq(lmcLeads.email, email)))
    .orderBy(asc(lmcLeads.id))
    .for("update");
  await tx
    .insert(lmcSuppressions)
    .values({ tenantId, email, reason, createdAt: now })
    .onConflictDoNothing({
      target: [lmcSuppressions.tenantId, lmcSuppressions.email],
    });
  await tx
    .update(lmcLeads)
    .set({
      status: reason === "opt_out" ? "opted_out" : "suppressed",
      reason,
      aiPaused: true,
      followupGeneration: sql`${lmcLeads.followupGeneration}+1`,
      updatedAt: now,
    })
    .where(and(eq(lmcLeads.tenantId, tenantId), eq(lmcLeads.email, email)));
  // Cancel lead-facing work atomically with consent; already running sends
  // still recheck suppression while holding the conversation lock.
  await tx
    .update(lmcJobs)
    .set({ status: "cancelled", updatedAt: now })
    .where(and(
      eq(lmcJobs.tenantId, tenantId),
      eq(lmcJobs.status, "pending"),
      inArray(lmcJobs.leadId, tx.select({ id: lmcLeads.id }).from(lmcLeads).where(and(eq(lmcLeads.tenantId, tenantId), eq(lmcLeads.email, email)))),
      or(inArray(lmcJobs.kind, ["process", "followup"]), and(eq(lmcJobs.kind, "send"), sql`${lmcJobs.payload}->>'kind' is distinct from 'owner_alert'`)),
    ));
  await tx
    .insert(lmcEvents)
    .values({
      tenantId,
      type: "email_suppressed",
      metadata: { reason },
      createdAt: now,
    });
}
