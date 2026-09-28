import { randomBytes } from "node:crypto";

import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";

import { businessHours, closures, contacts, conversationSessions, conversations, enqueueOutbox, messages, missedCalls, phoneNumbers, smsConsentEvents, withBusinessTransaction, type DatabaseTransaction } from "@lobbystack/db";
import { isWithinContactWindow, missedCallGreeting, renderTextBack, tierAllows, type AssistantLanguage } from "@lobbystack/shared";

import type { DomainContext } from "../context";
import { queueOperatorAlertInTransaction } from "../notifications";
import { requireBusinessMembership } from "../../authz";
import { openingState } from "./hours";
import { loadAssistantSettings, loadBusinessBasics, type AssistantSettings } from "./settings";

export const REPEAT_CALL_COOLDOWN_MS = 15 * 60_000;
// Consent to an AI call is only good for a short while after the missed call.
export const CALLBACK_CONSENT_WINDOW_MS = 24 * 60 * 60_000;

// Twilio's placeholders for withheld caller ID. There's nobody to text back.
const WITHHELD_CALLERS = new Set(["+266696687", "+7378742833", "+2562533", "+8656696"]);
const DIALLABLE = /^\+[1-9]\d{9,14}$/;

export function isTextableCaller(phone: string): boolean {
  return DIALLABLE.test(phone) && !WITHHELD_CALLERS.has(phone);
}

type SmsThread = {
  contactId: string;
  conversationId: string;
  sessionId: string;
  optedOut: boolean;
  preferredLocale: string | null;
  automationState: string;
};

/** Finds or opens the customer's SMS thread, the same records inbound texts use. */
export async function ensureSmsThread(tx: DatabaseTransaction, businessId: string, phone: string): Promise<SmsThread> {
  const existing = (await tx.select({ id: contacts.id, smsConsentStatus: contacts.smsConsentStatus, operatorBlockedAt: contacts.operatorBlockedAt, preferredLocale: contacts.preferredLocale }).from(contacts).where(and(eq(contacts.businessId, businessId), eq(contacts.phone, phone))).limit(1))[0];
  const contact = existing ?? (await tx.insert(contacts).values({ businessId, phone }).returning({ id: contacts.id, smsConsentStatus: contacts.smsConsentStatus, operatorBlockedAt: contacts.operatorBlockedAt, preferredLocale: contacts.preferredLocale }))[0];
  if (!contact) throw new Error("The caller's contact could not be created.");
  const conversation = (await tx.select({ id: conversations.id, automationState: conversations.automationState }).from(conversations).where(and(eq(conversations.businessId, businessId), eq(conversations.contactId, contact.id), eq(conversations.channel, "sms"), eq(conversations.status, "open"))).orderBy(desc(conversations.updatedAt)).limit(1))[0]
    ?? (await tx.insert(conversations).values({ businessId, contactId: contact.id, channel: "sms", status: "open", automationState: "ai_active" }).returning({ id: conversations.id, automationState: conversations.automationState }))[0];
  if (!conversation) throw new Error("The caller's conversation could not be created.");
  const session = (await tx.select({ id: conversationSessions.id }).from(conversationSessions).where(and(eq(conversationSessions.businessId, businessId), eq(conversationSessions.conversationId, conversation.id), eq(conversationSessions.status, "open"))).orderBy(desc(conversationSessions.startedAt)).limit(1))[0]
    ?? (await tx.insert(conversationSessions).values({ businessId, conversationId: conversation.id, channel: "sms", status: "open" }).returning({ id: conversationSessions.id }))[0];
  if (!session) throw new Error("The caller's conversation session could not be created.");
  return {
    contactId: contact.id,
    conversationId: conversation.id,
    sessionId: session.id,
    optedOut: Boolean(contact.operatorBlockedAt) || contact.smsConsentStatus === "opted_out",
    preferredLocale: contact.preferredLocale,
    automationState: conversation.automationState,
  };
}

/**
 * Queues an outbound text in the customer's thread. The send job re-checks
 * consent at delivery time, so a STOP that lands in between still wins.
 */
export async function queueAssistantSmsInTransaction(tx: DatabaseTransaction, input: { businessId: string; conversationId: string; sessionId?: string; body: string; aiGenerated: boolean; kind: string }): Promise<string> {
  const [message] = await tx.insert(messages).values({
    businessId: input.businessId,
    conversationId: input.conversationId,
    ...(input.sessionId ? { conversationSessionId: input.sessionId } : {}),
    direction: "outbound",
    channel: "sms",
    body: input.body,
    aiGenerated: input.aiGenerated,
    senderRole: input.aiGenerated ? "assistant" : "system",
    status: "queued",
    providerStatus: input.kind,
  }).returning({ id: messages.id });
  if (!message) throw new Error("The text could not be queued.");
  await tx.update(conversations).set({ updatedAt: new Date() }).where(and(eq(conversations.id, input.conversationId), eq(conversations.businessId, input.businessId)));
  await enqueueOutbox(tx, { topic: "realtime.publish", businessId: input.businessId, aggregateType: "message", aggregateId: message.id, dedupeKey: `message:${message.id}:created`, payload: { type: "message.upserted", entityId: message.id, conversationId: input.conversationId } });
  await enqueueOutbox(tx, { topic: "sms.send", businessId: input.businessId, aggregateType: "message", aggregateId: message.id, dedupeKey: `message:${message.id}:send`, payload: { messageId: message.id } });
  return message.id;
}

/**
 * A person called the business and hung up unanswered: texting them back about
 * that call is a reply they started. Recorded so the send path (which requires
 * a subscribed contact) allows it, and so there's a trail. A STOP always wins.
 */
export async function recordImpliedConsent(tx: DatabaseTransaction, input: { businessId: string; contactId: string; phone: string; source?: string }): Promise<void> {
  const now = new Date();
  const source = input.source ?? "missed_call_inbound";
  const updated = await tx.update(contacts).set({ smsConsentStatus: "subscribed", smsConsentSource: source, smsConsentUpdatedAt: now, updatedAt: now })
    .where(and(eq(contacts.id, input.contactId), eq(contacts.businessId, input.businessId), isNull(contacts.smsConsentStatus)))
    .returning({ id: contacts.id });
  if (updated.length) await tx.insert(smsConsentEvents).values({ businessId: input.businessId, contactId: input.contactId, phone: input.phone, recipientType: "contact", action: "subscribed", source });
}

function languageFor(thread: SmsThread, defaultLocale: string): AssistantLanguage {
  return (thread.preferredLocale ?? defaultLocale).startsWith("es") ? "es" : "en";
}

async function loadHours(tx: DatabaseTransaction, businessId: string, now: Date) {
  const weekly = await tx.select({ dayOfWeek: businessHours.dayOfWeek, openMinutes: businessHours.openMinutes, closeMinutes: businessHours.closeMinutes }).from(businessHours).where(eq(businessHours.businessId, businessId));
  const upcoming = await tx.select({ startsAt: closures.startsAt, endsAt: closures.endsAt }).from(closures).where(and(eq(closures.businessId, businessId), gte(closures.endsAt, now)));
  return { weekly, upcoming };
}

export type MissedCallResult = { greeting: string; missedCallId: string | null; action: "texting" | "calling_back" | "held" | "repeat" | "opted_out" | "skipped" | "duplicate" };

/**
 * Called from the Twilio voice webhook for a Tier 1 number: the business
 * didn't answer and the carrier forwarded the call here. Records it, decides
 * what happens next, and returns the greeting to play before hanging up.
 */
export async function recordMissedCall(
  context: DomainContext,
  input: { businessId: string; providerCallId: string; from: string; to: string; now?: Date },
): Promise<MissedCallResult> {
  const now = input.now ?? new Date();
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const settings = await loadAssistantSettings(tx, input.businessId);
    const business = await loadBusinessBasics(tx, input.businessId);
    const greeting = missedCallGreeting({ businessName: business.name, voiceCallbackEnabled: settings.voiceCallbackEnabled && tierAllows(settings, "voice_callback"), callbackMode: settings.callbackMode, customGreeting: settings.missedCallGreeting });

    const duplicate = (await tx.select({ id: missedCalls.id }).from(missedCalls).where(and(eq(missedCalls.businessId, input.businessId), eq(missedCalls.providerCallId, input.providerCallId))).limit(1))[0];
    if (duplicate) return { greeting, missedCallId: duplicate.id, action: "duplicate" };

    if (!settings.missedCallTextEnabled || !isTextableCaller(input.from)) {
      const [row] = await tx.insert(missedCalls).values({ businessId: input.businessId, providerCallId: input.providerCallId, callerPhone: input.from.slice(0, 32), dialledPhone: input.to.slice(0, 32), receivedAt: now, status: "skipped" }).returning({ id: missedCalls.id });
      return { greeting, missedCallId: row?.id ?? null, action: "skipped" };
    }

    const thread = await ensureSmsThread(tx, input.businessId, input.from);
    const recent = (await tx.select({ id: missedCalls.id }).from(missedCalls).where(and(eq(missedCalls.businessId, input.businessId), eq(missedCalls.callerPhone, input.from), isNull(missedCalls.repeatOfId), gte(missedCalls.receivedAt, new Date(now.getTime() - REPEAT_CALL_COOLDOWN_MS)))).orderBy(desc(missedCalls.receivedAt)).limit(1))[0];
    const { weekly, upcoming } = await loadHours(tx, input.businessId, now);
    const afterHours = !openingState(now, business.timezone, weekly, upcoming).open;
    const base = { businessId: input.businessId, contactId: thread.contactId, conversationId: thread.conversationId, providerCallId: input.providerCallId, callerPhone: input.from, dialledPhone: input.to, receivedAt: now, afterHours };

    if (recent) {
      const [row] = await tx.insert(missedCalls).values({ ...base, repeatOfId: recent.id, status: "skipped" }).returning({ id: missedCalls.id });
      return { greeting, missedCallId: row?.id ?? null, action: "repeat" };
    }
    if (thread.optedOut) {
      const [row] = await tx.insert(missedCalls).values({ ...base, status: "opted_out" }).returning({ id: missedCalls.id });
      return { greeting, missedCallId: row?.id ?? null, action: "opted_out" };
    }

    await recordImpliedConsent(tx, { businessId: input.businessId, contactId: thread.contactId, phone: input.from });
    const voiceOn = settings.voiceCallbackEnabled && tierAllows(settings, "voice_callback");
    const [row] = await tx.insert(missedCalls).values({ ...base, status: "new", ...(voiceOn ? { callbackToken: randomBytes(24).toString("hex") } : {}) }).returning({ id: missedCalls.id });
    if (!row) throw new Error("The missed call could not be recorded.");
    await enqueueOutbox(tx, { topic: "missedCall.process", businessId: input.businessId, aggregateType: "missed_call", aggregateId: row.id, dedupeKey: `missed-call:${row.id}:process`, payload: { missedCallId: row.id } });
    await queueOperatorAlertInTransaction(tx, { businessId: input.businessId, eventKind: "missedCall", eventKey: `missedCall:${row.id}`, subject: `Missed call from ${input.from}`, body: afterHours ? `${input.from} called after hours. The assistant is following up.` : `${input.from} called and nobody picked up. The assistant is following up.` });
    const action = voiceOn && settings.callbackMode === "automatic" ? "calling_back" : afterHours && settings.afterHoursMode === "hold" ? "held" : "texting";
    return { greeting, missedCallId: row.id, action };
  });
}

type ProcessOutcome = "texted" | "awaiting_consent" | "held" | "callback_queued" | "opted_out" | "skipped";

/**
 * Job: decide and act on a recorded missed call. Idempotent: it only moves a
 * call out of `new` (or a due `held`), and the outbox dedupes the send.
 */
export async function processMissedCall(context: DomainContext, input: { businessId: string; missedCallId: string; now?: Date }): Promise<ProcessOutcome> {
  const now = input.now ?? new Date();
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const row = (await tx.select().from(missedCalls).where(and(eq(missedCalls.id, input.missedCallId), eq(missedCalls.businessId, input.businessId))).for("update").limit(1))[0];
    if (!row || !(row.status === "new" || row.status === "held")) return "skipped";
    if (row.status === "held" && row.textBackDueAt && row.textBackDueAt > now) return "held";
    const settings = await loadAssistantSettings(tx, input.businessId);
    const business = await loadBusinessBasics(tx, input.businessId);
    const thread = await ensureSmsThread(tx, input.businessId, row.callerPhone);
    if (thread.optedOut) {
      await tx.update(missedCalls).set({ status: "opted_out", updatedAt: now }).where(eq(missedCalls.id, row.id));
      return "opted_out";
    }

    const voiceOn = settings.voiceCallbackEnabled && tierAllows(settings, "voice_callback") && Boolean(row.callbackToken);
    const window = { startMinutes: settings.contactWindowStartMinutes, endMinutes: settings.contactWindowEndMinutes };
    if (voiceOn && settings.callbackMode === "automatic" && isWithinContactWindow(now, business.timezone, window)) {
      const due = new Date(now.getTime() + settings.callbackDelaySeconds * 1000);
      await tx.update(missedCalls).set({ status: "callback_queued", callbackDueAt: due, updatedAt: now }).where(eq(missedCalls.id, row.id));
      await enqueueOutbox(tx, { topic: "missedCall.callback", businessId: input.businessId, aggregateType: "missed_call", aggregateId: row.id, dedupeKey: `missed-call:${row.id}:callback`, payload: { missedCallId: row.id }, availableAt: due });
      return "callback_queued";
    }

    if (row.status === "new" && row.afterHours && settings.afterHoursMode === "hold") {
      const { weekly, upcoming } = await loadHours(tx, input.businessId, now);
      const opensAt = openingState(now, business.timezone, weekly, upcoming).nextOpenAt;
      if (opensAt) {
        await tx.update(missedCalls).set({ status: "held", textBackDueAt: opensAt, updatedAt: now }).where(eq(missedCalls.id, row.id));
        await enqueueOutbox(tx, { topic: "missedCall.process", businessId: input.businessId, aggregateType: "missed_call", aggregateId: row.id, dedupeKey: `missed-call:${row.id}:process:held`, payload: { missedCallId: row.id }, availableAt: opensAt });
        return "held";
      }
    }

    const outcome = await sendTextBackInTransaction(tx, { settings, businessName: business.name, defaultLocale: business.defaultLocale, missedCallId: row.id, thread, offerCall: voiceOn && settings.callbackMode === "ask_first", now });
    return outcome;
  });
}

async function sendTextBackInTransaction(tx: DatabaseTransaction, input: { settings: AssistantSettings; businessName: string; defaultLocale: string; missedCallId: string; thread: SmsThread; offerCall: boolean; now: Date }): Promise<"texted" | "awaiting_consent"> {
  const language = languageFor(input.thread, input.defaultLocale);
  const body = renderTextBack({
    businessName: input.businessName,
    voiceCallbackEnabled: input.offerCall,
    callbackMode: "ask_first",
    photoRequestsEnabled: input.settings.photoRequestsEnabled,
    customMessage: language === "es" ? input.settings.textBackMessageEs : input.settings.textBackMessage,
  }, language);
  const messageId = await queueAssistantSmsInTransaction(tx, { businessId: input.settings.businessId, conversationId: input.thread.conversationId, sessionId: input.thread.sessionId, body, aiGenerated: false, kind: "missed_call_text_back" });
  const now = input.now;
  const status = input.offerCall ? "awaiting_consent" : "texted";
  await tx.update(missedCalls).set({ status, textBackMessageId: messageId, ...(input.offerCall ? { consentRequestedAt: now, consentMessageId: messageId } : {}), updatedAt: now }).where(and(eq(missedCalls.id, input.missedCallId), eq(missedCalls.businessId, input.settings.businessId)));
  return status;
}

/** Sends the text-back if the AI callback didn't reach the customer. */
export async function sendFallbackTextBack(context: DomainContext, input: { businessId: string; missedCallId: string; now?: Date }): Promise<boolean> {
  const now = input.now ?? new Date();
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const row = (await tx.select().from(missedCalls).where(and(eq(missedCalls.id, input.missedCallId), eq(missedCalls.businessId, input.businessId))).for("update").limit(1))[0];
    if (!row || row.textBackMessageId) return false;
    const settings = await loadAssistantSettings(tx, input.businessId);
    const business = await loadBusinessBasics(tx, input.businessId);
    const thread = await ensureSmsThread(tx, input.businessId, row.callerPhone);
    if (thread.optedOut) return false;
    await sendTextBackInTransaction(tx, { settings, businessName: business.name, defaultLocale: business.defaultLocale, missedCallId: row.id, thread, offerCall: false, now });
    await tx.update(missedCalls).set({ status: "not_reached", updatedAt: now }).where(eq(missedCalls.id, row.id));
    return true;
  });
}

/**
 * The customer replied YES to "want a call now?". Only an explicit yes, from the
 * texted number, inside the consent window, for a call still waiting on consent.
 * The message id is kept as evidence.
 */
export async function grantCallbackConsentInTransaction(tx: DatabaseTransaction, input: { businessId: string; contactId: string; messageId: string; now?: Date }): Promise<string | null> {
  const now = input.now ?? new Date();
  const row = (await tx.select({ id: missedCalls.id }).from(missedCalls).where(and(
    eq(missedCalls.businessId, input.businessId),
    eq(missedCalls.contactId, input.contactId),
    eq(missedCalls.status, "awaiting_consent"),
    gte(missedCalls.consentRequestedAt, new Date(now.getTime() - CALLBACK_CONSENT_WINDOW_MS)),
  )).orderBy(desc(missedCalls.receivedAt)).for("update").limit(1))[0];
  if (!row) return null;
  await tx.update(missedCalls).set({ status: "callback_queued", consentGrantedAt: now, consentMessageId: input.messageId, callbackDueAt: now, updatedAt: now }).where(eq(missedCalls.id, row.id));
  await enqueueOutbox(tx, { topic: "missedCall.callback", businessId: input.businessId, aggregateType: "missed_call", aggregateId: row.id, dedupeKey: `missed-call:${row.id}:callback`, payload: { missedCallId: row.id } });
  return row.id;
}

export type CallbackTarget = { to: string; from: string; token: string; businessName: string; language: AssistantLanguage };

/**
 * Claims the single callback attempt for a missed call, after checking every
 * rule on the server. Returns null (and says why) when the call must not happen.
 */
export async function claimCallbackAttempt(context: DomainContext, input: { businessId: string; missedCallId: string; now?: Date }): Promise<{ target: CallbackTarget } | { skipped: string }> {
  const now = input.now ?? new Date();
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const row = (await tx.select().from(missedCalls).where(and(eq(missedCalls.id, input.missedCallId), eq(missedCalls.businessId, input.businessId))).for("update").limit(1))[0];
    if (!row) return { skipped: "not_found" };
    if (row.callbackAttemptedAt || row.status !== "callback_queued") return { skipped: "already_attempted" };
    if (!row.callbackToken) return { skipped: "no_token" };
    const settings = await loadAssistantSettings(tx, input.businessId);
    const business = await loadBusinessBasics(tx, input.businessId);
    const reject = async (reason: string) => {
      await tx.update(missedCalls).set({ status: "not_reached", callbackOutcome: reason, updatedAt: now }).where(eq(missedCalls.id, row.id));
      await enqueueOutbox(tx, { topic: "missedCall.process", businessId: input.businessId, aggregateType: "missed_call", aggregateId: row.id, dedupeKey: `missed-call:${row.id}:fallback`, payload: { missedCallId: row.id, fallback: true } });
      return { skipped: reason };
    };
    if (!settings.voiceCallbackEnabled || !tierAllows(settings, "voice_callback")) return await reject("voice_off");
    if (settings.callbackMode === "ask_first" && !row.consentGrantedAt) return await reject("no_consent");
    if (!isWithinContactWindow(now, business.timezone, { startMinutes: settings.contactWindowStartMinutes, endMinutes: settings.contactWindowEndMinutes })) return await reject("outside_contact_window");
    const thread = await ensureSmsThread(tx, input.businessId, row.callerPhone);
    if (thread.optedOut) return await reject("opted_out");
    const line = (await tx.select({ e164: phoneNumbers.e164 }).from(phoneNumbers).where(and(eq(phoneNumbers.businessId, input.businessId), eq(phoneNumbers.status, "active"), eq(phoneNumbers.voiceEnabled, true))).limit(1))[0];
    if (!line) return await reject("no_business_number");
    // The claim: one attempt per missed call, ever.
    const claimed = await tx.update(missedCalls).set({ status: "calling", callbackAttemptedAt: now, updatedAt: now }).where(and(eq(missedCalls.id, row.id), isNull(missedCalls.callbackAttemptedAt))).returning({ id: missedCalls.id });
    if (!claimed.length) return { skipped: "already_attempted" };
    return { target: { to: row.callerPhone, from: line.e164, token: row.callbackToken, businessName: business.name, language: languageFor(thread, business.defaultLocale) } };
  });
}

export async function recordCallbackDialed(context: DomainContext, input: { businessId: string; missedCallId: string; providerCallId: string }): Promise<void> {
  await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    await tx.update(missedCalls).set({ callbackProviderCallId: input.providerCallId, updatedAt: new Date() }).where(and(eq(missedCalls.id, input.missedCallId), eq(missedCalls.businessId, input.businessId)));
  });
}

/** Resolves an opaque callback token to its business, for webhooks that arrive without one. */
export async function resolveMissedCallCallback(context: DomainContext, token: string): Promise<{ businessId: string; missedCallId: string } | null> {
  if (!/^[a-f0-9]{48}$/.test(token)) return null;
  const result = await context.db.execute<{ business_id: string; missed_call_id: string }>(sql`select business_id, missed_call_id from app.resolve_missed_call_callback(${token})`);
  const row = result.rows[0];
  return row ? { businessId: row.business_id, missedCallId: row.missed_call_id } : null;
}

const REACHED_STATUSES = new Set(["completed", "in-progress", "answered"]);

/** Twilio status callback for the outbound AI call. Not reached means the texts take over. */
export async function recordCallbackOutcome(context: DomainContext, input: { token: string; callStatus: string; durationSeconds?: number }): Promise<"reached" | "not_reached" | "ignored"> {
  const resolved = await resolveMissedCallCallback(context, input.token);
  if (!resolved) return "ignored";
  const status = input.callStatus.toLowerCase();
  const terminal = ["completed", "busy", "no-answer", "failed", "canceled"].includes(status);
  if (!terminal) return "ignored";
  // A "completed" call that lasted a few seconds hit voicemail or hung up at once.
  const reached = REACHED_STATUSES.has(status) && (input.durationSeconds ?? 0) >= 10;
  await withBusinessTransaction(context.db, { businessId: resolved.businessId, actorType: "worker" }, async (tx) => {
    await tx.update(missedCalls).set({ status: reached ? "reached" : "not_reached", callbackOutcome: status, updatedAt: new Date() }).where(and(eq(missedCalls.id, resolved.missedCallId), eq(missedCalls.businessId, resolved.businessId), eq(missedCalls.status, "calling")));
  });
  if (!reached) await sendFallbackTextBack(context, resolved);
  return reached ? "reached" : "not_reached";
}

export async function loadCallbackContext(context: DomainContext, input: { businessId: string; missedCallId: string }): Promise<{ callerPhone: string; receivedAt: Date; conversationId: string | null } | null> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const row = (await tx.select({ callerPhone: missedCalls.callerPhone, receivedAt: missedCalls.receivedAt, conversationId: missedCalls.conversationId }).from(missedCalls).where(and(eq(missedCalls.id, input.missedCallId), eq(missedCalls.businessId, input.businessId))).limit(1))[0];
    return row ?? null;
  });
}

/** Dashboard list, newest first. Operators see only their own business (membership + RLS). */
export async function listMissedCalls(context: DomainContext, input: { userId: string; businessId: string; limit?: number }) {
  return await withBusinessTransaction(context.db, { userId: input.userId, businessId: input.businessId, actorType: "operator" }, async (tx) => {
    await requireBusinessMembership(tx, input);
    return await tx.select({
      id: missedCalls.id,
      callerPhone: missedCalls.callerPhone,
      receivedAt: missedCalls.receivedAt,
      afterHours: missedCalls.afterHours,
      status: missedCalls.status,
      conversationId: missedCalls.conversationId,
      consentGrantedAt: missedCalls.consentGrantedAt,
      callbackAttemptedAt: missedCalls.callbackAttemptedAt,
      callbackOutcome: missedCalls.callbackOutcome,
    }).from(missedCalls).where(eq(missedCalls.businessId, input.businessId)).orderBy(desc(missedCalls.receivedAt)).limit(Math.min(Math.max(input.limit ?? 100, 1), 200));
  });
}
