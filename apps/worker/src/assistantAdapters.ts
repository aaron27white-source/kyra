import { createAgentModel, createReceptionistAgent } from "@lobbystack/agent-core";
import { getCachedBusinessSnapshot, isTwilioMediaUrl, type DomainContext } from "@lobbystack/domain";

import type { AssistantSmsResponder, CallbackDialer, TwilioMediaClient } from "./assistantJobs";

const SMS_FALLBACK: Record<"en" | "es", string> = {
  en: "Thanks! A team member will text you back shortly.",
  es: "¡Gracias! Alguien del equipo le responderá pronto.",
};

/** Kyra over SMS: the same receptionist agent as calls and web chat, on the sms channel. */
export function createAssistantResponder(domain: DomainContext, environment: NodeJS.ProcessEnv = process.env): AssistantSmsResponder | undefined {
  const model = createAgentModel(environment);
  if (!model) return undefined;
  return {
    async reply({ businessId, plan }) {
      const snapshot = await getCachedBusinessSnapshot(domain, { businessId });
      if (!snapshot) return SMS_FALLBACK[plan.language];
      const extra = [
        plan.language === "es" ? "The customer is writing in Spanish. Reply in Spanish unless they switch." : "Reply in English unless the customer writes in Spanish, then switch.",
        plan.photoRequestsEnabled ? "If photos would help (leaks, damage, equipment labels), ask them to text photos to this number." : "",
        plan.emergency ? "A fixed safety message was already sent to this customer. Don't repeat it. Quickly confirm their name, address and a callback number so the on-call technician can reach them." : "",
      ].filter(Boolean).join(" ");
      const agent = createReceptionistAgent({ model, context: { domain, snapshot, channel: "sms", callerPhone: plan.callerPhone, conversationId: plan.conversationId }, extraInstructions: extra });
      const result = await agent.generate({ messages: plan.history });
      return result.text.trim() || SMS_FALLBACK[plan.language];
    },
  };
}

function basicAuth(accountSid: string, authToken: string): string {
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[char]!));
}

/**
 * AI callbacks through OpenAI SIP: Twilio calls the customer and bridges the
 * answered call to our OpenAI project. The opaque token rides along as a SIP
 * X-header, so the GPT-Live webhook knows it's a callback and for which call.
 * Enabled with CALLBACK_VOICE_PROVIDER=openai_sip.
 */
export function createOpenAiSipCallbackDialer(environment: NodeJS.ProcessEnv = process.env): CallbackDialer | undefined {
  const accountSid = environment.TWILIO_ACCOUNT_SID?.trim();
  const authToken = environment.TWILIO_AUTH_TOKEN?.trim();
  const projectId = environment.OPENAI_SIP_PROJECT_ID?.trim();
  const publicUrl = environment.PUBLIC_APP_URL?.trim().replace(/\/$/, "");
  if (environment.CALLBACK_VOICE_PROVIDER !== "openai_sip" || !accountSid || !authToken || !projectId || !publicUrl?.startsWith("https://")) return undefined;
  if (!/^proj_[A-Za-z0-9]+$/.test(projectId)) throw new Error("OPENAI_SIP_PROJECT_ID must look like proj_...");
  return {
    async dial({ target }) {
      const sipUri = `sip:${projectId}@sip.api.openai.com;transport=tls?X-Key20-Callback=${target.token}`;
      const twiml = `<Response><Dial answerOnBridge="true" timeout="25"><Sip>${escapeXml(sipUri)}</Sip></Dial></Response>`;
      const form = new URLSearchParams({
        To: target.to,
        From: target.from,
        Twiml: twiml,
        Timeout: "25",
        StatusCallback: `${publicUrl}/api/webhooks/twilio/callback-status?token=${target.token}`,
        StatusCallbackEvent: "completed",
      });
      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`, {
        method: "POST",
        headers: { authorization: basicAuth(accountSid, authToken), "content-type": "application/x-www-form-urlencoded" },
        body: form,
      });
      if (!response.ok) throw new Error(`Twilio call create failed with ${response.status}.`);
      const body = await response.json() as { sid?: string };
      if (!body.sid) throw new Error("Twilio returned no call sid.");
      return { providerCallId: body.sid };
    },
  };
}

/** Reads MMS media with Twilio credentials, capped in size, only from Twilio's own host. */
export function createTwilioMediaClient(environment: NodeJS.ProcessEnv = process.env): TwilioMediaClient | undefined {
  const accountSid = environment.TWILIO_ACCOUNT_SID?.trim();
  const authToken = environment.TWILIO_AUTH_TOKEN?.trim();
  if (!accountSid || !authToken) return undefined;
  const ownedBy = (url: string) => isTwilioMediaUrl(url) && new URL(url).pathname.startsWith(`/2010-04-01/Accounts/${accountSid}/`);
  return {
    async download(url, maxBytes) {
      if (!ownedBy(url)) throw new Error("media_host_rejected");
      // Twilio redirects to a short-lived storage URL; fetch drops the auth header on that cross-origin hop.
      const response = await fetch(url, { headers: { authorization: basicAuth(accountSid, authToken) }, redirect: "follow" });
      if (!response.ok || !response.body) throw new Error(`media_http_${response.status}`);
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > maxBytes) throw new Error("media_too_large");
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > maxBytes) throw new Error("media_too_large");
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    },
    async remove(url) {
      if (!ownedBy(url)) return;
      await fetch(url, { method: "DELETE", headers: { authorization: basicAuth(accountSid, authToken) } });
    },
  };
}
