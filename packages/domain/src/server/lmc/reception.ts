import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { lmcProviderEventSchema, type LmcProviderEvent, type LmcInboundProvider } from "@lobbystack/contracts";
import { lmcEvents, lmcJobs, lmcLeads, lmcMessages, lmcRateWindows, lmcSettings, lmcSuppressions, withBusinessTransaction, type Database, type DatabaseTransaction } from "@lobbystack/db";
import { routeReplyToken, verifyActionToken, verifyReplyToken } from "./capabilities";
import { normalizeInboundEmail, normalizeInboundRecipient } from "./inbound";
import { LmcInitialEmailIntake } from "./initialEmail";
import { enqueueLmcJob } from "./queue";
import { suppressLmcEmail } from "./suppression";

const digest=(value:string)=>createHash("sha256").update(value).digest("hex");
type ReceptionResult={accepted:boolean;reason?:string};
type Input={database:Database;now:()=>Date;receivingDomain:string;signingSecret:string};

/** Called only with server-verified provider events. Public HTTP always passes through the adapter below. */
export class LmcEmailReception {
  constructor(private readonly input:Input) {}
  private scoped<T>(tenantId:string,fn:(tx:DatabaseTransaction)=>Promise<T>){return withBusinessTransaction(this.input.database,{businessId:tenantId,actorType:"worker"},fn);}

  async receive(raw:LmcProviderEvent):Promise<ReceptionResult>{
    const parsed=lmcProviderEventSchema.safeParse(raw);
    if(!parsed.success)return{accepted:false,reason:"invalid_provider_event"};
    const event=parsed.data;
    if(event.kind==="suppression")return this.providerSuppression(event);
    const recipient=normalizeInboundRecipient(event.email.to);
    if(recipient?.startsWith("lead+")||recipient?.startsWith("forward+"))return new LmcInitialEmailIntake(this.input).receive(event);
    const suffix=`@${this.input.receivingDomain}`;
    if(!recipient?.startsWith("reply+")||!recipient.endsWith(suffix))return{accepted:false,reason:"invalid_recipient"};
    const token=recipient.slice(6,-suffix.length),tenantId=routeReplyToken(token);
    if(!tenantId)return{accepted:false,reason:"invalid_recipient"};
    const email=normalizeInboundEmail(event.email);
    if(email.kind!=="message")return this.scoped(tenantId,async tx=>{
      const [settings]=await tx.select({enabled:lmcSettings.enabled}).from(lmcSettings).where(eq(lmcSettings.tenantId,tenantId)).limit(1);
      if(settings)await this.recordRejection(tx,tenantId,event.id,email.reason);
      return{accepted:false,reason:email.reason};
    });
    const tokenHash=digest(token),now=this.input.now();
    return this.scoped(tenantId,async tx=>{
      let [lead]=await tx.select().from(lmcLeads).where(and(eq(lmcLeads.tenantId,tenantId),eq(lmcLeads.replyTokenHash,tokenHash))).limit(1);
      const [settings]=await tx.select({enabled:lmcSettings.enabled}).from(lmcSettings).where(eq(lmcSettings.tenantId,tenantId)).limit(1);
      if(!lead||!settings?.enabled||!verifyReplyToken(token,tenantId,lead.replyTokenHash)||email.from!==lead.email){
        if(lead||settings)await this.recordRejection(tx,tenantId,event.id,"conversation_not_verified",lead?.id);
        return{accepted:false,reason:"conversation_not_verified"};
      }
      if(!email.optOut){
        [lead]=await tx.select().from(lmcLeads).where(and(eq(lmcLeads.tenantId,tenantId),eq(lmcLeads.replyTokenHash,tokenHash))).for("update");
        if(!lead){
          await this.recordRejection(tx,tenantId,event.id,"conversation_not_verified");
          return{accepted:false,reason:"conversation_not_verified"};
        }
      }
      // The reply address carries the tenant and lead capability. RFC identifiers are
      // retained below for mail-client threading but never authorize or reject a reply.
      const references=[...new Set([...email.references,...(email.inReplyTo?[email.inReplyTo]:[])])];
      const fingerprint=digest(JSON.stringify(email));
      const externalId=`inbound:${event.id}`;
      const [created]=await tx.insert(lmcEvents).values({tenantId,leadId:lead.id,type:"email_received",externalId,metadata:{fingerprint,attachmentsIgnored:email.attachmentsIgnored},createdAt:now})
        .onConflictDoNothing({target:[lmcEvents.tenantId,lmcEvents.externalId]}).returning({id:lmcEvents.id});
      if(!created){
        const [prior]=await tx.select().from(lmcEvents).where(and(eq(lmcEvents.tenantId,tenantId),eq(lmcEvents.externalId,externalId))).limit(1);
        return prior?.leadId===lead.id&&prior.metadata.fingerprint===fingerprint ? {accepted:true} : {accepted:false,reason:"event_conflict"};
      }
      const messageId=randomUUID();
      const [message]=await tx.insert(lmcMessages).values({id:messageId,tenantId,leadId:lead.id,direction:"lead",kind:"inbound",messageId:email.messageId??`<inbound-${digest(event.id)}@${this.input.receivingDomain}>`,providerId:event.id,toEmail:email.to,subject:email.subject,body:email.text,status:"received",createdAt:now,
        headers:{...(email.injectionDetected?{"X-LMC-Injection-Detected":"true"}:{}),...(email.inReplyTo?{"In-Reply-To":email.inReplyTo}:{}),...(email.references.length?{References:email.references.join(" ")}:{})}})
        .onConflictDoNothing({target:[lmcMessages.tenantId,lmcMessages.messageId]}).returning({id:lmcMessages.id});
      if(!message)return{accepted:true};
      if(email.optOut){await this.suppress(tx,tenantId,lead.email,"opt_out");return{accepted:true};}
      // Limits live in the same transaction as inbound persistence and queued work.
      const windowStart=new Date(Math.floor(now.getTime()/3_600_000)*3_600_000);
      for(const [scopeKey,cap] of [["inbound:tenant",1_000],[`inbound:sender:${digest(email.from)}`,20]] as const){
        const [rate]=await tx.insert(lmcRateWindows).values({tenantId,scopeKey,windowStart,count:1}).onConflictDoUpdate({target:[lmcRateWindows.tenantId,lmcRateWindows.scopeKey,lmcRateWindows.windowStart],set:{count:sql`${lmcRateWindows.count}+1`}}).returning({count:lmcRateWindows.count});
        if(!rate||rate.count>cap){
          await tx.insert(lmcEvents).values({tenantId,leadId:lead.id,type:"inbound_rate_limited",metadata:{messageId},createdAt:now});
          return{accepted:true};
        }
      }
      const generation=lead.followupGeneration+1;
      await tx.update(lmcLeads).set({verifiedAt:now,lastInboundAt:now,followupGeneration:generation,updatedAt:now}).where(and(eq(lmcLeads.tenantId,tenantId),eq(lmcLeads.id,lead.id)));
      await tx.update(lmcJobs).set({status:"cancelled",updatedAt:now}).where(and(eq(lmcJobs.tenantId,tenantId),eq(lmcJobs.leadId,lead.id),eq(lmcJobs.kind,"followup"),eq(lmcJobs.status,"pending")));
      if(email.injectionDetected)await tx.insert(lmcEvents).values({tenantId,leadId:lead.id,type:"prompt_injection_detected",metadata:{messageId},createdAt:now});
      const [suppressed]=await tx.select({email:lmcSuppressions.email}).from(lmcSuppressions).where(and(eq(lmcSuppressions.tenantId,tenantId),eq(lmcSuppressions.email,lead.email))).limit(1);
      if(!lead.aiPaused&&!suppressed&&!["opted_out","suppressed","declined"].includes(lead.status))await enqueueLmcJob(tx,{tenantId,leadId:lead.id,kind:"process",dedupeKey:`process:${messageId}`,payload:{messageId,replyToken:token,generation},availableAt:now});
      else await tx.insert(lmcEvents).values({tenantId,leadId:lead.id,type:"email_processing_skipped",externalId:`skipped:${messageId}`,metadata:{messageId,reason:lead.aiPaused?"automation_paused":suppressed?"address_suppressed":lead.status},createdAt:now}).onConflictDoNothing({target:[lmcEvents.tenantId,lmcEvents.externalId]});
      return{accepted:true};
    });
  }

  async unsubscribe(token:string):Promise<boolean>{
    const claims=verifyActionToken(token,"unsubscribe",this.input.signingSecret,this.input.now().getTime());
    if(!claims)return false;
    return this.scoped(claims.tenantId,async tx=>{
      const [lead]=await tx.select().from(lmcLeads).where(and(eq(lmcLeads.tenantId,claims.tenantId),eq(lmcLeads.id,claims.leadId))).limit(1);
      if(!lead)return false;
      await this.suppress(tx,claims.tenantId,lead.email,"opt_out");return true;
    });
  }

  private async suppress(tx:DatabaseTransaction,tenantId:string,email:string,reason:"opt_out"|"bounce"|"complaint"){
    const now=this.input.now();
    await suppressLmcEmail(tx,tenantId,email,reason,now);
  }

  private async recordRejection(tx:DatabaseTransaction,tenantId:string,eventId:string,reason:string,leadId?:string,referenceCount=0){
    await tx.insert(lmcEvents).values({tenantId,...(leadId?{leadId}:{}),type:"email_rejected",externalId:`rejected:${digest(eventId)}`,metadata:{reason,referenceCount},createdAt:this.input.now()}).onConflictDoNothing({target:[lmcEvents.tenantId,lmcEvents.externalId]});
  }

  private async providerSuppression(event:Extract<LmcProviderEvent,{kind:"suppression"}>):Promise<ReceptionResult>{
    return this.scoped(event.tenantId,async tx=>{
      // Signed provider metadata routes the tenant; the stored delivery proves the actual recipient.
      const [message]=await tx.select().from(lmcMessages).where(and(eq(lmcMessages.tenantId,event.tenantId),eq(lmcMessages.providerId,event.providerMessageId),eq(lmcMessages.toEmail,event.email))).limit(1);
      if(!message||message.kind==="owner_alert")return{accepted:false,reason:"delivery_not_found"};
      const [created]=await tx.insert(lmcEvents).values({tenantId:event.tenantId,leadId:message.leadId,type:"provider_suppression",externalId:`suppression:${event.id}`,metadata:{reason:event.reason},createdAt:this.input.now()}).onConflictDoNothing({target:[lmcEvents.tenantId,lmcEvents.externalId]}).returning({id:lmcEvents.id});
      if(created)await this.suppress(tx,event.tenantId,event.email,event.reason);
      return{accepted:true};
    });
  }
}

export async function handleLmcEmailWebhook(request:Request,provider:LmcInboundProvider,reception:LmcEmailReception):Promise<Response>{
  const reply=(status:number,error?:string)=>Response.json(error?{error}:{received:true},{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
  if(request.method!=="POST")return reply(405,"METHOD_NOT_ALLOWED");
  const reader=request.body?.getReader();
  if(!reader)return reply(400,"INVALID_WEBHOOK");
  let rawBody:string;
  try{
    const chunks:Uint8Array[]=[];let size=0;
    while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>65_536){await reader.cancel();return reply(413,"WEBHOOK_TOO_LARGE");}chunks.push(part.value);}
    rawBody=new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks));
  }catch{return reply(400,"INVALID_WEBHOOK");}finally{reader.releaseLock();}
  let event:LmcProviderEvent|null;
  try{event=await provider.verifyAndLoad({rawBody,headers:request.headers});}
  catch(error){return error instanceof Error&&error.message==="INVALID_WEBHOOK_SIGNATURE"?reply(401,"INVALID_WEBHOOK_SIGNATURE"):reply(503,"WEBHOOK_UNAVAILABLE");}
  if(!event)return reply(200);
  try{await reception.receive(event);return reply(200);}catch{return reply(503,"WEBHOOK_UNAVAILABLE");}
}

export async function handleLmcUnsubscribe(request:Request,token:string,reception:LmcEmailReception):Promise<Response>{
  const headers={"Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"};
  if(request.method!=="POST"&&request.method!=="GET")return new Response("Method not allowed",{status:405,headers:{...headers,Allow:"GET, POST"}});
  // GET renders a confirmation form; link scanners must not change consent.
  if(request.method==="GET")return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><title>Unsubscribe</title><form method="post"><button type="submit">Stop emails</button></form></html>',{status:200,headers:{...headers,"Content-Type":"text/html; charset=utf-8","Content-Security-Policy":"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}});
  try{return new Response(await reception.unsubscribe(token)?"You will receive no further automated lead emails.":"Invalid unsubscribe link.",{status:200,headers});}catch{return new Response("Please try again.",{status:503,headers});}
}
