import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { appointments, businesses, businessHours, businessMemberships, calendarConnections, contacts, lmcEvents, lmcLeads, lmcMessages, lmcSettings, services, staff, users, withBusinessTransaction, type DatabaseTransaction } from "@lobbystack/db";
import { FakeLmcInboundProvider, SecretBox, createFakeLmcProviders } from "@lobbystack/providers";
import type { LmcCaptureInput, LmcOutboundEmail, LmcProviderEvent, LmcInboundProvider } from "@lobbystack/contracts";
import { EmailChannel } from "../../../packages/agent-core/src/channels";
import { createReplyToken } from "../../../packages/domain/src/server/lmc/capabilities";
import { handleLmcCapture, LmcLeadCapture } from "../../../packages/domain/src/server/lmc/capture";
import { handleLmcEmailWebhook, handleLmcUnsubscribe, LmcEmailReception } from "../../../packages/domain/src/server/lmc/reception";
import { LmcHumanReplies } from "../../../packages/domain/src/server/lmc/handoff";
import { LmcEmailWorker } from "../../../packages/domain/src/server/lmc/worker";
import { classifyLmcJobFailure, type LmcJobFailureDiagnostic } from "../../../packages/domain/src/server/lmc/queue";
import { upsertBusyBlocks } from "../../../packages/domain/src/server/calendar";
import { candidateStartTimes } from "../../../packages/domain/src/server/receptionistActions";
import { syncAppointmentCalendar } from "../../../apps/worker/src/calendarJobs";
import { openLmcTestDatabase } from "./database";

/** Production HTTP boundaries + application worker + PostgreSQL; only external providers and clock are fake. */
export async function createLmcHarness(input:{now:string;inboundProvider?:LmcInboundProvider;serviceName?:string;timezone?:string}){
  const db=openLmcTestDatabase(),tenantId=randomUUID(),ownerId=randomUUID(),staffId=randomUUID(),serviceId=randomUUID(),connectionId=randomUUID();
  const providers=createFakeLmcProviders(),ownerEmail="owner@example.invalid",captureToken=createReplyToken(tenantId),calendarId=`calendar-${tenantId}`;
  const emergencyText="Please stay clear of damaged areas. Our team will contact you urgently about the emergency.";
  let clock=Date.parse(input.now);
  const now=()=>new Date(clock),signingSecret=randomBytes(32).toString("hex");
  const extraUsers:string[]=[];
  const previousEncryptionKey=process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY??=randomBytes(32).toString("hex");
  const box=new SecretBox(process.env.ENCRYPTION_KEY);
  const inbound=new FakeLmcInboundProvider({env:{NODE_ENV:"test"},now:()=>clock});
  providers.calendar.authorizeCalendar(calendarId);
  const hours=Array.from({length:7},(_,dayOfWeek)=>({dayOfWeek,openMinutes:9*60,closeMinutes:17*60}));
  const timezone=input.timezone??"America/New_York",serviceName=input.serviceName??"roof repair";
  await db.admin.db.insert(businesses).values({id:tenantId,slug:`lmc-e2e-${tenantId}`,name:"Florida Roofing",timezone,businessType:"service_company"});
  await db.admin.db.insert(users).values({id:ownerId,email:`${ownerId}@example.invalid`,normalizedEmail:`${ownerId}@example.invalid`});
  await db.admin.db.insert(businessMemberships).values({businessId:tenantId,userId:ownerId,role:"business_owner"});
  await db.admin.db.insert(staff).values({id:staffId,businessId:tenantId,name:"Roof Inspector",timezone});
  await db.admin.db.insert(services).values({id:serviceId,businessId:tenantId,name:serviceName,slug:serviceName.toLowerCase().replace(/[^a-z0-9]+/g,"-"),durationMinutes:60});
  await db.admin.db.insert(businessHours).values(hours.map(hour=>({...hour,businessId:tenantId})));
  await db.admin.db.insert(calendarConnections).values({id:connectionId,businessId:tenantId,ownerUserId:ownerId,staffId,provider:"google",externalAccountId:`fake-${tenantId}`,selectedCalendarId:calendarId,encryptedAccessToken:box.encrypt("fake-calendar-token"),tokenExpiresAt:new Date("2040-01-01"),lastSyncedAt:now()});
  await db.admin.db.insert(lmcSettings).values({tenantId,captureTokenHash:captureToken.hash,config:{ownerEmail,fromEmail:"team@example.invalid",physicalAddress:"100 Main Street, Miami FL 33101",serviceAreaZips:["33101","33102"],serviceAreaCities:["Miami"],services:[{id:serviceId,name:serviceName,aliases:serviceName==="roof repair"?["roof replacement"]:[]}],emergencyKeywords:["active leak","storm damage"],emergencyText,priceInformation:"",tone:"professional",confidenceThreshold:0.8,tools:["availability","book","reschedule","cancel","handoff"],followups:{enabled:true,maxTouches:3,delaysHours:[24,48,72],dailyCap:100}}});
  const jobFailures:LmcJobFailureDiagnostic[]=[];
  const captureService=new LmcLeadCapture({database:db.worker.db,now});
  const reception=new LmcEmailReception({database:db.worker.db,now,receivingDomain:"inbound.example.invalid",signingSecret});
  const human=new LmcHumanReplies({database:db.app.db,now,baseUrl:"https://lmc.example",receivingDomain:"inbound.example.invalid",signingSecret});
  const worker=new LmcEmailWorker({database:db.worker.db,dispatcher:db.dispatcher.db,now,channel:new EmailChannel(providers.model),mail:providers.email,baseUrl:"https://lmc.example",receivingDomain:"inbound.example.invalid",signingSecret,onJobFailure:diagnostic=>jobFailures.push(diagnostic)});
  const scoped=<T>(fn:Parameters<typeof withBusinessTransaction<T>>[2])=>withBusinessTransaction(db.worker.db,{businessId:tenantId,actorType:"worker"},fn);
  const server=createServer(async(req,res)=>{
    try{
      const method=req.method ?? "GET";
      const init:RequestInit&{duplex?:"half"}={method,headers:new Headers(Object.entries(req.headers).flatMap<[string,string]>(([key,value])=>value===undefined?[]:[[key,Array.isArray(value)?value.join(", "):value]]))};
      if(method!=="GET"&&method!=="HEAD"){init.body=Readable.toWeb(req) as ReadableStream<Uint8Array>;init.duplex="half";}
      const request=new Request(`http://127.0.0.1${req.url}`,init),url=new URL(request.url);
      let response:Response;
      if(url.pathname===`/api/lmc/capture/${captureToken.value}`)response=await handleLmcCapture(request,captureToken.value,captureService);
      else if(url.pathname==="/api/lmc/webhook")response=await handleLmcEmailWebhook(request,input.inboundProvider??inbound,reception);
      else if(url.pathname.startsWith("/api/lmc/unsubscribe/"))response=await handleLmcUnsubscribe(request,url.pathname.split("/").at(-1)!,reception);
      else response=new Response("Not found",{status:404});
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    }catch{res.writeHead(500);res.end("Harness transport error");}
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();if(!address||typeof address==="string")throw new Error("TEST_HTTP_START_FAILED");
  const base=`http://127.0.0.1:${address.port}`;
  const allowedSlots=Array.from({length:7},(_,day)=>candidateStartTimes({date:new Date(clock+day*86_400_000).toISOString().slice(0,10),timezone:"America/New_York",hours,durationMinutes:60,now:now()})).flat();
  const h={captureUrl:`${base}/api/lmc/capture/${captureToken.value}`,tenantId,ownerId,ownerEmail,now,workerDatabase:db.worker.db,dispatcherDatabase:db.dispatcher.db,appDatabase:db.app.db,emergencyText,allowedSlots,mail:providers.email,model:providers.model,calendar:providers.calendar,jobFailures,scoped,
    async addViewer(){const id=randomUUID();await db.admin.db.insert(users).values({id,email:`${id}@example.invalid`,normalizedEmail:`${id}@example.invalid`});await db.admin.db.insert(businessMemberships).values({businessId:tenantId,userId:id,role:"viewer"});extraUsers.push(id);return id;},
    async setDailyCap(cap:number){await withBusinessTransaction(db.app.db,{businessId:tenantId,userId:ownerId,actorType:"operator"},async tx=>{
      const [settings]=await tx.select().from(lmcSettings).where(eq(lmcSettings.tenantId,tenantId));if(!settings)throw new Error("SETTINGS_NOT_FOUND");
      await tx.update(lmcSettings).set({config:{...settings.config,followups:{...settings.config.followups,dailyCap:cap}}}).where(eq(lmcSettings.tenantId,tenantId));
    });},
    async capture(value:Partial<LmcCaptureInput>&{email:string;message:string}){
      const response=await fetch(`${base}/api/lmc/capture/${captureToken.value}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({requestId:randomUUID(),...value})});
      if(response.status!==202)throw new Error(`Capture failed: ${response.status}`);
      return await response.json() as {id:string};
    },
    async work(){
      try {
        const blocks=await providers.calendar.getBusyBlocks({accessToken:"fake-only",calendarId,startsAt:now().toISOString(),endsAt:new Date(clock+90*86_400_000).toISOString()});
        await upsertBusyBlocks({db:db.worker.db},{businessId:tenantId,connectionId,calendarId,markSynced:true,syncStartedAt:now(),blocks:blocks.map((block:{startsAt:string;endsAt:string;externalEventId?:string})=>({...block,staffId}))});
        const result=await worker.drain();
        const rows=await scoped((tx:DatabaseTransaction)=>tx.select({id:appointments.id}).from(appointments).where(and(eq(appointments.businessId,tenantId),eq(appointments.calendarSyncState,"pending"))));
        for(const row of rows)await syncAppointmentCalendar({domain:{db:db.worker.db},calendar:providers.calendar},{businessId:tenantId,appointmentId:row.id});
        return result;
      } catch (error) {
        const classified=classifyLmcJobFailure(error);
        if (error instanceof Error && /^LMC_WORKER_[A-Z0-9_]+$/.test(error.message))throw new Error(error.message);
        if(classified.category==="rls")throw new Error("LMC_DATABASE_RLS");
        if(classified.category==="database")throw new Error(classified.code);
        if(classified.category==="idempotency")throw new Error("IDEMPOTENCY_CONFLICT");
        throw new Error("LMC_ACCEPTANCE_WORK_FAILED");
      }
    },
    async lead(id:string){const [lead]=await scoped(tx=>tx.select().from(lmcLeads).where(eq(lmcLeads.id,id)));if(!lead)throw new Error("LEAD_NOT_FOUND");return{...lead,offeredSlots:lead.offeredSlots.map(slot=>slot.startsAt)};},
    async bookings(){return(await scoped(tx=>tx.select({startsAt:appointments.startsAt,contactEmail:contacts.email}).from(appointments).innerJoin(contacts,eq(contacts.id,appointments.contactId)).where(and(eq(appointments.businessId,tenantId),ne(appointments.status,"canceled"))))).map(row=>({...row,startsAt:row.startsAt.toISOString()}));},
    history(id:string){return scoped(tx=>tx.select().from(lmcMessages).where(eq(lmcMessages.leadId,id)).orderBy(asc(lmcMessages.createdAt),asc(lmcMessages.id)));},
    events(id:string){return scoped(tx=>tx.select().from(lmcEvents).where(eq(lmcEvents.leadId,id)));},
    async replyEvent(id:string,text:string,options:{headers?:Record<string,string>}={}){
      const lead=await h.lead(id),outgoing=providers.email.records.filter(mail=>mail.leadId===id&&mail.to===lead.email).at(-1);
      if(!outgoing)throw new Error("NO_OUTBOUND_THREAD");
      return{kind:"message",id:randomUUID(),email:{from:lead.email,to:outgoing.replyTo,subject:`Re: ${lead.subject}`,text,headers:{"Message-ID":`<${randomUUID()}@example.invalid>`,"In-Reply-To":outgoing.headers["Message-ID"]!,...options.headers},authentication:{spf:"pass",dkim:"pass",dmarc:"pass",aligned:true},attachments:[]}} as LmcProviderEvent;
    },
    postInbound(rawBody:string,headers:Headers){return fetch(`${base}/api/lmc/webhook`,{method:"POST",body:rawBody,headers});},
    async deliver(event:LmcProviderEvent){const prepared=inbound.prepare(event);const response=await fetch(`${base}/api/lmc/webhook`,{method:"POST",body:prepared.rawBody,headers:prepared.headers});if(response.status!==200)throw new Error(`Webhook failed: ${response.status}`);},
    async reply(id:string,text:string,options:{headers?:Record<string,string>}={}){await h.deliver(await h.replyEvent(id,text,options));},
    async qualifiedLead(email:string){const lead=await h.capture({email,name:"Ana",message:"I need roof repair, ZIP 33101, residential homeowner."});await h.work();await h.reply(lead.id,"Roof repair, ZIP 33101, residential homeowner.");await h.work();return lead;},
    async humanReply(id:string,text:string){return human.reply({tenantId,userId:ownerId,leadId:id},{requestId:randomUUID(),text});},
    async humanReplyAs(userId:string,id:string,text:string,requestId=randomUUID()){return human.reply({tenantId,userId,leadId:id},{requestId,text});},
    async unsubscribe(mail:LmcOutboundEmail){const path=new URL(mail.headers["List-Unsubscribe"]!.slice(1,-1)).pathname;const response=await fetch(`${base}${path}`,{method:"POST",body:"List-Unsubscribe=One-Click"});if(response.status!==200)throw new Error("UNSUBSCRIBE_FAILED");},
    async bounce(id:string){const lead=await h.lead(id),mail=providers.email.records.filter(mail=>mail.leadId===id&&mail.to===lead.email).at(-1)!;await h.deliver({kind:"suppression",id:randomUUID(),tenantId,providerMessageId:mail.providerMessageId,email:lead.email,reason:"bounce"});},
    advanceDays(days:number){clock+=days*86_400_000;},
    advanceMilliseconds(milliseconds:number){clock+=milliseconds;},
    async close(){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await db.admin.db.transaction(async tx=>{
      await tx.execute(sql`select id from businesses where id=${tenantId}::uuid for update`);
      await tx.execute(sql`delete from outbox_messages where business_id=${tenantId}::uuid`);
      await tx.delete(businesses).where(eq(businesses.id,tenantId));
    });await db.admin.db.delete(users).where(inArray(users.id,[ownerId,...extraUsers]));await db.close();if(previousEncryptionKey===undefined)delete process.env.ENCRYPTION_KEY;else process.env.ENCRYPTION_KEY=previousEncryptionKey;},
  };
  return h;
}
