import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assistantSettings, businessHours, businessMemberships, businesses, contacts, createDatabaseClient, messages, missedCalls, outboxMessages, outreachAutomations, phoneNumbers, quotes, users, withBusinessTransaction } from "@lobbystack/db";
import { EMERGENCY_REPLY } from "@lobbystack/shared";

import { receiveInboundSms } from "../sms";
import { runAutomationSweep, updateAutomation } from "./automations";
import { createInvoice, listInvoices } from "./backOffice";
import { claimCallbackAttempt, listMissedCalls, processMissedCall, recordMissedCall } from "./missedCalls";
import { updateAssistantSettings } from "./settings";
import { planAssistantSmsReply } from "./smsAssistant";

// Explicit opt-in only, the same guard as the other integration suites.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Kyra integration tests require a dedicated local test database.");
  }
}

function roleUrl(role: string): string {
  const url = new URL(testUrl!);
  url.searchParams.set("options", `-c role=${role}`);
  return url.toString();
}

const admin = testUrl ? createDatabaseClient("lobbystack_migrator", { DATABASE_URL: testUrl }) : undefined;
// Every call below runs as the real service roles, so RLS applies exactly as in production.
const worker = testUrl ? createDatabaseClient("lobbystack_worker", { DATABASE_URL: roleUrl("lobbystack_worker") }) : undefined;
const app = testUrl ? createDatabaseClient("lobbystack_app", { DATABASE_URL: roleUrl("lobbystack_app") }) : undefined;

// 12:00 UTC on a Wednesday: open (hours 08–20 UTC) and inside the contact window.
const NOON = new Date("2030-01-09T12:00:00Z");
const NIGHT = new Date("2030-01-09T22:30:00Z");

type Business = { id: string; number: string; ownerId: string };
const created: Business[] = [];

async function createBusiness(tier: "missed_call" | "receptionist" | "assistant", extra: Partial<typeof assistantSettings.$inferInsert> = {}): Promise<Business> {
  const id = randomUUID();
  const number = `+1832${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
  await admin!.db.insert(businesses).values({ id, slug: `kyra-${id}`, name: `Kyra Test ${tier}`, timezone: "UTC", businessType: "service_company" });
  await admin!.db.insert(businessHours).values(Array.from({ length: 7 }, (_, dayOfWeek) => ({ businessId: id, dayOfWeek, openMinutes: 8 * 60, closeMinutes: 20 * 60 })));
  await admin!.db.insert(phoneNumbers).values({ businessId: id, e164: number });
  await admin!.db.insert(assistantSettings).values({ businessId: id, serviceTier: tier, ...extra });
  const ownerId = randomUUID();
  await admin!.db.insert(users).values({ id: ownerId, email: `${ownerId}@example.invalid`, normalizedEmail: `${ownerId}@example.invalid` });
  await admin!.db.insert(businessMemberships).values({ businessId: id, userId: ownerId, role: "business_owner" });
  const business = { id, number, ownerId };
  created.push(business);
  return business;
}

const workerContext = () => ({ db: worker!.db });
const appContext = () => ({ db: app!.db });
const callSid = () => `CA${randomUUID().replaceAll("-", "")}`;
const caller = () => `+1713${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;

async function outboundTexts(businessId: string) {
  return await admin!.db.select({ body: messages.body, kind: messages.providerStatus }).from(messages).where(and(eq(messages.businessId, businessId), eq(messages.direction, "outbound")));
}

describe.skipIf(!testUrl)("Kyra against PostgreSQL with RLS", () => {
  beforeAll(async () => {
    await admin!.db.execute(sql`select 1`);
  });

  afterAll(async () => {
    const ids = created.map((business) => business.id);
    if (ids.length) {
      await admin!.db.delete(outboxMessages).where(inArray(outboxMessages.businessId, ids));
      await admin!.db.delete(businesses).where(inArray(businesses.id, ids));
      await admin!.db.delete(users).where(inArray(users.id, created.map((business) => business.ownerId)));
    }
    await Promise.all([admin?.pool.end(), worker?.pool.end(), app?.pool.end()]);
  });

  it("texts a missed caller back once, records implied consent, and skips a repeat call", async () => {
    const business = await createBusiness("missed_call");
    const from = caller();
    const first = await recordMissedCall(workerContext(), { businessId: business.id, providerCallId: callSid(), from, to: business.number, now: NOON });
    expect(first.action).toBe("texting");
    expect(await processMissedCall(workerContext(), { businessId: business.id, missedCallId: first.missedCallId!, now: NOON })).toBe("texted");
    const repeat = await recordMissedCall(workerContext(), { businessId: business.id, providerCallId: callSid(), from, to: business.number, now: new Date(NOON.getTime() + 5 * 60_000) });
    expect(repeat.action).toBe("repeat");
    const texts = await outboundTexts(business.id);
    expect(texts).toHaveLength(1);
    expect(texts[0]!.body).toContain("Kyra");
    expect(texts[0]!.body).toContain("Reply STOP");
    const contact = (await admin!.db.select({ status: contacts.smsConsentStatus, source: contacts.smsConsentSource }).from(contacts).where(and(eq(contacts.businessId, business.id), eq(contacts.phone, from))))[0];
    expect(contact).toEqual({ status: "subscribed", source: "missed_call_inbound" });
    // A second delivery of the same Twilio webhook is a no-op.
    const duplicate = await recordMissedCall(workerContext(), { businessId: business.id, providerCallId: (await admin!.db.select({ id: missedCalls.providerCallId }).from(missedCalls).where(eq(missedCalls.id, first.missedCallId!)))[0]!.id, from, to: business.number, now: NOON });
    expect(duplicate.action).toBe("duplicate");
  });

  it("never texts a caller who opted out", async () => {
    const business = await createBusiness("missed_call");
    const from = caller();
    await admin!.db.insert(contacts).values({ businessId: business.id, phone: from, smsConsentStatus: "opted_out" });
    const result = await recordMissedCall(workerContext(), { businessId: business.id, providerCallId: callSid(), from, to: business.number, now: NOON });
    expect(result.action).toBe("opted_out");
    expect(await outboundTexts(business.id)).toHaveLength(0);
  });

  it("holds an after-hours text until opening when the business asks", async () => {
    const business = await createBusiness("missed_call", { afterHoursMode: "hold" });
    const result = await recordMissedCall(workerContext(), { businessId: business.id, providerCallId: callSid(), from: caller(), to: business.number, now: NIGHT });
    expect(result.action).toBe("held");
    expect(await processMissedCall(workerContext(), { businessId: business.id, missedCallId: result.missedCallId!, now: NIGHT })).toBe("held");
    const row = (await admin!.db.select({ status: missedCalls.status, due: missedCalls.textBackDueAt }).from(missedCalls).where(eq(missedCalls.id, result.missedCallId!)))[0]!;
    expect(row.status).toBe("held");
    expect(row.due?.toISOString()).toBe("2030-01-10T08:00:00.000Z");
    expect(await outboundTexts(business.id)).toHaveLength(0);
    // At opening the same job sends it.
    expect(await processMissedCall(workerContext(), { businessId: business.id, missedCallId: result.missedCallId!, now: new Date("2030-01-10T08:00:30Z") })).toBe("texted");
  });

  it("asks first, calls only after an explicit YES, and allows exactly one attempt", async () => {
    const business = await createBusiness("missed_call", { voiceCallbackEnabled: true, callbackMode: "ask_first" });
    const from = caller();
    const result = await recordMissedCall(workerContext(), { businessId: business.id, providerCallId: callSid(), from, to: business.number, now: NOON });
    expect(await processMissedCall(workerContext(), { businessId: business.id, missedCallId: result.missedCallId!, now: NOON })).toBe("awaiting_consent");
    expect((await outboundTexts(business.id))[0]!.body).toContain("Reply YES");
    // No consent yet: the call is refused.
    expect(await claimCallbackAttempt(workerContext(), { businessId: business.id, missedCallId: result.missedCallId!, now: NOON })).toEqual({ skipped: "already_attempted" });

    const inbound = await receiveInboundSms(workerContext(), { businessId: business.id, providerMessageId: `SM${randomUUID().replaceAll("-", "")}`, from, to: business.number, body: "Yes", payload: {} });
    const plan = await planAssistantSmsReply(workerContext(), { businessId: business.id, messageId: inbound.messageId!, now: NOON });
    expect(plan).toEqual({ kind: "none", reason: "callback_consent" });
    const row = (await admin!.db.select({ status: missedCalls.status, consent: missedCalls.consentMessageId }).from(missedCalls).where(eq(missedCalls.id, result.missedCallId!)))[0]!;
    expect(row).toEqual({ status: "callback_queued", consent: inbound.messageId });

    const claim = await claimCallbackAttempt(workerContext(), { businessId: business.id, missedCallId: result.missedCallId!, now: NOON });
    expect(claim).toMatchObject({ target: { to: from, from: business.number } });
    expect(await claimCallbackAttempt(workerContext(), { businessId: business.id, missedCallId: result.missedCallId!, now: NOON })).toEqual({ skipped: "already_attempted" });
  });

  it("doesn't call back outside the contact window, even in automatic mode", async () => {
    const business = await createBusiness("missed_call", { voiceCallbackEnabled: true, callbackMode: "automatic" });
    const result = await recordMissedCall(workerContext(), { businessId: business.id, providerCallId: callSid(), from: caller(), to: business.number, now: NIGHT });
    // 22:30 is after the 20:00 window end, so the texts take over.
    expect(await processMissedCall(workerContext(), { businessId: business.id, missedCallId: result.missedCallId!, now: NIGHT })).toBe("texted");
  });

  it("sends the fixed emergency wording before any AI reply", async () => {
    const business = await createBusiness("missed_call");
    const from = caller();
    const inbound = await receiveInboundSms(workerContext(), { businessId: business.id, providerMessageId: `SM${randomUUID().replaceAll("-", "")}`, from, to: business.number, body: "I smell gas in the kitchen", payload: {} });
    const plan = await planAssistantSmsReply(workerContext(), { businessId: business.id, messageId: inbound.messageId!, now: NOON });
    expect(plan).toMatchObject({ kind: "ai", emergency: "gas" });
    const texts = await outboundTexts(business.id);
    expect(texts).toEqual([{ body: EMERGENCY_REPLY.en, kind: "emergency_safety" }]);
  });

  it("enforces tiers on the server", async () => {
    const t1 = await createBusiness("missed_call");
    await expect(updateAutomation(appContext(), { userId: t1.ownerId, businessId: t1.id, kind: "quote_followup", enabled: true })).rejects.toMatchObject({ status: 403, code: "tier_required" });
    await expect(listInvoices(appContext(), { userId: t1.ownerId, businessId: t1.id })).rejects.toMatchObject({ status: 403, code: "tier_required" });
    // A business owner can't upgrade their own tier or turn on the paid add-on.
    await expect(updateAssistantSettings(appContext(), { userId: t1.ownerId, businessId: t1.id, patch: { serviceTier: "assistant" } })).rejects.toMatchObject({ status: 403 });
    await expect(updateAssistantSettings(appContext(), { userId: t1.ownerId, businessId: t1.id, patch: { backOfficeEnabled: true } })).rejects.toMatchObject({ status: 403 });
    // But they can change their own settings.
    await expect(updateAssistantSettings(appContext(), { userId: t1.ownerId, businessId: t1.id, patch: { voiceCallbackEnabled: true } })).resolves.toMatchObject({ voiceCallbackEnabled: true });
  });

  it("keeps each business's missed calls and invoices to itself", async () => {
    const a = await createBusiness("missed_call");
    const b = await createBusiness("missed_call", { backOfficeEnabled: true });
    await recordMissedCall(workerContext(), { businessId: a.id, providerCallId: callSid(), from: caller(), to: a.number, now: NOON });
    // B's owner asking for A's data is refused before any row is read.
    await expect(listMissedCalls(appContext(), { userId: b.ownerId, businessId: a.id })).rejects.toMatchObject({ status: 403 });
    expect(await listMissedCalls(appContext(), { userId: a.ownerId, businessId: a.id })).toHaveLength(1);
    const [aContact] = await admin!.db.insert(contacts).values({ businessId: a.id, phone: caller() }).returning({ id: contacts.id });
    // B can't bill A's customer.
    await expect(createInvoice(appContext(), { userId: b.ownerId, businessId: b.id, body: { contactId: aContact!.id, lineItems: [{ description: "x", quantity: 1, unitCents: 100 }] } })).rejects.toMatchObject({ status: 404 });
  });

  it("hides every Kyra table's rows from another business, as the worker and as a signed-in owner", async () => {
    const a = await createBusiness("assistant", { backOfficeEnabled: true });
    const b = await createBusiness("assistant", { backOfficeEnabled: true });
    await recordMissedCall(workerContext(), { businessId: a.id, providerCallId: callSid(), from: caller(), to: a.number, now: NOON });
    const [aContact] = await admin!.db.insert(contacts).values({ businessId: a.id, phone: caller() }).returning({ id: contacts.id });
    const [aQuote] = await admin!.db.insert(quotes).values({ businessId: a.id, contactId: aContact!.id, title: "Probe", amountCents: 100 }).returning({ id: quotes.id });
    await admin!.db.insert(outreachAutomations).values({ businessId: a.id, kind: "win_back", enabled: true });
    await admin!.db.execute(sql`insert into invoices (business_id, contact_id, number, total_cents) values (${a.id}, ${aContact!.id}, 'PROBE-1', 100)`);
    await admin!.db.execute(sql`insert into outreach_sends (business_id, kind, subject_id, step, contact_id) values (${a.id}, 'quote_followup', ${aQuote!.id}, 1, ${aContact!.id})`);

    const tables = ["assistant_settings", "missed_calls", "outreach_automations", "outreach_sends", "quotes", "invoices"] as const;
    for (const table of tables) {
      const [seeded] = (await admin!.db.execute(sql`select count(*)::int as n from ${sql.identifier(table)} where business_id = ${a.id}`)).rows as Array<{ n: number }>;
      expect(seeded!.n, `${table} seeded for A`).toBeGreaterThan(0);
    }

    // B's worker, B's owner in B, and B's owner claiming A's business id must all see and touch nothing of A's.
    const probes: Array<{ name: string; db: typeof worker; context: Parameters<typeof withBusinessTransaction>[1] }> = [
      { name: "worker bound to B", db: worker, context: { businessId: b.id, actorType: "worker" } },
      { name: "B's owner in B", db: app, context: { userId: b.ownerId, businessId: b.id, actorType: "operator" } },
      { name: "B's owner claiming A", db: app, context: { userId: b.ownerId, businessId: a.id, actorType: "operator" } },
    ];
    for (const probe of probes) {
      for (const table of tables) {
        await withBusinessTransaction(probe.db!.db, probe.context, async (tx) => {
          const [visible] = (await tx.execute(sql`select count(*)::int as n from ${sql.identifier(table)} where business_id = ${a.id}`)).rows as Array<{ n: number }>;
          expect(visible!.n, `${probe.name} reads ${table}`).toBe(0);
          expect((await tx.execute(sql`update ${sql.identifier(table)} set updated_at = now() where business_id = ${a.id}`)).rowCount, `${probe.name} updates ${table}`).toBe(0);
          expect((await tx.execute(sql`delete from ${sql.identifier(table)} where business_id = ${a.id}`)).rowCount, `${probe.name} deletes ${table}`).toBe(0);
        });
      }
      await expect(withBusinessTransaction(probe.db!.db, probe.context, async (tx) => {
        await tx.execute(sql`insert into outreach_automations (business_id, kind, enabled) values (${a.id}, 'review_request', true)`);
      }), `${probe.name} inserts into A`).rejects.toThrow();
    }
  });

  it("runs Tier 3 quote follow-ups once, and never to opted-out customers", async () => {
    const business = await createBusiness("assistant");
    const [ok, optedOut] = await admin!.db.insert(contacts).values([
      { businessId: business.id, phone: caller(), name: "Ana Diaz", smsConsentStatus: "subscribed" },
      { businessId: business.id, phone: caller(), name: "Bo", smsConsentStatus: "opted_out" },
    ]).returning({ id: contacts.id });
    const sentAt = new Date(NOON.getTime() - 3 * 86_400_000);
    await admin!.db.insert(quotes).values([
      { businessId: business.id, contactId: ok!.id, title: "Water heater swap", amountCents: 180_000, status: "sent", sentAt },
      { businessId: business.id, contactId: optedOut!.id, title: "Drain", amountCents: 20_000, status: "sent", sentAt },
    ]);
    await admin!.db.insert(outreachAutomations).values({ businessId: business.id, kind: "quote_followup", enabled: true });
    const first = await runAutomationSweep(workerContext(), { businessId: business.id, now: NOON });
    expect(first["quote_followup:sent"]).toBe(1);
    expect(first["quote_followup:no_consent"]).toBe(1);
    const second = await runAutomationSweep(workerContext(), { businessId: business.id, now: new Date(NOON.getTime() + 60_000) });
    expect(second["quote_followup:sent"] ?? 0).toBe(0);
    const texts = await outboundTexts(business.id);
    expect(texts).toHaveLength(1);
    expect(texts[0]!.body).toMatch(/^Hi Ana, it's Kyra Test assistant\. Just checking in on the quote for Water heater swap\./);
  });

  it("doesn't run Tier 3 automations for a Tier 1 business even if a row says enabled", async () => {
    const business = await createBusiness("missed_call");
    await admin!.db.insert(outreachAutomations).values({ businessId: business.id, kind: "win_back", enabled: true });
    expect(await runAutomationSweep(workerContext(), { businessId: business.id, now: NOON })).toEqual({});
  });
});
