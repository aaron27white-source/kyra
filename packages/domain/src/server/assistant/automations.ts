import { and, count, desc, eq, gte, inArray, isNotNull, lte, max, sql } from "drizzle-orm";

import { appointments, contacts, conversations, invoices, messages, missedCalls, outreachAutomations, outreachSends, quotes, withBusinessTransaction, type DatabaseTransaction } from "@lobbystack/db";
import { isWithinContactWindow, localMinutes, tierAllows, type AssistantFeature } from "@lobbystack/shared";

import type { DomainContext } from "../context";
import { queueOperatorAlertInTransaction } from "../notifications";
import { requireBusinessAdmin, requireBusinessMembership } from "../../authz";
import { ensureSmsThread, queueAssistantSmsInTransaction } from "./missedCalls";
import { AssistantInputError, TierRequiredError, loadAssistantSettings, loadBusinessBasics, type AssistantSettings } from "./settings";

export const automationKinds = ["quote_followup", "review_request", "win_back", "lead_nudge", "owner_brief", "payment_reminder"] as const;
export type AutomationKind = (typeof automationKinds)[number];

const DAY = 86_400_000;
// One automated text per customer per day, across every automation.
export const AUTOMATED_TEXT_GAP_MS = DAY;
const BATCH_LIMIT = 50;
const OWNER_BRIEF_MINUTES = 18 * 60;

export const DEFAULT_TEMPLATES: Record<AutomationKind, string> = {
  quote_followup: "Hi {name}, it's {business}. Just checking in on the quote for {title}. Any questions? Reply here and we'll help.",
  review_request: "Hi {name}, thanks for choosing {business}! If we did a good job, would you leave us a quick review? {link}",
  win_back: "Hi {name}, it's {business}. It's been a while, so if anything needs a check-up we have openings this week. Reply to book.",
  lead_nudge: "Hi {name}, it's {business} following up. Still need help? Reply with a good day and time and we'll get you on the schedule.",
  owner_brief: "",
  payment_reminder: "Hi {name}, a reminder from {business}: invoice {number} for {amount} is past due. You can pay here: {link}",
};

function featureFor(kind: AutomationKind): AssistantFeature {
  return kind === "payment_reminder" ? "back_office" : "outbound_automations";
}

export type AutomationView = { kind: AutomationKind; enabled: boolean; messageTemplate: string; available: boolean; settings: Record<string, unknown> };

export async function listAutomations(context: DomainContext, input: { userId: string; businessId: string }): Promise<AutomationView[]> {
  return await withBusinessTransaction(context.db, { userId: input.userId, businessId: input.businessId, actorType: "operator" }, async (tx) => {
    await requireBusinessMembership(tx, input);
    const settings = await loadAssistantSettings(tx, input.businessId);
    const rows = await tx.select().from(outreachAutomations).where(eq(outreachAutomations.businessId, input.businessId));
    return automationKinds.map((kind) => {
      const row = rows.find((candidate) => candidate.kind === kind);
      return { kind, enabled: row?.enabled ?? false, messageTemplate: row?.messageTemplate ?? DEFAULT_TEMPLATES[kind], available: tierAllows(settings, featureFor(kind)), settings: row?.settings ?? {} };
    });
  });
}

export async function updateAutomation(context: DomainContext, input: { userId: string; businessId: string; kind: string; enabled?: unknown; messageTemplate?: unknown }): Promise<AutomationView> {
  if (!(automationKinds as readonly string[]).includes(input.kind)) throw new AssistantInputError("Unknown automation.");
  const kind = input.kind as AutomationKind;
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new AssistantInputError("enabled must be true or false.");
  let template: string | null | undefined;
  if (input.messageTemplate !== undefined) {
    if (input.messageTemplate !== null && typeof input.messageTemplate !== "string") throw new AssistantInputError("messageTemplate must be text.");
    template = typeof input.messageTemplate === "string" ? input.messageTemplate.trim() || null : null;
    if (template && template.length > 320) throw new AssistantInputError("Keep the message to 320 characters or fewer.");
  }
  return await withBusinessTransaction(context.db, { userId: input.userId, businessId: input.businessId, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, input);
    const settings = await loadAssistantSettings(tx, input.businessId);
    if (input.enabled === true && !tierAllows(settings, featureFor(kind))) throw new TierRequiredError(featureFor(kind));
    const values = { ...(input.enabled !== undefined ? { enabled: input.enabled as boolean } : {}), ...(template !== undefined ? { messageTemplate: template } : {}) };
    const [row] = await tx.insert(outreachAutomations).values({ businessId: input.businessId, kind, ...values }).onConflictDoUpdate({ target: [outreachAutomations.businessId, outreachAutomations.kind], set: { ...values, updatedAt: new Date() } }).returning();
    return { kind, enabled: row?.enabled ?? false, messageTemplate: row?.messageTemplate ?? DEFAULT_TEMPLATES[kind], available: tierAllows(settings, featureFor(kind)), settings: row?.settings ?? {} };
  });
}

export function renderTemplate(template: string, values: Record<string, string>): string {
  const body = template.replace(/\{(name|business|title|amount|link|number)\}/g, (_match, key: string) => values[key] ?? "");
  const cleaned = body.replace(/\s+/g, " ").replace(/Hi ,/, "Hi,").trim();
  return /reply stop/i.test(cleaned) ? cleaned : `${cleaned} Reply STOP to opt out.`;
}

export function formatCents(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

type Candidate = { kind: AutomationKind; subjectId: string; step: number; contactId: string; values: Record<string, string> };

/** The outreach rules, checked on the server right before every automated text. */
async function mayText(tx: DatabaseTransaction, input: { businessId: string; contactId: string; now: Date }): Promise<{ ok: true; phone: string; name: string } | { ok: false; reason: string }> {
  const contact = (await tx.select({ phone: contacts.phone, name: contacts.name, smsConsentStatus: contacts.smsConsentStatus, operatorBlockedAt: contacts.operatorBlockedAt }).from(contacts).where(and(eq(contacts.id, input.contactId), eq(contacts.businessId, input.businessId))).limit(1))[0];
  if (!contact?.phone) return { ok: false, reason: "no_phone" };
  if (contact.operatorBlockedAt) return { ok: false, reason: "blocked" };
  if (contact.smsConsentStatus !== "subscribed") return { ok: false, reason: "no_consent" };
  const [{ last } = { last: null }] = await tx.select({ last: max(outreachSends.sentAt) }).from(outreachSends).where(and(eq(outreachSends.businessId, input.businessId), eq(outreachSends.contactId, input.contactId)));
  if (last && input.now.getTime() - new Date(last).getTime() < AUTOMATED_TEXT_GAP_MS) return { ok: false, reason: "daily_cap" };
  return { ok: true, phone: contact.phone, name: contact.name?.split(" ")[0] ?? "" };
}

async function sendCandidate(tx: DatabaseTransaction, input: { businessId: string; businessName: string; template: string; candidate: Candidate; now: Date }): Promise<"sent" | string> {
  const allowed = await mayText(tx, { businessId: input.businessId, contactId: input.candidate.contactId, now: input.now });
  if (!allowed.ok) return allowed.reason;
  // The unique key (business, kind, subject, step) is the idempotency guard: a re-run inserts nothing.
  const [claim] = await tx.insert(outreachSends).values({ businessId: input.businessId, kind: input.candidate.kind, subjectId: input.candidate.subjectId, step: input.candidate.step, contactId: input.candidate.contactId, sentAt: input.now }).onConflictDoNothing().returning({ id: outreachSends.id });
  if (!claim) return "already_sent";
  const thread = await ensureSmsThread(tx, input.businessId, allowed.phone);
  const body = renderTemplate(input.template, { name: allowed.name, business: input.businessName, ...input.candidate.values });
  const messageId = await queueAssistantSmsInTransaction(tx, { businessId: input.businessId, conversationId: thread.conversationId, sessionId: thread.sessionId, body, aiGenerated: false, kind: `automation_${input.candidate.kind}` });
  await tx.update(outreachSends).set({ messageId }).where(eq(outreachSends.id, claim.id));
  return "sent";
}

async function findCandidates(tx: DatabaseTransaction, kind: AutomationKind, input: { businessId: string; now: Date; settings: AssistantSettings }): Promise<Candidate[]> {
  const now = input.now;
  switch (kind) {
    case "quote_followup": {
      const rows = await tx.select({ id: quotes.id, contactId: quotes.contactId, title: quotes.title, sentAt: quotes.sentAt }).from(quotes)
        .where(and(eq(quotes.businessId, input.businessId), eq(quotes.status, "sent"), isNotNull(quotes.sentAt), lte(quotes.sentAt, new Date(now.getTime() - 2 * DAY)), gte(quotes.sentAt, new Date(now.getTime() - 30 * DAY))))
        .limit(BATCH_LIMIT);
      const out: Candidate[] = [];
      for (const row of rows) {
        // They already answered: a person should follow up, not a reminder.
        const replied = await tx.select({ id: messages.id }).from(messages).innerJoin(conversations, eq(conversations.id, messages.conversationId))
          .where(and(eq(messages.businessId, input.businessId), eq(conversations.contactId, row.contactId), eq(messages.direction, "inbound"), gte(messages.createdAt, row.sentAt!))).limit(1);
        if (replied.length) continue;
        const age = now.getTime() - row.sentAt!.getTime();
        out.push({ kind, subjectId: row.id, step: age >= 5 * DAY ? 2 : 1, contactId: row.contactId, values: { title: row.title } });
      }
      return out;
    }
    case "review_request": {
      if (!input.settings.reviewUrl) return [];
      const rows = await tx.select({ id: appointments.id, contactId: appointments.contactId }).from(appointments)
        .where(and(eq(appointments.businessId, input.businessId), eq(appointments.status, "completed"), gte(appointments.updatedAt, new Date(now.getTime() - 3 * DAY))))
        .limit(BATCH_LIMIT);
      return rows.map((row) => ({ kind, subjectId: row.id, step: 1, contactId: row.contactId, values: { link: input.settings.reviewUrl! } }));
    }
    case "win_back": {
      const rows = await tx.select({ contactId: appointments.contactId, lastEnd: max(appointments.endsAt) }).from(appointments)
        .where(and(eq(appointments.businessId, input.businessId), inArray(appointments.status, ["completed", "confirmed"])))
        .groupBy(appointments.contactId)
        .having(and(lte(max(appointments.endsAt), new Date(now.getTime() - 180 * DAY)), gte(max(appointments.endsAt), new Date(now.getTime() - 540 * DAY))))
        .limit(BATCH_LIMIT);
      // At most once per 180-day window per customer.
      const bucket = Math.floor(now.getTime() / (180 * DAY));
      return rows.map((row) => ({ kind, subjectId: row.contactId, step: bucket, contactId: row.contactId, values: {} }));
    }
    case "lead_nudge": {
      const rows = await tx.select({ id: conversations.id, contactId: conversations.contactId, createdAt: conversations.createdAt }).from(conversations)
        .where(and(eq(conversations.businessId, input.businessId), eq(conversations.channel, "sms"), eq(conversations.status, "open"), isNotNull(conversations.contactId), gte(conversations.createdAt, new Date(now.getTime() - 14 * DAY))))
        .limit(BATCH_LIMIT);
      const out: Candidate[] = [];
      for (const row of rows) {
        const last = (await tx.select({ direction: messages.direction, createdAt: messages.createdAt }).from(messages).where(and(eq(messages.businessId, input.businessId), eq(messages.conversationId, row.id))).orderBy(desc(messages.createdAt)).limit(1))[0];
        // Only when we spoke last and they went quiet.
        if (!last || last.direction !== "outbound") continue;
        const quiet = now.getTime() - last.createdAt.getTime();
        if (quiet < DAY) continue;
        const [{ value: inbound } = { value: 0 }] = await tx.select({ value: count() }).from(messages).where(and(eq(messages.businessId, input.businessId), eq(messages.conversationId, row.id), eq(messages.direction, "inbound")));
        if (!inbound) continue;
        const booked = await tx.select({ id: appointments.id }).from(appointments).where(and(eq(appointments.businessId, input.businessId), eq(appointments.contactId, row.contactId!), gte(appointments.createdAt, row.createdAt))).limit(1);
        if (booked.length) continue;
        out.push({ kind, subjectId: row.id, step: quiet >= 3 * DAY ? 2 : 1, contactId: row.contactId!, values: {} });
      }
      return out;
    }
    case "payment_reminder": {
      const rows = await tx.select({ id: invoices.id, contactId: invoices.contactId, number: invoices.number, totalCents: invoices.totalCents, currency: invoices.currency, dueAt: invoices.dueAt, paymentUrl: invoices.paymentUrl }).from(invoices)
        .where(and(eq(invoices.businessId, input.businessId), eq(invoices.status, "sent"), isNotNull(invoices.dueAt), lte(invoices.dueAt, new Date(now.getTime() - 3 * DAY)), gte(invoices.dueAt, new Date(now.getTime() - 60 * DAY))))
        .limit(BATCH_LIMIT);
      return rows.map((row) => {
        const overdue = now.getTime() - row.dueAt!.getTime();
        const step = overdue >= 14 * DAY ? 3 : overdue >= 7 * DAY ? 2 : 1;
        return { kind, subjectId: row.id, step, contactId: row.contactId, values: { number: row.number, amount: formatCents(row.totalCents, row.currency), link: row.paymentUrl ?? "" } };
      });
    }
    case "owner_brief":
      return [];
  }
}

async function sendOwnerBrief(tx: DatabaseTransaction, input: { businessId: string; businessName: string; timezone: string; now: Date }): Promise<boolean> {
  if (localMinutes(input.now, input.timezone) < OWNER_BRIEF_MINUTES) return false;
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: input.timezone }).format(input.now);
  const step = Number(localDate.replaceAll("-", ""));
  const [claim] = await tx.insert(outreachSends).values({ businessId: input.businessId, kind: "owner_brief", subjectId: input.businessId, step, sentAt: input.now }).onConflictDoNothing().returning({ id: outreachSends.id });
  if (!claim) return false;
  const since = new Date(input.now.getTime() - DAY);
  const counted = async (query: Promise<Array<{ value: number }>>) => (await query)[0]?.value ?? 0;
  const missed = await counted(tx.select({ value: count() }).from(missedCalls).where(and(eq(missedCalls.businessId, input.businessId), gte(missedCalls.receivedAt, since))));
  const texts = await counted(tx.select({ value: count() }).from(messages).where(and(eq(messages.businessId, input.businessId), eq(messages.direction, "inbound"), gte(messages.createdAt, since))));
  const booked = await counted(tx.select({ value: count() }).from(appointments).where(and(eq(appointments.businessId, input.businessId), gte(appointments.createdAt, since))));
  const openQuotes = await counted(tx.select({ value: count() }).from(quotes).where(and(eq(quotes.businessId, input.businessId), eq(quotes.status, "sent"))));
  const overdue = await counted(tx.select({ value: count() }).from(invoices).where(and(eq(invoices.businessId, input.businessId), eq(invoices.status, "sent"), lte(invoices.dueAt, input.now))));
  const body = `Today at ${input.businessName}: ${missed} missed call${missed === 1 ? "" : "s"} followed up, ${texts} customer text${texts === 1 ? "" : "s"}, ${booked} job${booked === 1 ? "" : "s"} booked. Open quotes: ${openQuotes}. Overdue invoices: ${overdue}.`;
  await queueOperatorAlertInTransaction(tx, { businessId: input.businessId, eventKind: "ownerBrief", eventKey: `ownerBrief:${localDate}`, subject: `${input.businessName}: today's brief`, body });
  return true;
}

/** Job, every few minutes per business. Safe to re-run: every send is claimed on a unique key first. */
export async function runAutomationSweep(context: DomainContext, input: { businessId: string; now?: Date }): Promise<Record<string, number>> {
  const now = input.now ?? new Date();
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const settings = await loadAssistantSettings(tx, input.businessId);
    const business = await loadBusinessBasics(tx, input.businessId);
    const rows = await tx.select({ kind: outreachAutomations.kind, messageTemplate: outreachAutomations.messageTemplate }).from(outreachAutomations).where(and(eq(outreachAutomations.businessId, input.businessId), eq(outreachAutomations.enabled, true)));
    const tally: Record<string, number> = {};
    const inWindow = isWithinContactWindow(now, business.timezone, { startMinutes: settings.contactWindowStartMinutes, endMinutes: settings.contactWindowEndMinutes });
    for (const row of rows) {
      const kind = row.kind as AutomationKind;
      if (!(automationKinds as readonly string[]).includes(kind) || !tierAllows(settings, featureFor(kind))) continue;
      if (kind === "owner_brief") {
        if (await sendOwnerBrief(tx, { businessId: input.businessId, businessName: business.name, timezone: business.timezone, now })) tally.owner_brief = 1;
        continue;
      }
      // Quiet hours: customers are never texted outside the contact window.
      if (!inWindow) continue;
      const template = row.messageTemplate ?? DEFAULT_TEMPLATES[kind];
      for (const candidate of await findCandidates(tx, kind, { businessId: input.businessId, now, settings })) {
        const result = await sendCandidate(tx, { businessId: input.businessId, businessName: business.name, template, candidate, now });
        tally[`${kind}:${result}`] = (tally[`${kind}:${result}`] ?? 0) + 1;
      }
    }
    return tally;
  });
}

/** Operator marks a job done, which is what review requests key off. */
export async function markAppointmentCompleted(context: DomainContext, input: { userId: string; businessId: string; appointmentId: string }): Promise<boolean> {
  return await withBusinessTransaction(context.db, { userId: input.userId, businessId: input.businessId, actorType: "operator" }, async (tx) => {
    await requireBusinessMembership(tx, { ...input, minimumRole: "scheduler" });
    const rows = await tx.update(appointments).set({ status: "completed", revision: sql`${appointments.revision} + 1`, updatedAt: new Date() })
      .where(and(eq(appointments.id, input.appointmentId), eq(appointments.businessId, input.businessId), eq(appointments.status, "confirmed")))
      .returning({ id: appointments.id });
    return rows.length > 0;
  });
}
