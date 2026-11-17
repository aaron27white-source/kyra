import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { listEmailVisitSlots } from "../../packages/domain/src/server/lmc/scheduling";
import { findEmailAvailabilityInTransaction } from "../../packages/domain/src/server/booking";
import { expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabaseClient, assertDatabaseRole, users, services, businessHours, calendarConnections, lmcSettings, lmcEvents, outboxMessages } from "@lobbystack/db";
import { lmcBusinessSettingsSchema } from "@lobbystack/contracts";
import { openLmcTestDatabase } from "./support/database";
import { createLmcHarness } from "./support/harness";
import { configureLmcTenant } from "../../packages/domain/src/server/lmc/configure-tenant";

async function input(h: Awaited<ReturnType<typeof createLmcHarness>>) {
  const loaded = await h.scoped(async tx => ({ settings: (await tx.select().from(lmcSettings))[0]!, connection: (await tx.select().from(calendarConnections))[0]! }));
  const config = lmcBusinessSettingsSchema.parse(loaded.settings.config);
  return { version: 1 as const, tenantId: h.tenantId, userId: h.ownerId, timezone: "America/New_York", enabled: true, hours: [{ dayOfWeek: 3, openMinutes: 540, closeMinutes: 1020 }], calendar: { connectionId: loaded.connection.id, staffId: loaded.connection.staffId!, calendarId: loaded.connection.selectedCalendarId! }, settings: { ...config, services: [{ slug: "roof-repair", name: "roof repair", aliases: ["leak repair"], durationMinutes: 45 }], faqs: [{ question: "Do you provide written estimates?", answer: "An estimate follows an on-site inspection." }], escalation: { keywords: ["insurance dispute"], replyText: "Our owner will review your insurance question personally." }, bookingRules: { minimumNoticeMinutes: 120, horizonDays: 3, requireVerifiedRequester: true as const } } };
}

it("configures canonical catalog/hours and email rules idempotently without faking calendar freshness", async () => {
  const h = await createLmcHarness({ now: "2030-01-09T03:40:00Z" }), db = openLmcTestDatabase(), auth = createDatabaseClient("lobbystack_auth");
  try {
    await assertDatabaseRole(auth,{NODE_ENV:"production"});
    await db.admin.db.update(users).set({ emailVerified: true }).where(eq(users.id,h.ownerId));
    const seed = await input(h);
    const first = await configureLmcTenant({ database: h.appDatabase, authDatabase: auth.db, senderEmail: "team@example.invalid", now: h.now },seed);
    expect(first.changed).toBe(true);
    const second = await configureLmcTenant({ database: h.appDatabase, authDatabase: auth.db, senderEmail: "team@example.invalid", now: h.now },seed);
    expect(second.changed).toBe(false);
    expect(second.captureToken).toBeUndefined();
    await h.scoped(async tx => {
      expect((await tx.select().from(services)).map(service=>({name:service.name,duration:service.durationMinutes}))).toEqual([{name:"roof repair",duration:45}]);
      expect((await tx.select().from(businessHours)).map(day=>({dayOfWeek:day.dayOfWeek,openMinutes:day.openMinutes,closeMinutes:day.closeMinutes}))).toEqual(seed.hours);
      const saved = lmcBusinessSettingsSchema.parse((await tx.select().from(lmcSettings))[0]!.config);
      const events=await tx.select().from(lmcEvents).where(eq(lmcEvents.type,"tenant_configured"));
      expect(events).toHaveLength(1);
      expect(events[0]!.metadata).toEqual({userId:h.ownerId,services:1,configuredDays:1,calendarChanged:false});
      expect(saved.faqs).toEqual(seed.settings.faqs);expect(saved.escalation).toEqual(seed.settings.escalation);expect(saved.bookingRules).toEqual(seed.settings.bookingRules);
      expect((await tx.select().from(calendarConnections))[0]!.lastSyncedAt).toEqual(h.now());
    });
    const changed = {...seed,calendar:{...seed.calendar,calendarId:"new-primary"}};
    await configureLmcTenant({ database:h.appDatabase,authDatabase:auth.db,senderEmail:"team@example.invalid",now:h.now },changed);
    await h.scoped(async tx=>{
      const calendar=(await tx.select().from(calendarConnections))[0]!;
      expect(calendar.selectedCalendarId).toBe("new-primary");expect(calendar.lastSyncedAt).toBeNull();expect(calendar.status).toBe("syncing");
      expect((await tx.select().from(outboxMessages).where(eq(outboxMessages.businessId,h.tenantId))).some(job=>job.topic==="calendar.reconcileBusiness")).toBe(true);
    });
  } finally { await h.close();await db.close();await auth.pool.end(); }
});

it("rejects foreign references and viewers before changing any configured state", async()=>{
  const a=await createLmcHarness({now:"2030-01-09T03:40:00Z"}),b=await createLmcHarness({now:"2030-01-09T03:40:00Z"}),db=openLmcTestDatabase(),auth=createDatabaseClient("lobbystack_auth");
  try {
    await assertDatabaseRole(auth,{NODE_ENV:"production"});
    await db.admin.db.update(users).set({emailVerified:true}).where(eq(users.id,a.ownerId));
    const seed=await input(a),foreign=await input(b),viewer=await a.addViewer();
    await db.admin.db.update(users).set({emailVerified:true}).where(eq(users.id,viewer));
    const before=await a.scoped(async tx=>({services:await tx.select().from(services),hours:await tx.select().from(businessHours),settings:await tx.select().from(lmcSettings)}));
    await db.admin.db.update(users).set({emailVerified:false}).where(eq(users.id,a.ownerId));
    await expect(configureLmcTenant({database:a.appDatabase,authDatabase:auth.db,senderEmail:"team@example.invalid",now:a.now},seed)).rejects.toThrow("TENANT_OPERATOR_NOT_VERIFIED");
    await db.admin.db.update(users).set({emailVerified:true}).where(eq(users.id,a.ownerId));
    await expect(configureLmcTenant({database:a.appDatabase,authDatabase:auth.db,senderEmail:"team@example.invalid",now:a.now},{...seed,calendar:foreign.calendar})).rejects.toThrow("CALENDAR_NOT_AVAILABLE");
    await expect(configureLmcTenant({database:a.appDatabase,authDatabase:auth.db,senderEmail:"team@example.invalid",now:a.now},{...seed,userId:viewer})).rejects.toThrow();
    const after=await a.scoped(async tx=>({services:await tx.select().from(services),hours:await tx.select().from(businessHours),settings:await tx.select().from(lmcSettings)}));
    expect(after).toEqual(before);
  } finally { await b.close();await a.close();await db.close();await auth.pool.end(); }
});

it("uses configured FAQs in trusted model context and escalates configured keywords before calling the model", async()=>{
  const h=await createLmcHarness({now:"2030-01-09T03:40:00Z"}),db=openLmcTestDatabase(),auth=createDatabaseClient("lobbystack_auth");
  try {
    await assertDatabaseRole(auth,{NODE_ENV:"production"});await db.admin.db.update(users).set({emailVerified:true}).where(eq(users.id,h.ownerId));
    const seed=await input(h);
    await configureLmcTenant({database:h.appDatabase,authDatabase:auth.db,senderEmail:"team@example.invalid",now:h.now},seed);
    await h.capture({email:"faq@example.invalid",message:"Roof repair in ZIP 33101 for my residential home."});await h.work();
    expect(h.model.calls.at(-1)?.business.faqs).toEqual(seed.settings.faqs);
    const count=h.model.calls.length;
    const lead=await h.capture({email:"escalation@example.invalid",message:"I have an insurance dispute about this roof."});await h.work();
    expect(h.model.calls).toHaveLength(count);
    expect(await h.lead(lead.id)).toMatchObject({status:"human_handoff",reason:"configured_escalation",aiPaused:true});
    expect(h.mail.lastTo("escalation@example.invalid").text).toContain(seed.settings.escalation.replyText);
    expect(h.mail.to(seed.settings.ownerEmail).some(mail=>mail.text.includes("configured_escalation"))).toBe(true);
  } finally {await h.close();await db.close();await auth.pool.end();}
});

it("enforces configured notice and horizon again during booking checks, not only when offering slots",async()=>{
  const h=await createLmcHarness({now:"2030-01-09T03:40:00Z"}),db=openLmcTestDatabase(),auth=createDatabaseClient("lobbystack_auth");
  try {
    await assertDatabaseRole(auth,{NODE_ENV:"production"});await db.admin.db.update(users).set({emailVerified:true}).where(eq(users.id,h.ownerId));
    const base=await input(h),seed={...base,hours:Array.from({length:7},(_,dayOfWeek)=>({dayOfWeek,openMinutes:540,closeMinutes:1020})),settings:{...base.settings,bookingRules:{minimumNoticeMinutes:0,horizonDays:7,requireVerifiedRequester:true as const}}};
    const first=await configureLmcTenant({database:h.appDatabase,authDatabase:auth.db,senderEmail:"team@example.invalid",now:h.now},seed),serviceId=first.services[0]!.id;
    const check=(startsAt:string)=>h.scoped(tx=>findEmailAvailabilityInTransaction(tx,{businessId:h.tenantId,serviceId,startsAt,now:h.now()}));
    expect((await check("2030-01-09T14:00:00Z")).length).toBeGreaterThan(0);
    expect((await check("2030-01-10T14:00:00Z")).length).toBeGreaterThan(0);
    await configureLmcTenant({database:h.appDatabase,authDatabase:auth.db,senderEmail:"team@example.invalid",now:h.now},{...seed,settings:{...seed.settings,bookingRules:{minimumNoticeMinutes:1440,horizonDays:2,requireVerifiedRequester:true}}});
    expect(await check("2030-01-09T14:00:00Z")).toEqual([]);
    expect(await check("2030-01-10T14:00:00Z")).toEqual([]);
    expect(await listEmailVisitSlots(h.workerDatabase,{tenantId:h.tenantId,serviceId,now:h.now()})).toEqual([]);
  } finally {await h.close();await db.close();await auth.pool.end();}
});

it("runs the operator CLI, keeps new capture credentials in a private file and refuses overwrite before mutation",async()=>{
  const h=await createLmcHarness({now:"2030-01-09T03:40:00Z"}),db=openLmcTestDatabase();
  const directory=mkdtempSync(join(tmpdir(),"lmc-tenant-cli-")),configPath=join(directory,"tenant.json"),capabilities=join(directory,"capabilities.json");
  try {
    await db.admin.db.update(users).set({emailVerified:true}).where(eq(users.id,h.ownerId));
    const seed=await input(h);writeFileSync(configPath,JSON.stringify(seed));
    await db.admin.db.delete(lmcSettings).where(eq(lmcSettings.tenantId,h.tenantId));
    const env={...process.env,NODE_ENV:"test",LMC_PROVIDER_MODE:"fake",LMC_EMAIL_FROM:"team@example.invalid",LMC_PUBLIC_BASE_URL:"http://localhost:3000",LMC_RECEIVING_DOMAIN:"inbound.example.invalid"};
    for(const key of ["VITEST","VITEST_POOL_ID","VITEST_WORKER_ID"])delete env[key as keyof typeof env];
    const run=()=>promisify(execFile)("pnpm",["--silent","lmc:tenant","--config",configPath,"--capabilities-file",capabilities],{cwd:fileURLToPath(new URL("../../",import.meta.url)),env,timeout:30000,maxBuffer:1024*1024});
    const {stdout}=await run(),report=JSON.parse(stdout),privateReport=JSON.parse(readFileSync(capabilities,"utf8"));
    expect(report).toMatchObject({status:"configured",tenantId:h.tenantId,changed:true});
    expect(privateReport.captureUrl).toContain("/api/lmc/capture/");
    expect(stdout).not.toContain(privateReport.captureToken);expect(stdout).not.toMatch(/postgres(?:ql)?:\/\//);
    expect(statSync(capabilities).mode&0o777).toBe(0o600);
    const before=await h.scoped(tx=>tx.select().from(lmcSettings));
    await expect(run()).rejects.toMatchObject({stderr:expect.stringContaining("CAPABILITIES_FILE_EXISTS")});
    expect(await h.scoped(tx=>tx.select().from(lmcSettings))).toEqual(before);
  } finally {
    await h.close();await db.close();
    if(dirname(resolve(directory))!==resolve(tmpdir())||!basename(directory).startsWith("lmc-tenant-cli-"))throw new Error("UNSAFE_CLI_TEST_CLEANUP");
    rmSync(directory,{recursive:true,force:true});
  }
},40000);
