import type { JobEnvelope } from "@lobbystack/contracts";
import {
  claimCallbackAttempt,
  loadCallRouting,
  recordCallRouting,
  loadPendingSmsMedia,
  markSmsMediaFailed,
  persistSmsMedia,
  planAssistantSmsReply,
  processMissedCall,
  queueAssistantSmsReply,
  recordCallbackDialed,
  runAutomationSweep,
  sendFallbackTextBack,
  type CallbackTarget,
  type DomainContext,
  type SmsReplyPlan,
} from "@lobbystack/domain";
import type { RuntimeStorageProvider } from "@lobbystack/providers/storage/provider";
import type { TwilioProvider } from "@lobbystack/providers/twilio/twilioProvider";

/** Writes Kyra's next SMS. Built from agent-core in index.ts so this file stays testable. */
export type AssistantSmsResponder = {
  reply(input: { businessId: string; plan: Extract<SmsReplyPlan, { kind: "ai" }> }): Promise<string>;
};

/** Places the AI callback. The first adapter bridges Twilio to OpenAI SIP. */
export type CallbackDialer = {
  dial(input: { businessId: string; target: CallbackTarget }): Promise<{ providerCallId: string }>;
};

/** Downloads (and then deletes) customer MMS media from Twilio with Twilio credentials. */
export type TwilioMediaClient = {
  download(url: string, maxBytes: number): Promise<Uint8Array>;
  remove(url: string): Promise<void>;
};

export type AssistantDependencies = {
  domain: DomainContext;
  storage?: RuntimeStorageProvider;
  twilio?: Pick<TwilioProvider, "sendSms"> & Partial<Pick<TwilioProvider, "addNumberToSipTrunk" | "removeNumberFromSipTrunk" | "configureIncomingPhoneNumber">>;
  twilioAlertsFrom?: string;
  assistantResponder?: AssistantSmsResponder;
  callbackDialer?: CallbackDialer;
  twilioMedia?: TwilioMediaClient;
};

type Result = { status: "completed" | "skipped"; entityId?: string };

const ASSISTANT_JOB_TYPES = new Set(["missedCall.process", "missedCall.callback", "sms.assistantReply", "sms.ingestMedia", "assistant.emergencyPage", "assistant.sweep", "phoneNumber.applyRouting"]);

export function isAssistantJob(type: string): boolean {
  return ASSISTANT_JOB_TYPES.has(type);
}

function businessIdOf(job: JobEnvelope): string {
  if (!job.businessId) throw new Error(`Job ${job.type} requires a business context.`);
  return job.businessId;
}

export async function handleAssistantJob(job: JobEnvelope, dependencies: AssistantDependencies): Promise<Result> {
  const businessId = businessIdOf(job);
  switch (job.type) {
    case "missedCall.process": {
      const missedCallId = String(job.payload.missedCallId ?? "");
      if (job.payload.fallback === true) {
        const sent = await sendFallbackTextBack(dependencies.domain, { businessId, missedCallId });
        return { status: sent ? "completed" : "skipped", entityId: missedCallId };
      }
      const outcome = await processMissedCall(dependencies.domain, { businessId, missedCallId });
      return { status: outcome === "skipped" ? "skipped" : "completed", entityId: `${missedCallId}:${outcome}` };
    }
    case "missedCall.callback": {
      const missedCallId = String(job.payload.missedCallId ?? "");
      if (!dependencies.callbackDialer) {
        // No voice stack configured: the customer still gets the texts.
        await sendFallbackTextBack(dependencies.domain, { businessId, missedCallId });
        return { status: "skipped", entityId: missedCallId };
      }
      const claim = await claimCallbackAttempt(dependencies.domain, { businessId, missedCallId });
      if ("skipped" in claim) return { status: "skipped", entityId: `${missedCallId}:${claim.skipped}` };
      try {
        const { providerCallId } = await dependencies.callbackDialer.dial({ businessId, target: claim.target });
        await recordCallbackDialed(dependencies.domain, { businessId, missedCallId, providerCallId });
        return { status: "completed", entityId: missedCallId };
      } catch (error) {
        // The single attempt is spent. Don't retry the call; fall back to texting.
        await sendFallbackTextBack(dependencies.domain, { businessId, missedCallId });
        console.error("[assistant] callback dial failed", { businessId, missedCallId, error: error instanceof Error ? error.name : typeof error });
        return { status: "completed", entityId: `${missedCallId}:dial_failed` };
      }
    }
    case "sms.assistantReply": {
      const messageId = String(job.payload.messageId ?? "");
      const plan = await planAssistantSmsReply(dependencies.domain, { businessId, messageId });
      if (plan.kind !== "ai") return { status: "skipped", entityId: `${messageId}:${plan.reason}` };
      if (!dependencies.assistantResponder) return { status: "skipped", entityId: `${messageId}:no_model` };
      const body = await dependencies.assistantResponder.reply({ businessId, plan });
      const queued = await queueAssistantSmsReply(dependencies.domain, { businessId, conversationId: plan.conversationId, sessionId: plan.sessionId, body });
      return { status: queued ? "completed" : "skipped", entityId: messageId };
    }
    case "sms.ingestMedia": {
      const messageId = String(job.payload.messageId ?? "");
      if (!dependencies.twilioMedia || !dependencies.storage || !("putObject" in dependencies.storage)) return { status: "skipped", entityId: messageId };
      const storage = dependencies.storage as RuntimeStorageProvider & { putObject(input: { key: string; body: Uint8Array; contentType: string }): Promise<void> };
      const pending = await loadPendingSmsMedia(dependencies.domain, { businessId, messageId });
      for (const item of pending) {
        try {
          const body = await dependencies.twilioMedia.download(item.providerUrl, 10 * 1024 * 1024);
          const stored = await persistSmsMedia(dependencies.domain, { businessId, messageId, index: item.index, body }, storage);
          // Our copy is the only one we keep; Twilio's is deleted either way.
          await dependencies.twilioMedia.remove(item.providerUrl).catch(() => undefined);
          void stored;
        } catch (error) {
          await markSmsMediaFailed(dependencies.domain, { businessId, messageId, index: item.index, reason: error instanceof Error ? error.message : "download_failed" });
        }
      }
      return { status: pending.length ? "completed" : "skipped", entityId: messageId };
    }
    case "assistant.emergencyPage": {
      const to = String(job.payload.to ?? "");
      const body = String(job.payload.body ?? "");
      if (!dependencies.twilio || !dependencies.twilioAlertsFrom || !/^\+[1-9]\d{7,14}$/.test(to) || !body) return { status: "skipped" };
      await dependencies.twilio.sendSms({ to, from: dependencies.twilioAlertsFrom, body });
      return { status: "completed" };
    }
    case "assistant.sweep": {
      const tally = await runAutomationSweep(dependencies.domain, { businessId });
      const sent = Object.entries(tally).filter(([key]) => key.endsWith(":sent") || key === "owner_brief").reduce((sum, [, value]) => sum + value, 0);
      return { status: sent ? "completed" : "skipped", entityId: `${businessId}:${sent}` };
    }
    case "phoneNumber.applyRouting": {
      const twilio = dependencies.twilio;
      if (!twilio?.configureIncomingPhoneNumber || !twilio.addNumberToSipTrunk || !twilio.removeNumberFromSipTrunk) return { status: "skipped" };
      const trunkSid = process.env.TWILIO_SIP_TRUNK_SID?.trim();
      const voiceUrl = `${(process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "")}/api/webhooks/twilio/voice`;
      const { routing, numbers } = await loadCallRouting(dependencies.domain, { businessId });
      if (routing === "sip_trunk" && !trunkSid) throw new Error("TWILIO_SIP_TRUNK_SID is required to route a Tier 2 number to the live AI.");
      for (const number of numbers) {
        try {
          if (routing === "sip_trunk") {
            await twilio.addNumberToSipTrunk({ trunkSid: trunkSid!, providerPhoneId: number.providerPhoneId });
            await recordCallRouting(dependencies.domain, { businessId, phoneNumberId: number.id, target: `sip-trunk:${trunkSid}` });
          } else {
            // Set the webhook first, then leave the trunk, so there's never a moment with nothing answering.
            await twilio.configureIncomingPhoneNumber({ providerPhoneId: number.providerPhoneId, voiceUrl });
            if (trunkSid) await twilio.removeNumberFromSipTrunk({ trunkSid, providerPhoneId: number.providerPhoneId });
            await recordCallRouting(dependencies.domain, { businessId, phoneNumberId: number.id, target: voiceUrl });
          }
        } catch (error) {
          await recordCallRouting(dependencies.domain, { businessId, phoneNumberId: number.id, target: routing, error: error instanceof Error ? error.message.slice(0, 200) : "routing_failed" });
          throw error;
        }
      }
      return { status: numbers.length ? "completed" : "skipped", entityId: `${businessId}:${routing}` };
    }
    default:
      throw new Error(`Not an assistant job: ${job.type}`);
  }
}
