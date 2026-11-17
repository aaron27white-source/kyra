import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { lmcBusinessSettingsSchema, lmcHumanReplySchema, lmcProcessJobSchema, type LmcOutboundEmail } from "@lobbystack/contracts";
import { lmcEvents, lmcJobs, lmcLeads, lmcMessages, lmcSettings, lmcSuppressions, withBusinessTransaction, type Database } from "@lobbystack/db";
import { requireBusinessMembership } from "../../authz";
import { signActionToken, verifyReplyToken } from "./capabilities";
import { enqueueLmcJob } from "./queue";

export class LmcHumanReplyError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

/** Call with the authenticated session user, never a user ID supplied in the HTTP body. */
export class LmcHumanReplies {
  constructor(private readonly input:{database:Database;now:()=>Date;baseUrl:string;receivingDomain:string;signingSecret:string}){}
  async reply(actor:{tenantId:string;userId:string;leadId:string},body:unknown):Promise<{id:string}>{
    const parsed=lmcHumanReplySchema.parse(body),now=this.input.now();
    const text=parsed.text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,"");
    const fingerprint=createHash("sha256").update(JSON.stringify({leadId:actor.leadId,text})).digest("hex");
    return withBusinessTransaction(this.input.database,{businessId:actor.tenantId,userId:actor.userId,actorType:"operator"},async tx=>{
      await requireBusinessMembership(tx,{businessId:actor.tenantId,userId:actor.userId,minimumRole:"scheduler"});
      const [lead]=await tx.select().from(lmcLeads).where(and(eq(lmcLeads.tenantId,actor.tenantId),eq(lmcLeads.id,actor.leadId))).for("update");
      const [settings]=await tx.select().from(lmcSettings).where(eq(lmcSettings.tenantId,actor.tenantId)).limit(1);
      if(!lead||!settings?.enabled)throw new LmcHumanReplyError(404,"LEAD_NOT_FOUND");
      const [suppressed]=await tx.select({email:lmcSuppressions.email}).from(lmcSuppressions).where(and(eq(lmcSuppressions.tenantId,actor.tenantId),eq(lmcSuppressions.email,lead.email))).limit(1);
      if(suppressed||["suppressed","opted_out"].includes(lead.status))throw new Error("EMAIL_SUPPRESSED");
      const config=lmcBusinessSettingsSchema.parse(settings.config);
      const externalId=`human:${parsed.requestId}`;
      const [prior]=await tx.select().from(lmcEvents).where(and(eq(lmcEvents.tenantId,actor.tenantId),eq(lmcEvents.externalId,externalId))).limit(1);
      if(prior){if(prior.leadId!==lead.id||prior.metadata.fingerprint!==fingerprint||typeof prior.metadata.messageId!=="string")throw new Error("HUMAN_REPLY_IDEMPOTENCY_CONFLICT");return{id:prior.metadata.messageId};}
      const jobs=await tx.select({payload:lmcJobs.payload}).from(lmcJobs).where(and(eq(lmcJobs.tenantId,actor.tenantId),eq(lmcJobs.leadId,lead.id),eq(lmcJobs.kind,"process"))).limit(1);
      const source=lmcProcessJobSchema.safeParse(jobs[0]?.payload);
      if(!source.success||!verifyReplyToken(source.data.replyToken,actor.tenantId,lead.replyTokenHash)||!lead.lastOutboundMessageId)throw new Error("CONVERSATION_NOT_READY");
      const generation=lead.followupGeneration+1,id=randomUUID(),messageId=`<${id}-human@${this.input.receivingDomain}>`;
      const token=signActionToken({tenantId:actor.tenantId,leadId:lead.id,purpose:"unsubscribe"},this.input.signingSecret);
      const unsubscribe=`${this.input.baseUrl.replace(/\/$/,"")}/api/lmc/unsubscribe/${token}`;
      const headers={"Message-ID":messageId,"In-Reply-To":lead.lastOutboundMessageId,References:lead.lastOutboundMessageId,"List-Unsubscribe":`<${unsubscribe}>`,"List-Unsubscribe-Post":"List-Unsubscribe=One-Click","Auto-Submitted":"no"};
      const outgoing:LmcOutboundEmail={tenantId:actor.tenantId,leadId:lead.id,idempotencyKey:`lmc:${id}`,kind:"reply",from:config.fromEmail,to:lead.email,replyTo:`reply+${source.data.replyToken}@${this.input.receivingDomain}`,subject:`Re: ${lead.subject||"Your request"}`,text:`${text}\n\n${config.physicalAddress}\nReply STOP or unsubscribe: ${unsubscribe}`,headers};
      await tx.update(lmcLeads).set({aiPaused:true,status:"human_handoff",reason:"human_reply",followupGeneration:generation,updatedAt:now}).where(and(eq(lmcLeads.tenantId,actor.tenantId),eq(lmcLeads.id,lead.id)));
      await tx.update(lmcJobs).set({status:"cancelled",updatedAt:now}).where(and(eq(lmcJobs.tenantId,actor.tenantId),eq(lmcJobs.leadId,lead.id),eq(lmcJobs.kind,"followup"),eq(lmcJobs.status,"pending")));
      await tx.insert(lmcMessages).values({id,tenantId:actor.tenantId,leadId:lead.id,direction:"human",kind:"reply",messageId,toEmail:lead.email,subject:outgoing.subject,body:outgoing.text,headers,status:"queued",createdAt:now});
      await enqueueLmcJob(tx,{tenantId:actor.tenantId,leadId:lead.id,kind:"send",dedupeKey:`send:${id}`,payload:{messageId:id,outbound:outgoing,generation,allowPaused:true},availableAt:now});
      await tx.insert(lmcEvents).values({tenantId:actor.tenantId,leadId:lead.id,type:"human_reply_queued",externalId,metadata:{messageId:id,fingerprint,userId:actor.userId},createdAt:now});
      return{id};
    });
  }
}
