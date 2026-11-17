import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { lmcEvents, type DatabaseTransaction } from "@lobbystack/db";

export class LmcEmailIdentityConflict extends Error {}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function emailIdentityKeys(source: {
  messageId: string | null;
  providerId: string;
}): string[] {
  return [
    `email:event:${hash(source.providerId)}`,
    ...(source.messageId ? [`email:message:${hash(source.messageId)}`] : []),
  ].sort();
}

/** Both provider-event and RFC Message-ID claims are serialized in a stable order. */
export async function loadEmailIdentity(
  tx: DatabaseTransaction,
  tenantId: string,
  keys: string[],
  fingerprint: string,
) {
  for (const key of keys)
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:email-intake:${key}`},0))`,
    );
  const rows = await tx
    .select()
    .from(lmcEvents)
    .where(
      and(
        eq(lmcEvents.tenantId, tenantId),
        inArray(lmcEvents.externalId, keys),
      ),
    );
  if (!rows.length) return undefined;
  if (
    rows.some((row) => row.metadata.fingerprint !== fingerprint) ||
    new Set(rows.map((row) => row.leadId)).size !== 1
  )
    throw new LmcEmailIdentityConflict("EMAIL_IDEMPOTENCY_CONFLICT");
  return { leadId: rows[0]!.leadId };
}

export async function storeEmailIdentities(
  tx: DatabaseTransaction,
  input: {
    tenantId: string;
    leadId: string | null;
    keys: string[];
    fingerprint: string;
    now: Date;
  },
) {
  for (const externalId of input.keys)
    await tx
      .insert(lmcEvents)
      .values({
        tenantId: input.tenantId,
        leadId: input.leadId,
        type: "email_intake_identity",
        externalId,
        metadata: { fingerprint: input.fingerprint },
        createdAt: input.now,
      })
      .onConflictDoNothing({
        target: [lmcEvents.tenantId, lmcEvents.externalId],
      });
}
