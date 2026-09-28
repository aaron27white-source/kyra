import { and, count, desc, eq } from "drizzle-orm";

import { contacts, invoices, quotes, withBusinessTransaction, type DatabaseTransaction, type LineItem } from "@lobbystack/db";

import type { DomainContext } from "../context";
import { requireBusinessMembership } from "../../authz";
import { formatCents, renderTemplate } from "./automations";
import { ensureSmsThread, queueAssistantSmsInTransaction } from "./missedCalls";
import { AssistantInputError, loadBusinessBasics, requireAssistantFeature } from "./settings";

export class NotFoundError extends Error {
  readonly status = 404;
  readonly code = "not_found";
}

const MAX_LINE_ITEMS = 50;
const MAX_CENTS = 100_000_000; // $1,000,000 per document is plenty for a trade job.

export function parseLineItems(value: unknown): { items: LineItem[]; totalCents: number } {
  if (!Array.isArray(value) || value.length === 0) throw new AssistantInputError("Add at least one line item.");
  if (value.length > MAX_LINE_ITEMS) throw new AssistantInputError(`Keep it to ${MAX_LINE_ITEMS} line items.`);
  const items = value.map((raw, index) => {
    const item = raw as Record<string, unknown>;
    const description = typeof item.description === "string" ? item.description.trim() : "";
    const quantity = item.quantity;
    const unitCents = item.unitCents;
    if (!description || description.length > 200) throw new AssistantInputError(`Line ${index + 1} needs a description of 200 characters or fewer.`);
    if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity <= 0 || quantity > 10_000) throw new AssistantInputError(`Line ${index + 1} needs a quantity above 0.`);
    if (typeof unitCents !== "number" || !Number.isInteger(unitCents) || unitCents < 0 || unitCents > MAX_CENTS) throw new AssistantInputError(`Line ${index + 1} needs a price in whole cents.`);
    return { description, quantity, unitCents };
  });
  const totalCents = Math.round(items.reduce((sum, item) => sum + item.quantity * item.unitCents, 0));
  if (totalCents > MAX_CENTS) throw new AssistantInputError("The total is too large.");
  return { items, totalCents };
}

async function requireContact(tx: DatabaseTransaction, businessId: string, contactId: unknown): Promise<string> {
  if (typeof contactId !== "string") throw new AssistantInputError("Choose a customer.");
  const row = (await tx.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.id, contactId), eq(contacts.businessId, businessId))).limit(1))[0];
  if (!row) throw new NotFoundError("Customer not found.");
  return row.id;
}

// ---- Estimates (quotes). Estimates are part of the Back Office add-on; Tier 3's
// quote follow-up reads the same table, so a Tier 3 business can log quotes too.

async function requireQuoteAccess(tx: DatabaseTransaction, businessId: string): Promise<void> {
  try {
    await requireAssistantFeature(tx, businessId, "back_office");
  } catch (error) {
    await requireAssistantFeature(tx, businessId, "outbound_automations").catch(() => { throw error; });
  }
}

export async function listQuotes(context: DomainContext, input: { userId: string; businessId: string }) {
  return await withBusinessTransaction(context.db, { userId: input.userId, businessId: input.businessId, actorType: "operator" }, async (tx) => {
    await requireBusinessMembership(tx, input);
    await requireQuoteAccess(tx, input.businessId);
    return await tx.select().from(quotes).where(eq(quotes.businessId, input.businessId)).orderBy(desc(quotes.createdAt)).limit(200);
  });
}

export async function createQuote(context: DomainContext, input: { userId: string; businessId: string; body: Record<string, unknown> }) {
  const title = typeof input.body.title === "string" ? input.body.title.trim() : "";
  if (!title || title.length > 200) throw new AssistantInputError("Give the quote a title of 200 characters or fewer.");
  const { items, totalCents } = parseLineItems(input.body.lineItems);
  const notes = typeof input.body.notes === "string" ? input.body.notes.trim().slice(0, 2000) || null : null;
  return await withBusinessTransaction(context.db, { userId: input.userId, businessId: input.businessId, actorType: "operator" }, async (tx) => {
    await requireBusinessMembership(tx, { ...input, minimumRole: "scheduler" });
    await requireQuoteAccess(tx, input.businessId);
    const contactId = await requireContact(tx, input.businessId, input.body.contactId);
    const [row] = await tx.insert(quotes).values({ businessId: input.businessId, contactId, title, amountCents: totalCents, lineItems: items, notes, createdByUserId: input.userId }).returning();
    return row!;
  });
}

const QUOTE_TRANSITIONS: Record<string, string[]> = { draft: ["sent"], sent: ["accepted", "declined", "expired"], accepted: [], declined: [], expired: [] };

/** Marks a quote sent (optionally texting it) or records the customer's decision. */
export async function setQuoteStatus(context: DomainContext, input: { userId: string; businessId: string; quoteId: string; status: unknown; textCustomer?: boolean }) {
  if (typeof input.status !== "string") throw new AssistantInputError("status is required.");
  return await withBusinessTransaction(context.db, { userId: input.userId, businessId: input.businessId, actorType: "operator" }, async (tx) => {
    await requireBusinessMembership(tx, { ...input, minimumRole: "scheduler" });
    await requireQuoteAccess(tx, input.businessId);
    const quote = (await tx.select().from(quotes).where(and(eq(quotes.id, input.quoteId), eq(quotes.businessId, input.businessId))).for("update").limit(1))[0];
    if (!quote) throw new NotFoundError("Quote not found.");
    if (!QUOTE_TRANSITIONS[quote.status]?.includes(input.status as string)) throw new AssistantInputError(`A ${quote.status} quote can't become ${input.status}.`);
    const now = new Date();
    const [row] = await tx.update(quotes).set({ status: input.status as string, ...(input.status === "sent" ? { sentAt: now } : { decidedAt: now }), updatedAt: now }).where(eq(quotes.id, quote.id)).returning();
    if (input.status === "sent" && input.textCustomer) {
      const business = await loadBusinessBasics(tx, input.businessId);
      await textContact(tx, { businessId: input.businessId, contactId: quote.contactId, kind: "quote_sent", template: "Hi {name}, here's your quote from {business} for {title}: {amount}. Reply here with any questions.", values: { business: business.name, title: quote.title, amount: formatCents(quote.amountCents, quote.currency) } });
    }
    return row!;
  });
}

// ---- Invoices (Back Office add-on only).

export async function listInvoices(context: DomainContext, input: { userId: string; businessId: string }) {
  return await withBusinessTransaction(context.db, { userId: input.userId, businessId: input.businessId, actorType: "operator" }, async (tx) => {
    await requireBusinessMembership(tx, input);
    await requireAssistantFeature(tx, input.businessId, "back_office");
    return await tx.select().from(invoices).where(eq(invoices.businessId, input.businessId)).orderBy(desc(invoices.createdAt)).limit(200);
  });
}

function parseDueDate(value: unknown): Date | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new AssistantInputError("dueAt must be a date.");
  const due = new Date(value);
  if (Number.isNaN(due.getTime())) throw new AssistantInputError("dueAt must be a date.");
  return due;
}

function parsePaymentUrl(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^https:\/\/[^\s]{4,490}$/.test(value.trim())) throw new AssistantInputError("The payment link must start with https://.");
  return value.trim();
}

export async function createInvoice(context: DomainContext, input: { userId: string; businessId: string; body: Record<string, unknown> }) {
  const { items, totalCents } = parseLineItems(input.body.lineItems);
  const dueAt = parseDueDate(input.body.dueAt);
  const paymentUrl = parsePaymentUrl(input.body.paymentUrl);
  const notes = typeof input.body.notes === "string" ? input.body.notes.trim().slice(0, 2000) || null : null;
  return await withBusinessTransaction(context.db, { userId: input.userId, businessId: input.businessId, actorType: "operator" }, async (tx) => {
    await requireBusinessMembership(tx, { ...input, minimumRole: "business_admin" });
    await requireAssistantFeature(tx, input.businessId, "back_office");
    const contactId = await requireContact(tx, input.businessId, input.body.contactId);
    const quoteId = typeof input.body.quoteId === "string" ? (await tx.select({ id: quotes.id }).from(quotes).where(and(eq(quotes.id, input.body.quoteId), eq(quotes.businessId, input.businessId))).limit(1))[0]?.id ?? null : null;
    const [{ value: existing } = { value: 0 }] = await tx.select({ value: count() }).from(invoices).where(eq(invoices.businessId, input.businessId));
    const number = `INV-${String(existing + 1).padStart(4, "0")}`;
    const [row] = await tx.insert(invoices).values({ businessId: input.businessId, contactId, quoteId, number, totalCents, lineItems: items, paymentUrl, dueAt, notes, createdByUserId: input.userId }).returning();
    return row!;
  });
}

const INVOICE_TRANSITIONS: Record<string, string[]> = { draft: ["sent", "void"], sent: ["paid", "void"], paid: [], void: [] };

export async function setInvoiceStatus(context: DomainContext, input: { userId: string; businessId: string; invoiceId: string; status: unknown; textCustomer?: boolean }) {
  if (typeof input.status !== "string") throw new AssistantInputError("status is required.");
  return await withBusinessTransaction(context.db, { userId: input.userId, businessId: input.businessId, actorType: "operator" }, async (tx) => {
    await requireBusinessMembership(tx, { ...input, minimumRole: "business_admin" });
    await requireAssistantFeature(tx, input.businessId, "back_office");
    const invoice = (await tx.select().from(invoices).where(and(eq(invoices.id, input.invoiceId), eq(invoices.businessId, input.businessId))).for("update").limit(1))[0];
    if (!invoice) throw new NotFoundError("Invoice not found.");
    if (!INVOICE_TRANSITIONS[invoice.status]?.includes(input.status as string)) throw new AssistantInputError(`A ${invoice.status} invoice can't become ${input.status}.`);
    const now = new Date();
    const [row] = await tx.update(invoices).set({ status: input.status as string, ...(input.status === "sent" ? { sentAt: now } : {}), ...(input.status === "paid" ? { paidAt: now } : {}), updatedAt: now }).where(eq(invoices.id, invoice.id)).returning();
    if (input.status === "sent" && input.textCustomer) {
      const business = await loadBusinessBasics(tx, input.businessId);
      const template = invoice.paymentUrl ? "Hi {name}, invoice {number} from {business} for {amount} is ready. Pay here: {link}" : "Hi {name}, invoice {number} from {business} for {amount} is ready. Reply here with any questions.";
      await textContact(tx, { businessId: input.businessId, contactId: invoice.contactId, kind: "invoice_sent", template, values: { business: business.name, number: invoice.number, amount: formatCents(invoice.totalCents, invoice.currency), link: invoice.paymentUrl ?? "" } });
    }
    return row!;
  });
}

async function textContact(tx: DatabaseTransaction, input: { businessId: string; contactId: string; kind: string; template: string; values: Record<string, string> }): Promise<void> {
  const contact = (await tx.select({ phone: contacts.phone, name: contacts.name, smsConsentStatus: contacts.smsConsentStatus, operatorBlockedAt: contacts.operatorBlockedAt }).from(contacts).where(and(eq(contacts.id, input.contactId), eq(contacts.businessId, input.businessId))).limit(1))[0];
  if (!contact?.phone || contact.operatorBlockedAt || contact.smsConsentStatus !== "subscribed") throw new AssistantInputError("This customer can't be texted. They haven't agreed to texts or they opted out.");
  const thread = await ensureSmsThread(tx, input.businessId, contact.phone);
  const body = renderTemplate(input.template, { name: contact.name?.split(" ")[0] ?? "", ...input.values });
  await queueAssistantSmsInTransaction(tx, { businessId: input.businessId, conversationId: thread.conversationId, sessionId: thread.sessionId, body, aiGenerated: false, kind: input.kind });
}
