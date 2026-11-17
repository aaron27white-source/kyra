import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { lmcEvents, lmcJobs, withBusinessTransaction, withDispatcherTransaction, type Database, type DatabaseTransaction } from "@lobbystack/db";

export const LMC_MAX_JOB_ATTEMPTS = 10;
export const LMC_JOB_LEASE_MS = 60_000;
export type LmcJob = typeof lmcJobs.$inferSelect;
type NewLmcJob = { tenantId: string; leadId: string; kind: "process" | "send" | "followup"; dedupeKey: string; payload: Record<string,unknown>; availableAt?: Date };

export async function enqueueLmcJob(tx: DatabaseTransaction, input: NewLmcJob): Promise<string> {
  if (!input.dedupeKey || input.dedupeKey.length > 512 || Buffer.byteLength(JSON.stringify(input.payload), "utf8") > 131_072) throw new Error("INVALID_JOB_PAYLOAD");
  const [created] = await tx.insert(lmcJobs).values({ ...input, ...(input.availableAt ? { availableAt: input.availableAt } : {}) })
    .onConflictDoNothing({ target: [lmcJobs.tenantId,lmcJobs.dedupeKey] }).returning({ id: lmcJobs.id });
  if (created) return created.id;
  const [existing] = await tx.select({ id: lmcJobs.id }).from(lmcJobs).where(and(
    eq(lmcJobs.tenantId,input.tenantId), eq(lmcJobs.dedupeKey,input.dedupeKey), eq(lmcJobs.kind,input.kind), eq(lmcJobs.leadId,input.leadId),
    sql`${lmcJobs.payload} = ${JSON.stringify(input.payload)}::jsonb`,
  )).limit(1);
  if (!existing) throw new Error("JOB_IDEMPOTENCY_CONFLICT");
  return existing.id;
}

export type LmcJobFailureCategory = "database" | "rls" | "processing" | "sending" | "idempotency" | "unknown";
export type LmcJobFailureDiagnostic = { kind: string; code: string; category: LmcJobFailureCategory; attempts: number; terminal: boolean };
const failureCodes = new Set(["EMAIL_PROVIDER_UNAVAILABLE","EMAIL_SEND_PREPARE_LEASE","EMAIL_SEND_PREPARE_LOAD_RECORDS","EMAIL_SEND_PREPARE_PAYLOAD_VALIDATION","EMAIL_SEND_PREPARE_SETTINGS","EMAIL_SEND_PREPARE_RECIPIENT_VALIDATION","EMAIL_SEND_PREPARE_FOLLOWUP_POLICY","EMAIL_SEND_PREPARE_MARK_SENDING","INVALID_OUTBOUND_EMAIL","IDEMPOTENCY_CONFLICT","MODEL_UNAVAILABLE","CALENDAR_UNAVAILABLE","INVALID_JOB_PAYLOAD","LMC_DATABASE_PERMISSION","LMC_DATABASE_RLS","LMC_DATABASE_CONSTRAINT","LMC_JOB_FAILED"]);

export function classifyLmcJobFailure(value: unknown): { code: string; category: LmcJobFailureCategory } {
  const message = typeof value === "string" ? value : value instanceof Error ? value.message : "";
  if (/row[- ]level security|rls policy/i.test(message)) return { code: "LMC_DATABASE_RLS", category: "rls" };
  if (/permission denied/i.test(message)) return { code: "LMC_DATABASE_PERMISSION", category: "database" };
  if (/duplicate|unique constraint|idempotency/i.test(message)) return { code: "IDEMPOTENCY_CONFLICT", category: "idempotency" };
  if (/constraint|violates .*check|violates .*foreign key/i.test(message)) return { code: "LMC_DATABASE_CONSTRAINT", category: "database" };
  if (failureCodes.has(message)) {
    const category: LmcJobFailureCategory = message.startsWith("EMAIL_") || message === "INVALID_OUTBOUND_EMAIL" ? "sending" : message === "IDEMPOTENCY_CONFLICT" ? "idempotency" : message === "LMC_DATABASE_RLS" ? "rls" : message.startsWith("LMC_DATABASE_") ? "database" : message === "MODEL_UNAVAILABLE" || message === "INVALID_JOB_PAYLOAD" ? "processing" : "unknown";
    return { code: message, category };
  }
  return { code: "LMC_JOB_FAILED", category: "unknown" };
}

export class LmcJobQueue {
  constructor(private readonly input: { worker: Database; dispatcher: Database; now: () => Date; onFailure?: (diagnostic: LmcJobFailureDiagnostic) => void }) {}

  async dueTenants(limit = 50): Promise<string[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("INVALID_QUEUE_LIMIT");
    return withDispatcherTransaction(this.input.dispatcher, async tx => {
      // This query intentionally uses only columns granted to the dispatcher.
      const rows = await tx.selectDistinct({ tenantId: lmcJobs.tenantId }).from(lmcJobs)
        .where(and(inArray(lmcJobs.status,["pending","running"]),lte(lmcJobs.availableAt,this.input.now())))
        .orderBy(asc(lmcJobs.tenantId)).limit(limit);
      return rows.map(row => row.tenantId);
    });
  }

  async claim(tenantId: string, limit = 25): Promise<LmcJob[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("INVALID_QUEUE_LIMIT");
    const now = this.input.now();
    return withBusinessTransaction(this.input.worker, { businessId: tenantId, actorType: "worker" }, async tx => {
      const expired = or(isNull(lmcJobs.leasedUntil),lte(lmcJobs.leasedUntil,now));
      await tx.update(lmcJobs).set({ status: "failed", leasedUntil: null, leaseToken: null, lastError: "LMC_JOB_FAILED", updatedAt: now })
        .where(and(eq(lmcJobs.tenantId,tenantId),gte(lmcJobs.attempts,LMC_MAX_JOB_ATTEMPTS),or(eq(lmcJobs.status,"pending"),and(eq(lmcJobs.status,"running"),expired))));
      const rows = await tx.select().from(lmcJobs).where(and(
        eq(lmcJobs.tenantId,tenantId),lte(lmcJobs.availableAt,now),lt(lmcJobs.attempts,LMC_MAX_JOB_ATTEMPTS),
        or(eq(lmcJobs.status,"pending"),and(eq(lmcJobs.status,"running"),expired)),
      )).orderBy(asc(lmcJobs.availableAt),asc(lmcJobs.id)).limit(limit).for("update", { skipLocked: true });
      const claimed: LmcJob[] = [];
      for (const row of rows) {
        const [job] = await tx.update(lmcJobs).set({ status: "running", leaseToken: randomUUID(), leasedUntil: new Date(now.getTime()+LMC_JOB_LEASE_MS), attempts: sql`${lmcJobs.attempts}+1`, updatedAt: now })
          .where(and(eq(lmcJobs.tenantId,tenantId),eq(lmcJobs.id,row.id))).returning();
        if (job) claimed.push(job);
      }
      return claimed;
    });
  }

  async complete(job: LmcJob): Promise<boolean> {
    if (!job.leaseToken) return false;
    return withBusinessTransaction(this.input.worker, { businessId: job.tenantId, actorType: "worker" }, async tx => {
      const rows = await tx.update(lmcJobs).set({ status: "done", leasedUntil: null, leaseToken: null, lastError: null, updatedAt: this.input.now() })
        .where(and(eq(lmcJobs.tenantId,job.tenantId),eq(lmcJobs.id,job.id),eq(lmcJobs.leaseToken,job.leaseToken!),eq(lmcJobs.status,"running"))).returning({ id: lmcJobs.id });
      return rows.length === 1;
    });
  }

  async renew(job: LmcJob): Promise<boolean> {
    if (!job.leaseToken) return false;
    const now = this.input.now();
    return withBusinessTransaction(this.input.worker, { businessId: job.tenantId, actorType: "worker" }, async tx => {
      const rows = await tx.update(lmcJobs).set({ leasedUntil: new Date(now.getTime()+LMC_JOB_LEASE_MS), updatedAt: now })
        .where(and(eq(lmcJobs.tenantId,job.tenantId),eq(lmcJobs.id,job.id),eq(lmcJobs.leaseToken,job.leaseToken!),eq(lmcJobs.status,"running"))).returning({ id: lmcJobs.id });
      return rows.length === 1;
    });
  }

  async fail(job: LmcJob, code: string): Promise<boolean> {
    if (!job.leaseToken) return false;
    const now = this.input.now();
    const dead = job.attempts >= LMC_MAX_JOB_ATTEMPTS;
    const classified = classifyLmcJobFailure(code);
    const updated = await withBusinessTransaction(this.input.worker, { businessId: job.tenantId, actorType: "worker" }, async tx => {
      const rows = await tx.update(lmcJobs).set({ status: dead ? "failed" : "pending", leasedUntil: null, leaseToken: null,
        availableAt: dead ? now : new Date(now.getTime()+Math.min(3_600_000,2**job.attempts*1_000)),
        lastError: classified.code, updatedAt: now })
        .where(and(eq(lmcJobs.tenantId,job.tenantId),eq(lmcJobs.id,job.id),eq(lmcJobs.leaseToken,job.leaseToken!),eq(lmcJobs.status,"running"))).returning({ id: lmcJobs.id });
      if(rows.length!==1)return false;
      await tx.insert(lmcEvents).values({tenantId:job.tenantId,leadId:job.leadId,type:"email_job_failed",externalId:`job-failed:${job.id}:${job.attempts}`,metadata:{kind:job.kind,code:classified.code,category:classified.category,attempts:job.attempts,terminal:dead},createdAt:now}).onConflictDoNothing({target:[lmcEvents.tenantId,lmcEvents.externalId]});
      return true;
    });
    if (updated) this.input.onFailure?.({ kind: job.kind, code: classified.code, category: classified.category, attempts: job.attempts, terminal: dead });
    return updated;
  }
}
