import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { acceptInvitation, activateManagedLmcClient, inviteManagedLmcOwner, isLmcPilotSetupRequired, pauseManagedLmcClient, provisionManagedLmcClient, readManagedClientReadiness, resolveLmcPilotPageAccess, updateManagedLmcDraft } from "@lobbystack/domain";
import { businessHours, businessMemberships, businesses, calendarConnections, lmcSettings, outboxMessages, platformAdminAuditEvents, platformAdminOperations, services, staff, users, withBusinessTransaction } from "@lobbystack/db";
import { createLmcHarness } from "./support/harness";
import { openLmcTestDatabase } from "./support/database";

const draft = (suffix:string,ownerEmail:string) => ({ name:`HVAC ${suffix}`,slug:`hvac-${suffix}-${randomUUID().slice(0,8)}`,timezone:"America/New_York",businessType:"HVAC",ownerEmail,hours:[{dayOfWeek:1,openMinutes:480,closeMinutes:1020}],settings:{ownerEmail,fromEmail:"team@example.invalid",physicalAddress:"100 Main Street, Miami FL 33101",serviceAreaZips:["33101"],serviceAreaCities:["Miami"],services:[{slug:"hvac-repair",name:"HVAC repair",aliases:["AC repair"],durationMinutes:60}],emergencyKeywords:["gas smell"],emergencyText:"Leave the property and contact emergency services immediately.",priceInformation:"Diagnostic fee confirmed by the office.",tone:"professional" as const,confidenceThreshold:0.8,tools:["availability","book","handoff"] as const,followups:{enabled:false,maxTouches:0,delaysHours:[],dailyCap:0},faqs:[{question:"Do you service heat pumps?",answer:"Yes, our team services residential heat pumps."}]}});

it("provisions two isolated drafts idempotently and grants only each verified invited owner",async()=>{
  const a=await createLmcHarness({now:"2030-01-09T03:40:00Z"}),b=await createLmcHarness({now:"2030-01-09T03:40:00Z"}),db=openLmcTestDatabase();
  const actor=a.ownerId,created:string[]=[];
  try{
    const ownerA=b.ownerId,ownerB=await b.addViewer();
    const actorWorkspace=(await db.admin.db.select({active:users.activeBusinessId}).from(users).where(eq(users.id,actor)))[0]!.active;
    await db.admin.db.update(users).set({platformRole:"platform_admin",emailVerified:true,twoFactorEnabled:true}).where(eq(users.id,actor));
    await db.admin.db.update(users).set({emailVerified:true}).where(sql`${users.id} in (${ownerA}::uuid,${ownerB}::uuid)`);
    const context={db:db.app.db},requestA=draft("alpha",`${ownerA}@example.invalid`),requestB=draft("beta",`${ownerB}@example.invalid`);
    const first=await provisionManagedLmcClient(context,{actorUserId:actor,idempotencyKey:"create-alpha",requestId:randomUUID(),draft:requestA});created.push(first.tenantId);
    const retry=await provisionManagedLmcClient(context,{actorUserId:actor,idempotencyKey:"create-alpha",requestId:randomUUID(),draft:requestA});
    expect(retry).toEqual({...first,created:false});
    await expect(provisionManagedLmcClient(context,{actorUserId:actor,idempotencyKey:"create-alpha",requestId:randomUUID(),draft:{...requestA,name:"Different"}})).rejects.toMatchObject({code:"idempotency_conflict"});
    const second=await provisionManagedLmcClient(context,{actorUserId:actor,idempotencyKey:"create-beta",requestId:randomUUID(),draft:requestB});created.push(second.tenantId);
    expect(await db.admin.db.select().from(businessMemberships).where(and(eq(businessMemberships.userId,actor),eq(businessMemberships.businessId,first.tenantId)))).toEqual([]);
    expect((await db.admin.db.select({active:users.activeBusinessId}).from(users).where(eq(users.id,actor)))[0]!.active).toBe(actorWorkspace);
    await expect(updateManagedLmcDraft(context,{actorUserId:actor,tenantId:first.tenantId,expectedRevision:99,requestId:randomUUID(),draft:requestA})).rejects.toMatchObject({code:"revision_conflict"});
    await expect(provisionManagedLmcClient(context,{actorUserId:ownerA,idempotencyKey:"ordinary",requestId:randomUUID(),draft:requestB})).rejects.toThrow("Platform administrator");
    for(const [tenantId,key,ownerId] of [[first.tenantId,"invite-a",ownerA],[second.tenantId,"invite-b",ownerB]] as const){
      const invited=await inviteManagedLmcOwner(context,{actorUserId:actor,tenantId,idempotencyKey:key,requestId:randomUUID(),appBaseUrl:"http://localhost:3000"});
      expect(await inviteManagedLmcOwner(context,{actorUserId:actor,tenantId,idempotencyKey:key,requestId:randomUUID(),appBaseUrl:"http://localhost:3000"})).toEqual({...invited,created:false});
      const [message]=await db.admin.db.select({payload:outboxMessages.payload}).from(outboxMessages).where(and(eq(outboxMessages.businessId,tenantId),eq(outboxMessages.aggregateId,invited.invitationId)));
      const token=String((message!.payload as {token:string}).token);const tokenHash=(await import("node:crypto")).createHash("sha256").update(token).digest("hex");
      await expect(acceptInvitation({db:db.app.db},{userId:ownerId,tokenHash,verifiedEmail:"wrong@example.invalid"})).rejects.toMatchObject({code:"invitation_email_mismatch"});
      await acceptInvitation({db:db.app.db},{userId:ownerId,tokenHash,verifiedEmail:`${ownerId}@example.invalid`});
      expect(await resolveLmcPilotPageAccess({database:db.app.db,authDatabase:db.admin.db},ownerId)).toBeNull();
      expect(await isLmcPilotSetupRequired({database:db.app.db,authDatabase:db.admin.db},ownerId)).toBe(true);
    }
    await withBusinessTransaction(db.app.db,{actorType:"operator",userId:ownerA,businessId:first.tenantId},async tx=>{
      expect(await tx.select({id:businesses.id}).from(businesses).where(eq(businesses.id,first.tenantId))).toHaveLength(1);
      expect(await tx.select({id:businesses.id}).from(businesses).where(eq(businesses.id,second.tenantId))).toEqual([]);
      expect(await tx.update(businesses).set({name:"forbidden"}).where(eq(businesses.id,second.tenantId)).returning()).toEqual([]);
    });
    await withBusinessTransaction(db.app.db,{actorType:"operator",userId:ownerB,businessId:second.tenantId},async tx=>expect(await tx.select({id:businesses.id}).from(businesses).where(eq(businesses.id,first.tenantId))).toEqual([]));
    expect(await db.admin.db.select().from(platformAdminAuditEvents).where(eq(platformAdminAuditEvents.actorUserId,actor))).not.toHaveLength(0);
  }finally{
    await db.admin.db.delete(platformAdminOperations).where(eq(platformAdminOperations.actorUserId,actor));
    await db.admin.db.delete(platformAdminAuditEvents).where(eq(platformAdminAuditEvents.actorUserId,actor));
    for(const id of created)await db.admin.db.delete(businesses).where(eq(businesses.id,id));
    await b.close();await a.close();await db.close();
  }
},30000);

it("activates only after the verified owner connects and syncs a writable calendar, then pauses without deleting history",async()=>{
  const adminFixture=await createLmcHarness({now:"2030-01-09T03:40:00Z"}),ownerFixture=await createLmcHarness({now:"2030-01-09T03:40:00Z"}),db=openLmcTestDatabase();
  const actor=adminFixture.ownerId,ownerId=ownerFixture.ownerId,created:string[]=[];
  const environment={senderEmail:"team@example.invalid",emailProviderReady:true};
  try{
    await db.admin.db.update(users).set({platformRole:"platform_admin",emailVerified:true,twoFactorEnabled:true}).where(eq(users.id,actor));
    await db.admin.db.update(users).set({emailVerified:true}).where(eq(users.id,ownerId));
    const request=draft("activation",`${ownerId}@example.invalid`),context={db:db.app.db};
    const client=await provisionManagedLmcClient(context,{actorUserId:actor,idempotencyKey:"activation-client",requestId:randomUUID(),draft:request});created.push(client.tenantId);
    const invitation=await inviteManagedLmcOwner(context,{actorUserId:actor,tenantId:client.tenantId,idempotencyKey:"activation-invite",requestId:randomUUID(),appBaseUrl:"http://localhost:3000"});
    const [message]=await db.admin.db.select({payload:outboxMessages.payload}).from(outboxMessages).where(and(eq(outboxMessages.businessId,client.tenantId),eq(outboxMessages.aggregateId,invitation.invitationId)));
    const token=String((message!.payload as {token:string}).token),tokenHash=(await import("node:crypto")).createHash("sha256").update(token).digest("hex");
    await acceptInvitation({db:db.app.db},{userId:ownerId,tokenHash,verifiedEmail:`${ownerId}@example.invalid`});
    const before=await readManagedClientReadiness(context,{actorUserId:actor,tenantId:client.tenantId,environment});
    expect(before.checks).toMatchObject({draft:true,verifiedOwner:true,calendarAuthorized:false,calendarSelected:false,calendarFresh:false,senderConfigured:true});
    await expect(activateManagedLmcClient(context,{actorUserId:actor,tenantId:client.tenantId,idempotencyKey:"too-early",requestId:randomUUID(),environment})).rejects.toMatchObject({code:"client_not_ready"});
    const [defaultStaff]=await db.admin.db.select({id:staff.id}).from(staff).where(eq(staff.businessId,client.tenantId)).limit(1);
    await db.admin.db.insert(calendarConnections).values({businessId:client.tenantId,ownerUserId:ownerId,staffId:defaultStaff!.id,provider:"google",externalAccountId:`${ownerId}@example.invalid`,selectedCalendarId:"primary",encryptedAccessToken:"encrypted-test-token",status:"connected",lastSyncedAt:new Date()});
    const ready=await readManagedClientReadiness(context,{actorUserId:actor,tenantId:client.tenantId,environment});
    expect(ready.canActivate).toBe(true);
    const activated=await activateManagedLmcClient(context,{actorUserId:actor,tenantId:client.tenantId,idempotencyKey:"activate",requestId:randomUUID(),environment});
    expect(activated).toMatchObject({tenantId:client.tenantId,activated:true,repeated:false});
    expect(activated.captureToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await activateManagedLmcClient(context,{actorUserId:actor,tenantId:client.tenantId,idempotencyKey:"activate",requestId:randomUUID(),environment})).toEqual({tenantId:client.tenantId,activated:true,repeated:true});
    expect((await db.admin.db.select({status:businesses.status,stage:businesses.onboardingStage}).from(businesses).where(eq(businesses.id,client.tenantId)))[0]).toEqual({status:"active",stage:"managed_active"});
    expect(await db.admin.db.select().from(services).where(eq(services.businessId,client.tenantId))).toHaveLength(1);
    expect(await db.admin.db.select().from(businessHours).where(eq(businessHours.businessId,client.tenantId))).toHaveLength(1);
    expect((await db.admin.db.select({enabled:lmcSettings.enabled}).from(lmcSettings).where(eq(lmcSettings.tenantId,client.tenantId)))[0]?.enabled).toBe(true);
    expect(await resolveLmcPilotPageAccess({database:db.app.db,authDatabase:db.admin.db},ownerId)).toMatchObject({tenantId:client.tenantId});
    await pauseManagedLmcClient(context,{actorUserId:actor,tenantId:client.tenantId,idempotencyKey:`pause-${client.tenantId}`,requestId:randomUUID()});
    expect((await db.admin.db.select({status:businesses.status}).from(businesses).where(eq(businesses.id,client.tenantId)))[0]?.status).toBe("paused");
    expect((await db.admin.db.select({enabled:lmcSettings.enabled}).from(lmcSettings).where(eq(lmcSettings.tenantId,client.tenantId)))[0]?.enabled).toBe(false);
    expect(await db.admin.db.select().from(services).where(eq(services.businessId,client.tenantId))).toHaveLength(1);
  }finally{
    await db.admin.db.delete(platformAdminOperations).where(eq(platformAdminOperations.actorUserId,actor));
    await db.admin.db.delete(platformAdminAuditEvents).where(eq(platformAdminAuditEvents.actorUserId,actor));
    for(const id of created)await db.admin.db.delete(businesses).where(eq(businesses.id,id));
    await ownerFixture.close();await adminFixture.close();await db.close();
  }
},30000);
