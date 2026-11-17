import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { lmcBusinessSettingsSchema, lmcCaptureSchema } from "@lobbystack/contracts";
import { contacts, lmcEvents, lmcLeads, lmcMessages, lmcRateWindows, lmcSettings, lmcSuppressions, withBusinessTransaction, type Database, type DatabaseTransaction } from "@lobbystack/db";
import { createReplyToken, routeReplyToken, verifyReplyToken } from "./capabilities";
import { enqueueLmcJob } from "./queue";
import { emailIdentityKeys, loadEmailIdentity, storeEmailIdentities, LmcEmailIdentityConflict } from "./intakeIdentity";

export type LmcEmailCaptureSource = {
  kind:"direct"|"forward";from:string;recipient:string;messageId:string|null;providerId:string;
  injectionDetected:boolean;attachmentsIgnored:number;
};

export const MAX_LMC_CAPTURE_BYTES = 32_768;
export class LmcCaptureError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const clean = (value: string) => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "").trim();

async function rate(tx: DatabaseTransaction, tenantId: string, scopeKey: string, now: Date, cap: number) {
  const windowStart = new Date(Math.floor(now.getTime()/3_600_000)*3_600_000);
  const [row] = await tx.insert(lmcRateWindows).values({ tenantId,scopeKey,windowStart,count:1 })
    .onConflictDoUpdate({ target:[lmcRateWindows.tenantId,lmcRateWindows.scopeKey,lmcRateWindows.windowStart], set:{ count:sql`${lmcRateWindows.count}+1` } }).returning({ count:lmcRateWindows.count });
  if (!row || row.count > cap) throw new LmcCaptureError(429,"CAPTURE_RATE_LIMITED");
}

/** Public token authorizes capture only. It can never authorize a conversation or booking. */
export class LmcLeadCapture {
  constructor(private readonly input: { database: Database; now: () => Date }) {}

  async capture(token: string, body: unknown): Promise<{ id: string }> {
    return this.captureLead(token,body);
  }

  /** Server-only provenance; the public form schema never accepts these fields. */
  async captureEmail(token:string,body:unknown,source:LmcEmailCaptureSource):Promise<{id:string}> {
    return this.captureLead(token,body,source);
  }

  private async captureLead(token:string,body:unknown,source?:LmcEmailCaptureSource):Promise<{id:string}> {
    let serialized: string;
    try { serialized = JSON.stringify(body); } catch { throw new LmcCaptureError(400,"INVALID_CAPTURE"); }
    if (typeof serialized !== "string") throw new LmcCaptureError(400,"INVALID_CAPTURE");
    if (Buffer.byteLength(serialized,"utf8") > MAX_LMC_CAPTURE_BYTES) throw new LmcCaptureError(413,"CAPTURE_TOO_LARGE");
    const parsed = lmcCaptureSchema.safeParse(body);
    if (!parsed.success) throw new LmcCaptureError(400,"INVALID_CAPTURE");
    const value = parsed.data;
    const message = clean(value.message), subject = clean(value.subject), name = clean(value.name);
    if (!message) throw new LmcCaptureError(400,"INVALID_CAPTURE");
    const email = value.email.toLowerCase();
    const tenantId = routeReplyToken(token);
    if (!tenantId) throw new LmcCaptureError(404,"CAPTURE_NOT_FOUND");
    const now = this.input.now();
    const fingerprint = hash(JSON.stringify({ email,message,subject,name,consentToFollowUp:value.consentToFollowUp, ...(source?{source:{kind:source.kind,from:source.from,recipient:source.recipient,messageId:source.messageId,injectionDetected:source.injectionDetected,attachmentsIgnored:source.attachmentsIgnored}}:{}) }));
    return withBusinessTransaction(this.input.database, { businessId:tenantId, actorType:"worker" }, async tx => {
      const [settings] = await tx.select().from(lmcSettings).where(eq(lmcSettings.tenantId,tenantId)).limit(1);
      if (!settings?.enabled || !verifyReplyToken(token,tenantId,settings.captureTokenHash)) throw new LmcCaptureError(404,"CAPTURE_NOT_FOUND");
      lmcBusinessSettingsSchema.parse(settings.config);
      if(source?.kind==="forward"&&source.from!==settings.config.ownerEmail.toLowerCase())throw new LmcCaptureError(403,"FORWARDER_NOT_AUTHORIZED");
      if(source?.kind==="direct"&&source.from!==email)throw new LmcCaptureError(403,"SENDER_NOT_AUTHORIZED");
      const identityKeys=source?emailIdentityKeys(source):[];
      if(source){
        const prior=await loadEmailIdentity(tx,tenantId,identityKeys,fingerprint);
        if(prior){
          if(!prior.leadId)throw new LmcEmailIdentityConflict("EMAIL_IDEMPOTENCY_CONFLICT");
          await storeEmailIdentities(tx,{tenantId,leadId:prior.leadId,keys:identityKeys,fingerprint,now});
          return {id:prior.leadId};
        }
      }
      const externalId = source ? `email:event:${hash(source.providerId)}` : `capture:${value.requestId}`;
      const [event] = await tx.insert(lmcEvents).values({ tenantId,type:"lead_captured",externalId,metadata:{fingerprint,...(source?{source:source.kind,attachmentsIgnored:source.attachmentsIgnored}:{})},createdAt:now })
        .onConflictDoNothing({ target:[lmcEvents.tenantId,lmcEvents.externalId] }).returning({ id:lmcEvents.id });
      if (!event) {
        const [existing] = await tx.select().from(lmcEvents).where(and(eq(lmcEvents.tenantId,tenantId),eq(lmcEvents.externalId,externalId))).limit(1);
        if (!existing?.leadId || existing.metadata.fingerprint !== fingerprint) throw new LmcCaptureError(409,"CAPTURE_IDEMPOTENCY_CONFLICT");
        return { id:existing.leadId };
      }
      await rate(tx,tenantId,"capture:tenant",now,100);
      await rate(tx,tenantId,`capture:sender:${hash(email)}`,now,5);
      const [suppression] = await tx.select({ reason:lmcSuppressions.reason }).from(lmcSuppressions).where(and(eq(lmcSuppressions.tenantId,tenantId),eq(lmcSuppressions.email,email))).limit(1);
      // Serialize contact creation across separate form request IDs for the same sender.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:lmc-contact:${email}`},0))`);
      let [contact] = await tx.select({ id:contacts.id }).from(contacts).where(and(eq(contacts.businessId,tenantId),eq(contacts.email,email))).limit(1);
      if (!contact) [contact] = await tx.insert(contacts).values({ businessId:tenantId,email,name:name || null,createdAt:now,updatedAt:now }).returning({id:contacts.id});
      if (!contact) throw new Error("LMC_CONTACT_CREATE_FAILED");
      const replyToken = createReplyToken(tenantId);
      const id = randomUUID(), messageId = randomUUID();
      await tx.insert(lmcLeads).values({ id,tenantId,contactId:contact.id,email,name:name || null,subject,replyTokenHash:replyToken.hash,
        status:suppression ? "suppressed" : "new",reason:suppression?.reason ?? null,consentFollowups:value.consentToFollowUp,lastInboundAt:now,createdAt:now,updatedAt:now });
      const [storedMessage]=await tx.insert(lmcMessages).values({ id:messageId,tenantId,leadId:id,direction:"lead",kind:"inbound",messageId:source?.messageId??`<form-${messageId}@lmc.invalid>`,toEmail:source?.recipient??settings.config.fromEmail,
        ...(source?{providerId:source.providerId,headers:{"X-LMC-Ingestion-Source":source.kind,...(source.injectionDetected?{"X-LMC-Injection-Detected":"true"}:{})}}:{}),
        subject,body:message,status:"received",createdAt:now }).onConflictDoNothing().returning({id:lmcMessages.id});
      if(!storedMessage)throw new LmcCaptureError(409,"CAPTURE_IDEMPOTENCY_CONFLICT");
      await tx.update(lmcEvents).set({leadId:id}).where(and(eq(lmcEvents.tenantId,tenantId),eq(lmcEvents.id,event.id)));
      if(source)await storeEmailIdentities(tx,{tenantId,leadId:id,keys:identityKeys,fingerprint,now});
      if (!suppression) await enqueueLmcJob(tx,{tenantId,leadId:id,kind:"process",dedupeKey:`process:${messageId}`,payload:{messageId,replyToken:replyToken.value},availableAt:now});
      // The raw reply token stays inside the tenant's private job payload.
      return { id };
    });
  }
}

function response(status: number, body: Record<string,unknown>, headers: Record<string,string> = {}) {
  return Response.json(body,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff",...headers}});
}

/** Framework-independent production handler; reads a bounded stream before JSON parsing. */
export async function handleLmcCapture(request: Request, token: string, capture: LmcLeadCapture): Promise<Response> {
  if (request.method !== "POST") return response(405,{error:"METHOD_NOT_ALLOWED"},{Allow:"POST"});
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") ?? "")) return response(415,{error:"JSON_REQUIRED"});
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length)>MAX_LMC_CAPTURE_BYTES)) return response(413,{error:"CAPTURE_TOO_LARGE"});
  const reader = request.body?.getReader();
  if (!reader) return response(400,{error:"INVALID_CAPTURE"});
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size>MAX_LMC_CAPTURE_BYTES) { await reader.cancel(); return response(413,{error:"CAPTURE_TOO_LARGE"}); }
      chunks.push(part.value);
    }
    let body: unknown;
    try { body=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks))); }
    catch { return response(400,{error:"INVALID_CAPTURE"}); }
    return response(202,await capture.capture(token,body));
  } catch (error) {
    if (error instanceof LmcCaptureError) return response(error.status,{error:error.code},error.status===429 ? {"Retry-After":"3600"} : {});
    // Neither SQL errors nor submitted PII are exposed to a public client.
    return response(503,{error:"CAPTURE_UNAVAILABLE"});
  } finally { reader.releaseLock(); }
}
