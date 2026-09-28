import { and, asc, count, desc, eq, gte } from "drizzle-orm";

import { contacts, conversations, enqueueOutbox, messages, withBusinessTransaction, type DatabaseTransaction } from "@lobbystack/db";
import { EMERGENCY_REPLY, detectEmergency, guessLanguage, isAffirmativeReply, tierAllows, type AssistantLanguage, type EmergencyKind } from "@lobbystack/shared";

import type { DomainContext } from "../context";
import { queueOperatorAlertInTransaction } from "../notifications";
import { grantCallbackConsentInTransaction, queueAssistantSmsInTransaction } from "./missedCalls";
import { loadAssistantSettings } from "./settings";

// Two bots texting each other, or a customer who never stops: hand over to a person.
export const MAX_AI_SMS_REPLIES_PER_DAY = 25;
const HISTORY_LIMIT = 20;

const CALLING_NOW: Record<AssistantLanguage, string> = {
  en: "Great, Kyra is calling you now.",
  es: "Perfecto, Kyra le está llamando ahora.",
};

export type SmsReplyPlan =
  | { kind: "none"; reason: string }
  | {
    kind: "ai";
    conversationId: string;
    sessionId: string | null;
    callerPhone: string;
    language: AssistantLanguage;
    photoRequestsEnabled: boolean;
    emergency: EmergencyKind | null;
    history: Array<{ role: "user" | "assistant"; content: string }>;
  };

/**
 * Job step 1, before any AI: decide what a new inbound text needs. The
 * emergency reply and the callback consent are handled here, deterministically,
 * so no model output can skip or reword them.
 */
export async function planAssistantSmsReply(context: DomainContext, input: { businessId: string; messageId: string; now?: Date }): Promise<SmsReplyPlan> {
  const now = input.now ?? new Date();
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const inbound = (await tx.select({ id: messages.id, body: messages.body, conversationId: messages.conversationId, sessionId: messages.conversationSessionId, direction: messages.direction, channel: messages.channel, media: messages.media })
      .from(messages).where(and(eq(messages.id, input.messageId), eq(messages.businessId, input.businessId))).limit(1))[0];
    if (!inbound || inbound.direction !== "inbound" || inbound.channel !== "sms") return { kind: "none", reason: "not_inbound_sms" };
    const conversation = (await tx.select({ id: conversations.id, contactId: conversations.contactId, automationState: conversations.automationState, locale: conversations.locale })
      .from(conversations).where(and(eq(conversations.id, inbound.conversationId), eq(conversations.businessId, input.businessId))).limit(1))[0];
    if (!conversation?.contactId) return { kind: "none", reason: "no_contact" };
    const contact = (await tx.select({ phone: contacts.phone, smsConsentStatus: contacts.smsConsentStatus, operatorBlockedAt: contacts.operatorBlockedAt, preferredLocale: contacts.preferredLocale })
      .from(contacts).where(and(eq(contacts.id, conversation.contactId), eq(contacts.businessId, input.businessId))).limit(1))[0];
    if (!contact?.phone || contact.operatorBlockedAt || contact.smsConsentStatus === "opted_out") return { kind: "none", reason: "opted_out" };

    // Newer inbound texts get their own job; only the latest one is answered.
    const latestInbound = (await tx.select({ id: messages.id }).from(messages).where(and(eq(messages.businessId, input.businessId), eq(messages.conversationId, conversation.id), eq(messages.direction, "inbound"))).orderBy(desc(messages.createdAt)).limit(1))[0];
    if (latestInbound && latestInbound.id !== inbound.id) return { kind: "none", reason: "superseded" };

    const settings = await loadAssistantSettings(tx, input.businessId);
    const language: AssistantLanguage = conversation.locale?.startsWith("es") || contact.preferredLocale?.startsWith("es") ? "es" : guessLanguage(inbound.body);
    if ((conversation.locale ?? null) === null) await tx.update(conversations).set({ locale: language }).where(and(eq(conversations.id, conversation.id), eq(conversations.businessId, input.businessId)));

    const emergency = detectEmergency(inbound.body);
    if (emergency) await handleEmergencyInTransaction(tx, { businessId: input.businessId, conversationId: conversation.id, sessionId: inbound.sessionId, callerPhone: contact.phone, text: inbound.body, kind: emergency, language, emergencyPhone: settings.emergencyPhone });

    if (!emergency && isAffirmativeReply(inbound.body) && settings.voiceCallbackEnabled && tierAllows(settings, "voice_callback")) {
      const granted = await grantCallbackConsentInTransaction(tx, { businessId: input.businessId, contactId: conversation.contactId, messageId: inbound.id, now });
      if (granted) {
        await queueAssistantSmsInTransaction(tx, { businessId: input.businessId, conversationId: conversation.id, ...(inbound.sessionId ? { sessionId: inbound.sessionId } : {}), body: CALLING_NOW[language], aiGenerated: false, kind: "callback_consent_ack" });
        return { kind: "none", reason: "callback_consent" };
      }
    }

    if (!settings.smsAiEnabled || !tierAllows(settings, "sms_ai")) return { kind: "none", reason: "ai_off" };
    if (conversation.automationState !== "ai_active") return { kind: "none", reason: "human_handoff" };

    const [{ value: repliesToday } = { value: 0 }] = await tx.select({ value: count() }).from(messages).where(and(eq(messages.businessId, input.businessId), eq(messages.conversationId, conversation.id), eq(messages.direction, "outbound"), eq(messages.aiGenerated, true), gte(messages.createdAt, new Date(now.getTime() - 86_400_000))));
    if (repliesToday >= MAX_AI_SMS_REPLIES_PER_DAY) {
      await tx.update(conversations).set({ automationState: "human_handoff", automationPausedAt: now, updatedAt: now }).where(and(eq(conversations.id, conversation.id), eq(conversations.businessId, input.businessId)));
      await queueOperatorAlertInTransaction(tx, { businessId: input.businessId, eventKind: "pausedSms", eventKey: `pausedSms:limit:${conversation.id}:${now.toISOString().slice(0, 10)}`, subject: "Text conversation handed to you", body: `The assistant paused after ${MAX_AI_SMS_REPLIES_PER_DAY} replies today with ${contact.phone}. Open the inbox to take over.` });
      return { kind: "none", reason: "daily_limit" };
    }

    const rows = await tx.select({ direction: messages.direction, body: messages.body, media: messages.media }).from(messages)
      .where(and(eq(messages.businessId, input.businessId), eq(messages.conversationId, conversation.id)))
      .orderBy(desc(messages.createdAt)).limit(HISTORY_LIMIT);
    const history = rows.reverse().map((row) => {
      const photos = Array.isArray(row.media) ? row.media.length : 0;
      const note = photos ? ` [sent ${photos} photo${photos === 1 ? "" : "s"}]` : "";
      return { role: row.direction === "inbound" ? "user" as const : "assistant" as const, content: `${row.body}${note}`.trim() || "[photo]" };
    });
    return { kind: "ai", conversationId: conversation.id, sessionId: inbound.sessionId, callerPhone: contact.phone, language, photoRequestsEnabled: settings.photoRequestsEnabled, emergency, history };
  });
}

async function handleEmergencyInTransaction(tx: DatabaseTransaction, input: { businessId: string; conversationId: string; sessionId: string | null; callerPhone: string; text: string; kind: EmergencyKind; language: AssistantLanguage; emergencyPhone: string | null }): Promise<void> {
  await queueAssistantSmsInTransaction(tx, { businessId: input.businessId, conversationId: input.conversationId, ...(input.sessionId ? { sessionId: input.sessionId } : {}), body: EMERGENCY_REPLY[input.language], aiGenerated: false, kind: "emergency_safety" });
  const summary = `Possible ${input.kind.replace("_", " ")} emergency from ${input.callerPhone}: "${input.text.slice(0, 200)}"`;
  await queueOperatorAlertInTransaction(tx, { businessId: input.businessId, eventKind: "emergency", eventKey: `emergency:${input.conversationId}:${input.kind}`, subject: "Emergency reported by a customer", body: summary });
  if (input.emergencyPhone) {
    await enqueueOutbox(tx, { topic: "assistant.emergencyPage", businessId: input.businessId, aggregateType: "conversation", aggregateId: input.conversationId, dedupeKey: `emergency-page:${input.conversationId}:${input.kind}`, payload: { to: input.emergencyPhone, body: `EMERGENCY: ${summary} Call them back now.`.slice(0, 480) } });
  }
}

/** Job step 2: the AI's reply is queued like any other text, so the send path re-checks consent. */
export async function queueAssistantSmsReply(context: DomainContext, input: { businessId: string; conversationId: string; sessionId: string | null; body: string }): Promise<string | null> {
  const body = input.body.trim().slice(0, 1200);
  if (!body) return null;
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const conversation = (await tx.select({ automationState: conversations.automationState }).from(conversations).where(and(eq(conversations.id, input.conversationId), eq(conversations.businessId, input.businessId))).limit(1))[0];
    // A person took over while the model was thinking.
    if (conversation?.automationState !== "ai_active") return null;
    return await queueAssistantSmsInTransaction(tx, { businessId: input.businessId, conversationId: input.conversationId, ...(input.sessionId ? { sessionId: input.sessionId } : {}), body, aiGenerated: true, kind: "assistant_reply" });
  });
}

export async function loadConversationTranscript(context: DomainContext, input: { businessId: string; conversationId: string }): Promise<Array<{ direction: string; body: string; createdAt: Date }>> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) =>
    await tx.select({ direction: messages.direction, body: messages.body, createdAt: messages.createdAt }).from(messages).where(and(eq(messages.businessId, input.businessId), eq(messages.conversationId, input.conversationId))).orderBy(asc(messages.createdAt)));
}
