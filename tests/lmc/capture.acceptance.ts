import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { businesses, lmcEvents, lmcJobs, lmcLeads, lmcMessages, lmcSettings, lmcSuppressions, withBusinessTransaction } from "@lobbystack/db";
import { createReplyToken } from "../../packages/domain/src/server/lmc/capabilities";
import { LmcLeadCapture, handleLmcCapture } from "../../packages/domain/src/server/lmc/capture";
import { openLmcTestDatabase } from "./support/database";

const db = openLmcTestDatabase();
const tenantId = randomUUID(), other = randomUUID(), service = randomUUID();
const captureToken = createReplyToken(tenantId);
const now = new Date("2030-01-09T03:40:00Z");
const capture = new LmcLeadCapture({ database: db.worker.db, now: () => now });
const scoped = <T>(fn: Parameters<typeof withBusinessTransaction<T>>[2]) => withBusinessTransaction(db.worker.db, { businessId: tenantId, actorType: "worker" }, fn);
const payload = (email = `${randomUUID()}@example.invalid`) => ({ requestId: randomUUID(), email, name: "Ana", subject: "Roof", message: "Can you help with my roof?", consentToFollowUp: true });
const request = (token: string, body: unknown) => new Request(`https://lmc.example/api/lmc/capture/${token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  await db.admin.db.insert(businesses).values([tenantId,other].map(id => ({ id, slug: `lmc-capture-${id}`, name: id, timezone: "America/New_York", businessType: "service_company" })));
  await db.admin.db.insert(lmcSettings).values({ tenantId, captureTokenHash: captureToken.hash, config: {
    ownerEmail: "owner@example.invalid", fromEmail: "team@example.invalid", physicalAddress: "100 Main Street, Miami FL 33101", serviceAreaZips: ["33101"], serviceAreaCities: [],
    services: [{ id: service, name: "roof repair", aliases: [] }], emergencyKeywords: ["active leak"], emergencyText: "A person will contact you about your emergency.", priceInformation: "", tone: "professional", confidenceThreshold: 0.8,
    tools: ["availability", "book", "handoff"], followups: { enabled: true, maxTouches: 3, delaysHours: [24,48,72], dailyCap: 100 },
  } });
});
afterAll(async () => { await db.admin.db.delete(businesses).where(sql`${businesses.id} in (${tenantId},${other})`); await db.close(); });

describe("public capture uses the durable production boundary", () => {
  it("atomically records a lead, inbound message, event and process job without returning a conversation secret", async () => {
    const response = await handleLmcCapture(request(captureToken.value,payload()),captureToken.value,capture);
    expect(response.status).toBe(202);
    const result = await response.json();
    expect(Object.keys(result)).toEqual(["id"]);
    expect(JSON.stringify(result)).not.toContain(captureToken.value);
    await scoped(async tx => {
      const [lead] = await tx.select().from(lmcLeads).where(eq(lmcLeads.id,result.id));
      expect(lead).toMatchObject({ tenantId, status: "new", verifiedAt: null, consentFollowups: true });
      expect(lead!.contactId).toBeTruthy();
      expect(await tx.select().from(lmcMessages).where(eq(lmcMessages.leadId,result.id))).toHaveLength(1);
      const [job] = await tx.select().from(lmcJobs).where(eq(lmcJobs.leadId,result.id));
      expect(job).toMatchObject({ tenantId, kind: "process", status: "pending", availableAt: now });
      expect(job!.payload.replyToken).toEqual(expect.any(String));
      expect(await tx.select().from(lmcEvents).where(eq(lmcEvents.leadId,result.id))).toHaveLength(1);
    });
  });
  it("concurrent duplicate HTTP requests create only one job; changed content cannot reuse an idempotency key", async () => {
    const input = payload();
    const responses = await Promise.all([handleLmcCapture(request(captureToken.value,input),captureToken.value,capture),handleLmcCapture(request(captureToken.value,input),captureToken.value,capture)]);
    expect(responses.map(r => r.status)).toEqual([202,202]);
    const [one,two] = await Promise.all(responses.map(r => r.json()));
    expect(one).toEqual(two);
    expect((await handleLmcCapture(request(captureToken.value,{ ...input, message: "Changed" }),captureToken.value,capture)).status).toBe(409);
    await scoped(async tx => expect(await tx.select().from(lmcJobs).where(eq(lmcJobs.leadId,one.id))).toHaveLength(1));
  });
  it("rejects forged tenant routing, invalid bodies, methods and oversized requests before persistence", async () => {
    const count = await scoped(tx => tx.select().from(lmcLeads));
    const forged = createReplyToken(other).value;
    expect((await handleLmcCapture(request(forged,payload()),forged,capture)).status).toBe(404);
    const altered = captureToken.value.slice(0,-2)+"AA";
    expect((await handleLmcCapture(request(altered,payload()),altered,capture)).status).toBe(404);
    expect((await handleLmcCapture(request(captureToken.value,{ ...payload(), tenantId: other }),captureToken.value,capture)).status).toBe(400);
    expect((await handleLmcCapture(request(captureToken.value,{ ...payload(), email: "a@example.invalid\r\nBcc: x@evil.invalid" }),captureToken.value,capture)).status).toBe(400);
    expect((await handleLmcCapture(request(captureToken.value,{ ...payload(), message: "a".repeat(40_000) }),captureToken.value,capture)).status).toBe(413);
    expect((await handleLmcCapture(new Request("https://lmc.example",{method:"GET"}),captureToken.value,capture)).status).toBe(405);
    expect(await scoped(tx => tx.select().from(lmcLeads))).toHaveLength(count.length);
  });
  it("never queues processing for an already suppressed address", async () => {
    const email = `${randomUUID()}@example.invalid`;
    await scoped(tx => tx.insert(lmcSuppressions).values({ tenantId,email,reason:"opt_out" }));
    const result = await capture.capture(captureToken.value,payload(email));
    await scoped(async tx => {
      expect(await tx.select().from(lmcLeads).where(eq(lmcLeads.id,result.id))).toMatchObject([{ status: "suppressed" }]);
      expect(await tx.select().from(lmcJobs).where(eq(lmcJobs.leadId,result.id))).toEqual([]);
    });
  });
  it("applies an atomic sender cap and gives no model or transport access to the form", async () => {
    const email = `${randomUUID()}@example.invalid`;
    const statuses = await Promise.all(Array.from({length:7},() => handleLmcCapture(request(captureToken.value,payload(email)),captureToken.value,capture).then(r=>r.status)));
    expect(statuses.filter(s=>s===202)).toHaveLength(5);
    expect(statuses.filter(s=>s===429)).toHaveLength(2);
    expect(await scoped(tx => tx.select().from(lmcLeads).where(and(eq(lmcLeads.email,email),eq(lmcLeads.tenantId,tenantId))))).toHaveLength(5);
  });
});
