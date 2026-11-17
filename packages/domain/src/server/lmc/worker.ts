import { randomUUID } from "node:crypto";
import { and, asc, eq, or, sql } from "drizzle-orm";
import { lmcBusinessSettingsSchema, lmcFollowupJobSchema, lmcProcessJobSchema, lmcQualificationSchema, lmcSendJobSchema, type LmcBusinessSettings, type LmcChannel, type LmcEmailDecision, type LmcEmailTransport, type LmcOutboundEmail, type LmcStructuredAction } from "@lobbystack/contracts";
import { appointments, businesses, contacts, lmcEvents, lmcJobs, lmcLeads, lmcMessages, lmcRateWindows, lmcSettings, lmcSuppressions, withBusinessTransaction, type Database, type DatabaseTransaction } from "@lobbystack/db";
import { signActionToken, verifyReplyToken } from "./capabilities";
import { bookEmailAppointmentInTransaction, cancelAppointmentInTransaction, rescheduleEmailAppointmentInTransaction } from "../booking";
import { redactLmcCapabilities } from "./redaction";
import { formatEmailVisitDate, formatEmailVisitTime, listEmailVisitSlots } from "./scheduling";
import { isAlternativeAvailabilityRequest, requestedLocalDate } from "./availability-request";
import { classifyLmcJobFailure, enqueueLmcJob, LMC_JOB_LEASE_MS, LmcJobQueue, type LmcJob, type LmcJobFailureDiagnostic } from "./queue";
import { buildEmailQualificationPrompt } from "./conversation";
import { classifyLmcProcessingError } from "./failure";
import { summarizeLmcActions } from "./observability";

type Lead = typeof lmcLeads.$inferSelect;
type Message = typeof lmcMessages.$inferSelect;
type WorkerInput = { database: Database; dispatcher: Database; now: () => Date; channel: LmcChannel; mail: LmcEmailTransport; baseUrl: string; receivingDomain: string; signingSecret: string; allowLocalHttp?: boolean; onJobFailure?: (diagnostic: LmcJobFailureDiagnostic) => void };
class LmcJobLeaseError extends Error {}
const terminal = new Set(["opted_out","suppressed","declined","booked"]);
const processingTerminal = new Set(["opted_out","suppressed","declined"]);
const injection = (text: string) => /ignore\s+(?:all\s+)?(?:your|previous|system)\s+(?:rules|instructions)|\bsystem\s*:|\b(?:give|apply)\s+\d{1,3}\s*%\s*(?:off|discount)|another\s+tenant/i.test(text);

export class LmcEmailWorker {
  private readonly queue: LmcJobQueue;
  private readonly baseUrl: string;
  constructor(private readonly input: WorkerInput) {
    const url = new URL(input.baseUrl);
    const localHttp = input.allowLocalHttp === true && url.protocol === "http:" && ["localhost","127.0.0.1","[::1]"].includes(url.hostname);
    if ((url.protocol!=="https:" && !localHttp) || url.username || url.password || url.search || url.hash || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(input.receivingDomain) || input.channel.kind!=="email") throw new Error("INVALID_EMAIL_WORKER_CONFIG");
    this.baseUrl = input.baseUrl.replace(/\/$/,"");
    // Validate the mandatory signing secret before the first outbound transaction.
    signActionToken({tenantId:"00000000-0000-4000-8000-000000000000",leadId:"00000000-0000-4000-8000-000000000000",purpose:"unsubscribe"},input.signingSecret);
    this.queue = new LmcJobQueue({worker:input.database,dispatcher:input.dispatcher,now:input.now,...(input.onJobFailure ? {onFailure:input.onJobFailure} : {})});
  }

  /** Bounded work per invocation. The runtime can call this again while work remains. */
  async drain(maxRounds = 20, signal?: AbortSignal): Promise<{ completed: number; failed: number }> {
    if (!Number.isInteger(maxRounds) || maxRounds<1 || maxRounds>100) throw new Error("INVALID_QUEUE_LIMIT");
    const result = {completed:0,failed:0};
    for (let round=0;round<maxRounds && !signal?.aborted;round++) {
      let claimed=0;
      for (const tenant of await this.queue.dueTenants()) {
        if (signal?.aborted) break;
        for (const job of await this.queue.claim(tenant,1)) {
          claimed++;
          try {
            if (job.kind==="process") await this.process(job);
            else if (job.kind==="send") await this.send(job);
            else if (job.kind==="followup") await this.followup(job);
            else throw new Error("INVALID_JOB_PAYLOAD");
            if (await this.queue.complete(job)) result.completed++;
          } catch (error) {
            const code = classifyLmcJobFailure(error).code;
            await this.queue.fail(job,code);
            result.failed++;
          }
        }
      }
      if (!claimed) break;
    }
    return result;
  }

  private scoped<T>(tenantId: string, fn: (tx: DatabaseTransaction) => Promise<T>) {
    return withBusinessTransaction(this.input.database,{businessId:tenantId,actorType:"worker"},fn);
  }
  private async lease(tx: DatabaseTransaction, job: LmcJob) {
    const [current] = await tx.select().from(lmcJobs).where(and(eq(lmcJobs.tenantId,job.tenantId),eq(lmcJobs.id,job.id))).for("update");
    if (!current || current.status!=="running" || current.leaseToken!==job.leaseToken) throw new LmcJobLeaseError("LMC_JOB_LEASE_LOST");
    if (!current.leasedUntil || current.leasedUntil<=this.input.now()) throw new LmcJobLeaseError("LMC_JOB_LEASE_EXPIRED");
  }
  private leaseFailure(error: unknown) {
    return error instanceof LmcJobLeaseError;
  }
  private async withLeaseHeartbeat<T>(job: LmcJob, work: () => Promise<T>): Promise<T> {
    let heartbeatError: unknown;
    let pending = Promise.resolve();
    const renew = () => {
      pending = pending.then(async () => {
        if (!await this.queue.renew(job)) throw new Error("LMC_JOB_LEASE_LOST");
      }).catch(error => {
        heartbeatError ??= error;
      });
    };
    const heartbeat = setInterval(renew,LMC_JOB_LEASE_MS/3);
    heartbeat.unref();
    let value: T | undefined;
    let workError: unknown;
    try {
      value = await work();
    } catch (error) {
      workError = error;
    } finally {
      clearInterval(heartbeat);
    }
    await pending;
    if (!heartbeatError) {
      try {
        if (!await this.queue.renew(job)) heartbeatError = new Error("LMC_JOB_LEASE_LOST");
      } catch (error) {
        heartbeatError = error;
      }
    }
    if (heartbeatError) throw new LmcJobLeaseError("LMC_JOB_LEASE_LOST");
    if (workError) throw workError;
    return value as T;
  }
  private async suppressed(tx: DatabaseTransaction, lead: Lead) {
    return (await tx.select({email:lmcSuppressions.email}).from(lmcSuppressions).where(and(eq(lmcSuppressions.tenantId,lead.tenantId),eq(lmcSuppressions.email,lead.email))).limit(1)).length>0;
  }

  private async process(job: LmcJob) {
    const payload = lmcProcessJobSchema.parse(job.payload);
    const snapshot = await this.scoped(job.tenantId,async tx => {
      const [processed] = await tx.select({id:lmcEvents.id}).from(lmcEvents).where(and(eq(lmcEvents.tenantId,job.tenantId),eq(lmcEvents.externalId,`processed:${job.id}`))).limit(1);
      if (processed) return null;
      const [lead] = await tx.select().from(lmcLeads).where(and(eq(lmcLeads.tenantId,job.tenantId),eq(lmcLeads.id,job.leadId))).limit(1);
      const [settings] = await tx.select().from(lmcSettings).where(eq(lmcSettings.tenantId,job.tenantId)).limit(1);
      const [business] = await tx.select({timezone:businesses.timezone}).from(businesses).where(eq(businesses.id,job.tenantId)).limit(1);
      const [message] = await tx.select().from(lmcMessages).where(and(eq(lmcMessages.tenantId,job.tenantId),eq(lmcMessages.leadId,job.leadId),eq(lmcMessages.id,payload.messageId),eq(lmcMessages.direction,"lead"))).limit(1);
      if (!lead || !message || !settings?.enabled || !verifyReplyToken(payload.replyToken,job.tenantId,lead.replyTokenHash)) throw new Error("INVALID_JOB_PAYLOAD");
      if (lead.aiPaused || processingTerminal.has(lead.status) || lead.followupGeneration!==payload.generation || await this.suppressed(tx,lead)) return null;
      const history = await tx.select().from(lmcMessages).where(and(eq(lmcMessages.tenantId,job.tenantId),eq(lmcMessages.leadId,lead.id))).orderBy(asc(lmcMessages.createdAt),asc(lmcMessages.id));
      return {lead,message,history,settings:lmcBusinessSettingsSchema.parse(settings.config),timezone:business?.timezone};
    });
    if (!snapshot) return;
    const {lead,message,settings,history,timezone} = snapshot;
    if(!timezone)throw new Error("INVALID_JOB_PAYLOAD");
    const isEmergency = settings.emergencyKeywords.some(word=>message.body.toLowerCase().includes(word.toLowerCase()));
    const isInjection = message.headers["X-LMC-Injection-Detected"]==="true" || injection(`${lead.name ?? ""}\n${message.subject}\n${message.body}`);
    const isConfiguredEscalation = settings.escalation?.keywords.some(word=>message.body.toLowerCase().includes(word.toLowerCase())) ?? false;
    let actions: LmcStructuredAction[] = [];
    let suggestedReply: string | undefined;
    let decision: Pick<LmcEmailDecision, "intent" | "confidence"> | undefined;
    let modelOutcome: "not_called" | "success" = "not_called";
    if (!isEmergency && !isInjection && isConfiguredEscalation) actions=[{type:"handoff",reason:"configured_escalation"}];
    if (!isEmergency && !isInjection && !isConfiguredEscalation) {
      try {
        const result = await this.withLeaseHeartbeat(job,() => this.input.channel.run({channel:"email",tenant:{id:job.tenantId,settings},contact:{id:lead.contactId ?? lead.id,email:lead.email},message:{id:message.id,subject:redactLmcCapabilities(message.subject),text:redactLmcCapabilities(message.body)},
          history:history.filter(item=>item.id!==message.id && ["lead","assistant","human"].includes(item.direction)).map(item=>({role:item.direction as "lead"|"assistant"|"human",text:redactLmcCapabilities(item.body)}))}));
        actions = result.actions;
        suggestedReply = result.suggestedReply;
        decision = result.decision;
        modelOutcome = "success";
      } catch (error) {
        if (this.leaseFailure(error)) throw error;
        const failureCode = classifyLmcProcessingError(error);
        if (failureCode) {
          await this.scoped(job.tenantId, async (tx) => {
            await tx.insert(lmcEvents).values({
              tenantId: job.tenantId,
              leadId: lead.id,
              type: "email_processing_failed",
              externalId: `processing-failed:${job.id}:${job.attempts}`,
              metadata: { messageId: message.id, errorCategory: failureCode, attempt: job.attempts },
              createdAt: this.input.now(),
            });
          });
          throw new Error(failureCode);
        }
        actions=[{type:"handoff",reason:"model_unavailable"}];
      }
    }
    const alternativeAvailability=!isEmergency&&!isInjection&&isAlternativeAvailabilityRequest(message.body);
    const requestedDate=alternativeAvailability?requestedLocalDate(message.body,this.input.now(),timezone):undefined;
    if(alternativeAvailability){
      // A declined offer plus a requested day is a read-only availability query,
      // not a reschedule/complaint. Existing qualification is merged below.
      actions=[...actions.filter(action=>action.type==="qualify"),{type:"intent",intent:"availability"}];
      decision={intent:"availability",confidence:decision?.confidence??1};
      suggestedReply=undefined;
    }
    const proposed={...lead.qualification};
    for(const action of actions)if(action.type==="qualify"&&action.confidence>=settings.confidenceThreshold){const fields=lmcQualificationSchema.safeParse(action.fields);if(fields.success)Object.assign(proposed,fields.data);}
    const intentAction=actions.find(action=>action.type==="intent");
    const proposedService=settings.services.find(item=>[item.name,...item.aliases].some(name=>name.toLowerCase()===proposed.serviceType?.toLowerCase()));
    let availableSlots:Lead["offeredSlots"]=[];
    let requestedDateUnavailable=false;
    if(!isEmergency&&!isInjection&&!actions.some(action=>action.type==="handoff"||action.type==="clarify")&&proposedService&&proposed.zip&&settings.serviceAreaZips.includes(proposed.zip)&&proposed.propertyType&&settings.tools.includes("availability")&&(!intentAction||intentAction.type!=="intent"||["qualification","availability","price"].includes(intentAction.intent))){
      try{
        availableSlots=await this.withLeaseHeartbeat(job,() => listEmailVisitSlots(this.input.database,{tenantId:job.tenantId,serviceId:proposedService.id,now:this.input.now(),...(requestedDate?{requestedDate}:{}),...(alternativeAvailability&&!requestedDate?{excludeStartsAt:lead.offeredSlots.map(slot=>slot.startsAt)}:{})}));
        if(!availableSlots.length&&requestedDate){
          requestedDateUnavailable=true;
          availableSlots=await this.withLeaseHeartbeat(job,() => listEmailVisitSlots(this.input.database,{tenantId:job.tenantId,serviceId:proposedService.id,now:this.input.now(),excludeStartsAt:lead.offeredSlots.map(slot=>slot.startsAt)}));
        }
      }
      catch(error){if(this.leaseFailure(error))throw error;actions=[{type:"handoff",reason:"calendar_unavailable"}];}
    }
    await this.scoped(job.tenantId,async tx => {
      await this.lease(tx,job);
      const [current] = await tx.select().from(lmcLeads).where(and(eq(lmcLeads.tenantId,job.tenantId),eq(lmcLeads.id,lead.id))).for("update");
      if (!current || current.aiPaused || processingTerminal.has(current.status) || current.followupGeneration!==payload.generation || await this.suppressed(tx,current)) return;
      const [already] = await tx.select({id:lmcEvents.id}).from(lmcEvents).where(and(eq(lmcEvents.tenantId,job.tenantId),eq(lmcEvents.externalId,`processed:${job.id}`))).limit(1);
      if (already) return;
      let qualification={...current.qualification,...(current.name ? {name:current.name} : {})};
      let status=current.appointmentId?"booked":"qualifying", reason: string|null=null, paused=false, alert=false, appointmentId=current.appointmentId;
      let offeredSlots=current.offeredSlots;
      let text="Please share your ZIP code, the service you need, and whether the property is residential or commercial.";
      if (isEmergency) {
        qualification={...qualification,urgency:"emergency"}; status="human_handoff"; reason="emergency"; paused=true; alert=true; text=settings.emergencyText;
      } else if (isInjection) {
        status="human_handoff"; reason="prompt_injection_detected"; paused=true; alert=true; text="A team member will review your request and reply personally.";
        await tx.insert(lmcEvents).values({tenantId:job.tenantId,leadId:lead.id,type:"prompt_injection_detected",metadata:{messageId:message.id},createdAt:this.input.now()});
      } else {
        for (const action of actions) if (action.type==="qualify") {
          const parsed=lmcQualificationSchema.safeParse(action.fields);
          if (!parsed.success || !Number.isFinite(action.confidence) || action.confidence<settings.confidenceThreshold) {actions=[{type:"handoff",reason:"invalid_model_output"}];break;}
          qualification={...qualification,...parsed.data};
        }
        const handoff=actions.find(action=>action.type==="handoff");
        const clarification=actions.find(action=>action.type==="clarify");
        const intent=actions.find(action=>action.type==="intent");
        const requestedService=qualification.serviceType?.toLowerCase();
        const service=requestedService ? settings.services.find(item=>[item.name,...item.aliases].some(name=>name.toLowerCase()===requestedService)) : undefined;
        if (qualification.zip && !settings.serviceAreaZips.includes(qualification.zip)) {status="declined";reason="outside_service_area";text="This location is outside our service area. We do not serve that ZIP code.";}
        else if (requestedService && !service) {status="declined";reason="unsupported_service";text="We do not offer the requested service. Our team can help only with our listed services.";}
        else if (handoff || (intent?.type==="intent" && ["complaint","complex"].includes(intent.intent))) {
          status="human_handoff";reason=handoff?.type==="handoff" ? handoff.reason : "human_review_required";paused=true;alert=true;text=reason==="configured_escalation" ? settings.escalation!.replyText : "A team member will review your request and reply personally.";
        } else if(clarification){
          text=suggestedReply ?? "Could you clarify what you would like help with?";
        } else if(intent?.type==="intent"&&intent.intent==="question"){
          text=suggestedReply ?? "Could you clarify your question so I can look up the right business information?";
        } else if(intent?.type==="intent"&&(intent.intent==="cancel"||intent.intent==="reschedule")){
          const [existing]=current.appointmentId&&current.contactId ? await tx.select({id:appointments.id,serviceId:appointments.serviceId}).from(appointments).innerJoin(contacts,and(eq(contacts.businessId,job.tenantId),eq(contacts.id,appointments.contactId),eq(contacts.email,current.email))).where(and(eq(appointments.businessId,job.tenantId),eq(appointments.id,current.appointmentId),eq(appointments.contactId,current.contactId),eq(appointments.sourceChannel,"email"),eq(appointments.status,"confirmed"))).limit(1) : [];
          const chosen=current.offeredSlots.find(slot=>slot.startsAt===intent.requestedSlot&&slot.serviceId===existing?.serviceId);
          if(!current.verifiedAt||!current.contactId||!existing||!settings.tools.includes(intent.intent)){
            status="human_handoff";reason="appointment_change_not_verified";paused=true;alert=true;text="A team member will verify your appointment change request.";
          }else if(intent.intent==="cancel"){
            const result=await cancelAppointmentInTransaction(tx,{businessId:job.tenantId,appointmentId:existing.id,change:{source:"api",audit:{actorUserId:null,payload:{source:"email",leadId:current.id}}}});
            if(result!=="missing"){status="qualified";reason="appointment_cancelled";appointmentId=null;offeredSlots=[];alert=true;text="Your appointment has been cancelled. Reply if you would like to arrange another visit.";}
          }else if(chosen){
            const changed=await rescheduleEmailAppointmentInTransaction(tx,{businessId:job.tenantId,appointmentId:existing.id,contactId:current.contactId,contactEmail:current.email,staffId:chosen.staffId,startsAt:chosen.startsAt,now:this.input.now()});
            if(changed){status="booked";reason="appointment_rescheduled";alert=true;text=`Your visit has been rescheduled to ${formatEmailVisitTime(changed.startsAt,timezone)}.`;}
            else{status="human_handoff";reason="slot_no_longer_available";paused=true;alert=true;text="That time is no longer available. A team member will help arrange the change.";}
          }else{status="human_handoff";reason="reschedule_time_not_offered";paused=true;alert=true;text="A team member will help you choose and verify another available visit time.";}
        } else if(current.appointmentId){text="Your visit is already booked. Reply if you need to reschedule or cancel.";}
        else if(intent?.type==="intent"&&intent.intent==="book"){
          const chosen=current.offeredSlots.find(slot=>slot.startsAt===intent.requestedSlot&&slot.serviceId===service?.id);
          if(!current.verifiedAt||!current.contactId||!qualification.zip||!qualification.propertyType||!chosen||!settings.tools.includes("book")){
            status="human_handoff";reason="booking_not_verified";paused=true;alert=true;text="A team member will help verify your request and arrange your visit.";
          }else{
            const booked=await bookEmailAppointmentInTransaction(tx,{businessId:job.tenantId,contactId:current.contactId,contactEmail:current.email,serviceId:chosen.serviceId,staffId:chosen.staffId,startsAt:chosen.startsAt,now:this.input.now()});
            if(booked){appointmentId=booked.appointmentId;status="booked";reason="booked";alert=true;text=`Your visit is booked for ${formatEmailVisitTime(booked.startsAt,timezone)}. A team member will confirm any further details.`;}
            else{status="human_handoff";reason="slot_no_longer_available";paused=true;alert=true;text="That time is no longer available. A team member will help arrange another visit.";}
          }
        } else if(service&&qualification.zip&&qualification.propertyType&&availableSlots.length){
          qualification.serviceType=service.name;offeredSlots=availableSlots;status="qualified";
          const times=availableSlots.map(slot=>formatEmailVisitTime(slot.startsAt,timezone));
          text=requestedDateUnavailable&&requestedDate
            ? `We don't have verified availability on ${formatEmailVisitDate(requestedDate,timezone)}, but these are our next available times: ${times.join(", ")}. Would one of these work?`
            : `Available visit times: ${times.join(", ")}. Reply with the time you would like us to book.`;
          if(intent?.type==="intent"&&intent.intent==="price")text=`${settings.priceInformation || "We need an inspection to provide an estimate; we cannot quote a price by email."} ${text}`;
        } else if(alternativeAvailability&&service&&qualification.zip&&qualification.propertyType){
          status="qualified";reason="requested_date_unavailable";paused=false;
          text=requestedDate?`I can't verify an opening on ${formatEmailVisitDate(requestedDate,timezone)} or find another confirmed time right now. Is there another date that could work?`:`I couldn't find another confirmed time yet. Is there a date that works better for you?`;
        } else if(service&&qualification.zip&&qualification.propertyType&&(!intent||intent.type!=="intent"||intent.intent!=="wait")){
          status="human_handoff";reason="no_verified_calendar_slots";paused=true;alert=true;text="A team member will help arrange an inspection once calendar availability is verified.";
        } else if (intent?.type==="intent" && intent.intent==="wait") {text="Thank you. We will wait for you to contact our office.";}
        else {
          if (service) qualification.serviceType=service.name;
          text=buildEmailQualificationPrompt(settings,qualification,Boolean(service));
          if (intent?.type==="intent" && intent.intent==="price") text=`${settings.priceInformation || "We need an inspection to provide an estimate; we cannot quote a price by email."} ${text}`;
        }
      }
      await tx.update(lmcLeads).set({qualification,status,reason,aiPaused:paused,appointmentId,offeredSlots,updatedAt:this.input.now()}).where(and(eq(lmcLeads.tenantId,job.tenantId),eq(lmcLeads.id,lead.id)));
      await this.outbound(tx,job,current,message,settings,payload.replyToken,text,"reply",paused,payload.generation);
      if (alert) {
        const transcript=history.map(item=>`[${item.direction}] ${item.body}`).join("\n\n");
        const summary=`Lead: ${current.email}\nZIP: ${qualification.zip ?? "unknown"}\nService: ${qualification.serviceType ?? "unknown"}\nReason: ${reason}\n\nHistory:\n${transcript}`;
        const full=summary.length>45_000 ? `${summary.slice(0,45_000)}\nFull history: ${this.baseUrl}/leads/${lead.id}` : summary;
        await this.outbound(tx,job,current,message,settings,payload.replyToken,full,"owner_alert",true,payload.generation);
      }
      await tx.insert(lmcEvents).values({tenantId:job.tenantId,leadId:lead.id,type:"email_processed",externalId:`processed:${job.id}`,metadata:{messageId:message.id,status,reason,attempt:job.attempts,modelOutcome,...summarizeLmcActions(actions,decision)},createdAt:this.input.now()});
    });
  }

  private async followup(job:LmcJob){
    const payload=lmcFollowupJobSchema.parse(job.payload);
    await this.scoped(job.tenantId,async tx=>{
      await this.lease(tx,job);
      const [lead]=await tx.select().from(lmcLeads).where(and(eq(lmcLeads.tenantId,job.tenantId),eq(lmcLeads.id,job.leadId))).for("update");
      const [settings]=await tx.select().from(lmcSettings).where(eq(lmcSettings.tenantId,job.tenantId)).limit(1);
      const [message]=await tx.select().from(lmcMessages).where(and(eq(lmcMessages.tenantId,job.tenantId),eq(lmcMessages.leadId,job.leadId),eq(lmcMessages.id,payload.messageId))).limit(1);
      if(!lead||!settings||!message||!verifyReplyToken(payload.replyToken,job.tenantId,lead.replyTokenHash))throw new Error("INVALID_JOB_PAYLOAD");
      const config=lmcBusinessSettingsSchema.parse(settings.config);
      if(!settings.enabled||!config.followups.enabled||!config.followups.dailyCap||!lead.consentFollowups||lead.aiPaused||terminal.has(lead.status)||lead.followupGeneration!==payload.generation||payload.generation!==0||payload.touch>config.followups.maxTouches||lead.followupCount>=payload.touch||await this.suppressed(tx,lead))return;
      if(payload.touch!==lead.followupCount+1)throw new Error("LMC_JOB_FAILED");
      const [done]=await tx.select({id:lmcEvents.id}).from(lmcEvents).where(and(eq(lmcEvents.tenantId,job.tenantId),eq(lmcEvents.externalId,`processed:${job.id}`))).limit(1);
      if(done)return;
      const thread={...message,messageId:lead.lastOutboundMessageId??message.messageId};
      await this.outbound(tx,job,lead,thread,config,payload.replyToken,"Are you still interested in help with your request? Reply when you are ready, or tell us to stop.","followup",false,payload.generation,payload.touch);
      await tx.insert(lmcEvents).values({tenantId:job.tenantId,leadId:lead.id,type:"followup_queued",externalId:`processed:${job.id}`,metadata:{touch:payload.touch},createdAt:this.input.now()});
    });
  }

  private async outbound(tx: DatabaseTransaction, job: LmcJob, lead: Lead, incoming: Message, settings: LmcBusinessSettings, replyToken: string, body: string, kind: "reply"|"owner_alert"|"followup", allowPaused: boolean, generation: number, followupTouch?:number) {
    const id=randomUUID();
    const messageId=`<${job.id}-${kind}@${this.input.receivingDomain}>`;
    const headers:Record<string,string>={"Message-ID":messageId,"Auto-Submitted":"auto-generated"};
    let text=body;
    if (kind!=="owner_alert") {
      const token=signActionToken({tenantId:lead.tenantId,leadId:lead.id,purpose:"unsubscribe"},this.input.signingSecret);
      const unsubscribe=`${this.baseUrl}/api/lmc/unsubscribe/${token}`;
      text+=`\n\n${settings.physicalAddress}\nReply STOP or unsubscribe: ${unsubscribe}`;
      headers["List-Unsubscribe"]=`<${unsubscribe}>`;
      headers["List-Unsubscribe-Post"]="List-Unsubscribe=One-Click";
      if (incoming.headers["X-LMC-Ingestion-Source"] !== "forward") {
        headers["In-Reply-To"]=incoming.messageId;
        headers.References=incoming.messageId;
      }
    }
    const outbound:LmcOutboundEmail={tenantId:lead.tenantId,leadId:lead.id,idempotencyKey:`lmc:${id}`,kind,from:settings.fromEmail,to:kind==="owner_alert" ? settings.ownerEmail : lead.email,
      replyTo:kind==="owner_alert" ? settings.fromEmail : `reply+${replyToken}@${this.input.receivingDomain}`,subject:kind==="owner_alert" ? "Lead requires your attention" : `Re: ${lead.subject || "Your request"}`,text,headers};
    await tx.insert(lmcMessages).values({id,tenantId:lead.tenantId,leadId:lead.id,direction:kind==="owner_alert" ? "owner" : "assistant",kind,messageId,toEmail:outbound.to,subject:outbound.subject,body:text,headers,status:"queued",createdAt:this.input.now()});
    await enqueueLmcJob(tx,{tenantId:lead.tenantId,leadId:lead.id,kind:"send",dedupeKey:`send:${id}`,payload:{messageId:id,outbound,generation,allowPaused,...(followupTouch?{followupTouch}:{})},availableAt:this.input.now()});
  }

  private async send(job: LmcJob) {
    const payload=lmcSendJobSchema.parse(job.payload);
    const prepared=await (async()=>{
      let stage="lease";
      try {
        return await this.scoped(job.tenantId,async tx=>{
      await this.lease(tx,job);
      stage="load_records";
      const [lead]=await tx.select().from(lmcLeads).where(and(eq(lmcLeads.tenantId,job.tenantId),eq(lmcLeads.id,job.leadId))).for("update");
      const [message]=await tx.select().from(lmcMessages).where(and(eq(lmcMessages.tenantId,job.tenantId),eq(lmcMessages.leadId,job.leadId),eq(lmcMessages.id,payload.messageId))).for("update");
      const outgoing=payload.outbound;
      stage="payload_validation";
      if (!lead || !message || outgoing.tenantId!==job.tenantId || outgoing.leadId!==job.leadId || outgoing.headers["Message-ID"]!==message.messageId || outgoing.text!==message.body || outgoing.to!==message.toEmail || outgoing.subject!==message.subject || outgoing.kind!==message.kind) throw new Error("INVALID_JOB_PAYLOAD");
      const staleSending=message.status==="sending"&&job.attempts>1;
      if (message.status!=="queued"&&!staleSending) return null;
      const owner=message.kind==="owner_alert";
      stage="settings";
      const [settings]=await tx.select().from(lmcSettings).where(eq(lmcSettings.tenantId,job.tenantId)).limit(1);
      const config=settings ? lmcBusinessSettingsSchema.parse(settings.config) : null;
      stage="recipient_validation";
      const replyPrefix="reply+", replySuffix=`@${this.input.receivingDomain}`;
      const replyToken=outgoing.replyTo.startsWith(replyPrefix) && outgoing.replyTo.endsWith(replySuffix) ? outgoing.replyTo.slice(replyPrefix.length,-replySuffix.length) : "";
      const validRecipient=config && outgoing.from===config.fromEmail && outgoing.to===(owner ? config.ownerEmail : lead.email)
        && (owner ? outgoing.replyTo===config.fromEmail : verifyReplyToken(replyToken,job.tenantId,lead.replyTokenHash));
      if (outgoing.idempotencyKey!==`lmc:${message.id}` || JSON.stringify(outgoing.headers)!==JSON.stringify(message.headers)) throw new Error("INVALID_JOB_PAYLOAD");
      if (!settings?.enabled || !validRecipient || (!owner && (await this.suppressed(tx,lead) || ["suppressed","opted_out"].includes(lead.status) || lead.followupGeneration!==payload.generation || (lead.aiPaused && !payload.allowPaused)))) {
        await tx.update(lmcMessages).set({status:"cancelled"}).where(and(eq(lmcMessages.tenantId,job.tenantId),eq(lmcMessages.id,message.id)));return null;
      }
      // Resend expires idempotency keys after 24h. Never repeat an uncertain send beyond a conservative 23h window.
      if(job.attempts>1&&this.input.now().getTime()-message.createdAt.getTime()>23*3_600_000){
        await tx.update(lmcMessages).set({status:"failed"}).where(and(eq(lmcMessages.tenantId,job.tenantId),eq(lmcMessages.id,message.id)));
        await tx.update(lmcLeads).set({status:"human_handoff",reason:"delivery_reconciliation_required",aiPaused:true,followupGeneration:lead.followupGeneration+1,updatedAt:this.input.now()}).where(and(eq(lmcLeads.tenantId,job.tenantId),eq(lmcLeads.id,lead.id)));
        await tx.insert(lmcEvents).values({tenantId:job.tenantId,leadId:lead.id,type:"outbound_reconciliation_required",externalId:`reconcile:${message.id}`,metadata:{messageId:message.id},createdAt:this.input.now()});
        if(!owner&&config)await this.outbound(tx,job,lead,message,config,replyToken,`Delivery to ${lead.email} may already have succeeded. Automatic retry has stopped; review provider logs before retrying.\n\nLast message:\n${message.body}`,"owner_alert",true,lead.followupGeneration+1);
        return null;
      }
      let followupRateWindow:{scopeKey:string;windowStart:Date}|null=null;
      stage="followup_policy";
      if(outgoing.kind==="followup"){
        const touch=payload.followupTouch;
        if(!touch||!config?.followups.enabled||!config.followups.dailyCap||touch>config.followups.maxTouches||!lead.consentFollowups||terminal.has(lead.status)||lead.followupCount!==touch-1){
          await tx.update(lmcMessages).set({status:"cancelled"}).where(and(eq(lmcMessages.tenantId,job.tenantId),eq(lmcMessages.id,message.id)));return null;
        }
        const now=this.input.now(),windowStart=new Date(Math.floor(now.getTime()/86_400_000)*86_400_000),scopeKey="followup:daily";
        followupRateWindow={scopeKey,windowStart};
        const [allowance]=await tx.insert(lmcRateWindows).values({tenantId:job.tenantId,scopeKey,windowStart,count:1}).onConflictDoUpdate({target:[lmcRateWindows.tenantId,lmcRateWindows.scopeKey,lmcRateWindows.windowStart],set:{count:sql`${lmcRateWindows.count}+1`},setWhere:sql`${lmcRateWindows.count}<${config.followups.dailyCap}`}).returning({count:lmcRateWindows.count});
        if(!allowance){
          await tx.update(lmcJobs).set({status:"pending",leaseToken:null,leasedUntil:null,attempts:Math.max(0,job.attempts-1),availableAt:new Date(windowStart.getTime()+86_400_000),updatedAt:now}).where(and(eq(lmcJobs.tenantId,job.tenantId),eq(lmcJobs.id,job.id)));
          return null;
        }
      }
      stage="mark_sending";
      await tx.update(lmcMessages).set({status:"sending"}).where(and(eq(lmcMessages.tenantId,job.tenantId),eq(lmcMessages.id,message.id),or(eq(lmcMessages.status,"queued"),eq(lmcMessages.status,"sending"))));
      return {config,lead,message,outgoing,owner,replyToken,followupRateWindow};
        });
      } catch (error) {
        throw new Error(error instanceof Error && ["INVALID_JOB_PAYLOAD", "LMC_JOB_FAILED"].includes(error.message) ? error.message : `EMAIL_SEND_PREPARE_${stage.toUpperCase()}`);
      }
    })();
    if (!prepared) return;
    let delivery:{providerMessageId:string};
    try {
      delivery=await this.input.mail.send(prepared.outgoing);
    } catch (error) {
      await this.scoped(job.tenantId,async tx=>{
        await tx.update(lmcMessages).set({status:"queued"}).where(and(eq(lmcMessages.tenantId,job.tenantId),eq(lmcMessages.id,prepared.message.id),eq(lmcMessages.status,"sending")));
        if(prepared.followupRateWindow) await tx.update(lmcRateWindows).set({count:sql`${lmcRateWindows.count}-1`}).where(and(eq(lmcRateWindows.tenantId,job.tenantId),eq(lmcRateWindows.scopeKey,prepared.followupRateWindow.scopeKey),eq(lmcRateWindows.windowStart,prepared.followupRateWindow.windowStart),sql`${lmcRateWindows.count}>0`));
      });
      const code = error instanceof Error && ["INVALID_OUTBOUND_EMAIL", "IDEMPOTENCY_CONFLICT"].includes(error.message)
        ? error.message
        : "EMAIL_PROVIDER_UNAVAILABLE";
      throw new Error(code);
    }
    await this.scoped(job.tenantId,async tx=>{
      const [sent]=await tx.update(lmcMessages).set({status:"sent",providerId:delivery.providerMessageId,sentAt:this.input.now()}).where(and(eq(lmcMessages.tenantId,job.tenantId),eq(lmcMessages.id,prepared.message.id),eq(lmcMessages.status,"sending"))).returning({id:lmcMessages.id});
      if(!sent||prepared.owner)return;
      const [currentLead]=await tx.select().from(lmcLeads).where(and(eq(lmcLeads.tenantId,job.tenantId),eq(lmcLeads.id,job.leadId))).for("update");
      if(!currentLead)return;
      await tx.update(lmcLeads).set({lastOutboundMessageId:prepared.message.messageId,...(payload.followupTouch?{followupCount:payload.followupTouch}:{}),updatedAt:this.input.now()}).where(and(eq(lmcLeads.tenantId,job.tenantId),eq(lmcLeads.id,job.leadId)));
      if(prepared.config?.followups.enabled&&prepared.config.followups.dailyCap&&currentLead.consentFollowups&&!currentLead.aiPaused&&["qualifying","qualified"].includes(currentLead.status)&&currentLead.followupGeneration===0){
        const sentTouch=payload.followupTouch??0,nextTouch=sentTouch+1;
        const delay=prepared.config.followups.delaysHours[nextTouch-1],previous=sentTouch?prepared.config.followups.delaysHours[sentTouch-1]:0;
        if(nextTouch<=prepared.config.followups.maxTouches&&delay!==undefined&&previous!==undefined&&delay>previous){
          const [initial]=await tx.select({id:lmcMessages.id}).from(lmcMessages).where(and(eq(lmcMessages.tenantId,job.tenantId),eq(lmcMessages.leadId,job.leadId),eq(lmcMessages.direction,"lead"))).orderBy(asc(lmcMessages.createdAt),asc(lmcMessages.id)).limit(1);
          if(initial)await enqueueLmcJob(tx,{tenantId:job.tenantId,leadId:job.leadId,kind:"followup",dedupeKey:`followup:${job.leadId}:0:${nextTouch}`,payload:{messageId:initial.id,replyToken:prepared.replyToken,generation:0,touch:nextTouch},availableAt:new Date(this.input.now().getTime()+(delay-previous)*3_600_000)});
        }
      }
    });
  }
}
