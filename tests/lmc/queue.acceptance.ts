import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { businesses, lmcEvents, lmcJobs, withBusinessTransaction } from "@lobbystack/db";
import { enqueueLmcJob, LmcJobQueue } from "../../packages/domain/src/server/lmc/queue";
import { openLmcTestDatabase } from "./support/database";

const db = openLmcTestDatabase();
const a = randomUUID(), b = randomUUID(), leadA = randomUUID(), leadB = randomUUID();
let now = Date.parse("2030-01-09T03:40:00Z");
const queue = new LmcJobQueue({ worker: db.worker.db, dispatcher: db.dispatcher.db, now: () => new Date(now) });
let originalClaim: Awaited<ReturnType<LmcJobQueue["claim"]>>[number] | undefined;
const enqueue = (tenantId: string, leadId: string, key: string, availableAt = new Date(now)) => withBusinessTransaction(db.app.db, { businessId: tenantId, actorType: "system" }, tx => enqueueLmcJob(tx, { tenantId, leadId, kind: "process", dedupeKey: key, payload: { messageId: key }, availableAt }));

beforeAll(async () => {
  await db.admin.db.insert(businesses).values([a,b].map(id => ({ id, slug: `lmc-queue-${id}`, name: id, timezone: "America/New_York", businessType: "service_company" })));
  for (const [tenant,lead] of [[a,leadA],[b,leadB]]) await db.admin.db.execute(sql`insert into lmc_leads(id,tenant_id,email,reply_token_hash) values (${lead!},${tenant!},${`${tenant}@example.invalid`},${randomBytes(32).toString("hex")})`);
});
afterAll(async () => { await db.admin.db.execute(sql`delete from businesses where id in (${a},${b})`); await db.close(); });

describe("durable email work queue", () => {
  it("durably records sanitized diagnostics for a failed job",async()=>{
    await db.admin.db.insert(lmcJobs).values({tenantId:a,leadId:leadA,kind:"process",dedupeKey:"failure-event",payload:{messageId:randomUUID()}});
    for(let attempt=1;attempt<=10;attempt++){
      const [job]=await queue.claim(a);
      expect(job?.attempts).toBe(attempt);
      expect(await queue.fail(job!,"unsafe error containing a credential")).toBe(true);
      now+=3_600_001;
    }
    expect(await queue.claim(a)).toEqual([]);
    const failures=await withBusinessTransaction(db.worker.db,{businessId:a,actorType:"worker"},tx=>tx.select({type:lmcEvents.type,metadata:lmcEvents.metadata}).from(lmcEvents).where(sql`${lmcEvents.tenantId}=${a} and ${lmcEvents.leadId}=${leadA} and ${lmcEvents.type}='email_job_failed'`));
    expect(failures).toHaveLength(10);
    expect(failures).toContainEqual(expect.objectContaining({type:"email_job_failed",metadata:expect.objectContaining({kind:"process",code:"LMC_JOB_FAILED",category:"unknown",attempts:10,terminal:true})}));
    expect(JSON.stringify(failures)).not.toMatch(/credential|messageId/);
  });
  it("deduplicates concurrent enqueue and rejects conflicting use of the same key", async () => {
    const [one,two] = await Promise.all([enqueue(a,leadA,"same"),enqueue(a,leadA,"same")]);
    expect(one).toBe(two);
    await expect(withBusinessTransaction(db.app.db, { businessId: a, actorType: "system" }, tx => enqueueLmcJob(tx, { tenantId: a, leadId: leadA, kind: "send", dedupeKey: "same", payload: { messageId: "different" } }))).rejects.toThrow("JOB_IDEMPOTENCY_CONFLICT");
  });
  it("claims each job once across competing workers and cannot see another tenant's jobs", async () => {
    await enqueue(b,leadB,"other",new Date(now+86_400_000));
    const [one,two] = await Promise.all([queue.claim(a),queue.claim(a)]);
    expect([...one,...two]).toHaveLength(1);
    expect([...one,...two][0]).toMatchObject({ tenantId: a, attempts: 1, status: "running" });
    originalClaim = [...one,...two][0];
    expect(await queue.claim(b)).toEqual([]);
    expect(await queue.dueTenants()).not.toContain(b);
  });
  it("recovers an expired lease and rejects completion from the previous worker", async () => {
    now += 61_000;
    const [reclaimed] = await queue.claim(a);
    expect(reclaimed).toBeDefined();
    expect(reclaimed!.attempts).toBe(2);
    expect(reclaimed!.leaseToken).not.toBe(originalClaim!.leaseToken);
    expect(await queue.complete(originalClaim!)).toBe(false);
    expect(await queue.complete(reclaimed!)).toBe(true);
  });
  it("renews only the current worker's lease", async () => {
    await enqueue(a,leadA,"renew");
    const [job] = await queue.claim(a);
    expect(job).toBeDefined();
    now += 61_000;
    expect(await queue.renew(job!)).toBe(true);
    expect(await queue.renew({...job!,leaseToken:randomUUID()})).toBe(false);
    expect(await queue.claim(a)).toEqual([]);
    expect(await queue.complete(job!)).toBe(true);
  });
  it("bounds retries, sanitizes errors and dead-letters work after ten failed attempts", async () => {
    await enqueue(a,leadA,"retries");
    const [retryJob] = await db.admin.db.select({ id: lmcJobs.id }).from(lmcJobs).where(sql`${lmcJobs.tenantId}=${a} and ${lmcJobs.dedupeKey}='retries'`);
    expect(retryJob).toBeDefined();
    for (let attempt=1;attempt<=10;attempt++) {
      const [job] = await queue.claim(a);
      expect(job?.attempts).toBe(attempt);
      expect(await queue.fail(job!,"unsafe error containing a credential")).toBe(true);
      now += 3_600_001;
    }
    expect(await queue.claim(a)).toEqual([]);
    const rows = await withBusinessTransaction(db.worker.db, { businessId: a, actorType: "worker" }, tx => tx.execute(sql`select status,last_error from lmc_jobs where dedupe_key='retries'`));
    expect(rows.rows).toEqual([{ status: "failed", last_error: "LMC_JOB_FAILED" }]);
    const failures=await withBusinessTransaction(db.worker.db,{businessId:a,actorType:"worker"},tx=>tx.select({type:lmcEvents.type,metadata:lmcEvents.metadata}).from(lmcEvents).where(sql`${lmcEvents.tenantId}=${a} and ${lmcEvents.leadId}=${leadA} and ${lmcEvents.type}='email_job_failed' and ${lmcEvents.externalId} like ${`job-failed:${retryJob!.id}:%`}`));
    expect(failures).toHaveLength(10);
    expect(failures).toContainEqual(expect.objectContaining({metadata:expect.objectContaining({kind:"process",code:"LMC_JOB_FAILED",category:"unknown",attempts:10,terminal:true})}));
    expect(JSON.stringify(failures)).not.toContain("credential");
  });
  it("rejects enqueue into B from a transaction scoped to A", async () => {
    await expect(withBusinessTransaction(db.app.db, { businessId: a, actorType: "system" }, tx => enqueueLmcJob(tx, { tenantId: b, leadId: leadB, kind: "send", dedupeKey: randomUUID(), payload: {} }))).rejects.toThrow();
  });
});
