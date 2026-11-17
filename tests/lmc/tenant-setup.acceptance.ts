import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { assertDatabaseRole, businesses, businessMemberships, createDatabaseClient, outboxMessages, receptionistProfiles, staff, users, verifications, withBusinessTransaction } from "@lobbystack/db";
import { createLmcHarness } from "./support/harness";
import { openLmcTestDatabase } from "./support/database";
import { bootstrapLmcTenant, inspectLmcTenantSetup } from "../../packages/domain/src/server/lmc/provision-tenant";
import { issueLmcCalendarAuthorization } from "../../scripts/lmc/tenant-setup";
import { calendarOAuthStateDigest, verifyCalendarOAuthState } from "../../apps/admin/src/lib/google-calendar-oauth";

it("bootstraps canonical business, owner, staff, profile and initial job once for a verified operator", async()=>{
  const h=await createLmcHarness({now:"2030-01-09T03:40:00Z"}),db=openLmcTestDatabase(),auth=createDatabaseClient("lobbystack_auth");
  let created:string|undefined;
  try {
    await assertDatabaseRole(db.app,{NODE_ENV:"production"});await assertDatabaseRole(auth,{NODE_ENV:"production"});
    const seed={userId:h.ownerId,name:"Pilot service business",slug:`pilot-setup-${randomUUID()}`,timezone:"America/New_York",businessType:"service_company"};
    await expect(bootstrapLmcTenant({database:db.app.db,authDatabase:auth.db},seed)).rejects.toThrow("TENANT_OPERATOR_NOT_VERIFIED");
    expect(await db.admin.db.select().from(businesses).where(eq(businesses.slug,seed.slug))).toEqual([]);
    await db.admin.db.update(users).set({emailVerified:true}).where(eq(users.id,h.ownerId));
    const first=await bootstrapLmcTenant({database:db.app.db,authDatabase:auth.db},seed);created=first.tenantId;
    const second=await bootstrapLmcTenant({database:db.app.db,authDatabase:auth.db},seed);
    expect(first.created).toBe(true);expect(second).toEqual({...first,created:false});
    await withBusinessTransaction(db.app.db,{businessId:created,userId:h.ownerId,actorType:"operator"},async tx=>{
      expect(await tx.select().from(businessMemberships)).toMatchObject([{userId:h.ownerId,role:"business_owner"}]);
      expect(await tx.select().from(staff)).toHaveLength(1);
      expect(await tx.select().from(receptionistProfiles)).toHaveLength(1);
      expect((await tx.select().from(outboxMessages).where(eq(outboxMessages.topic,"snapshot.refresh")))).toHaveLength(1);
    });
    await expect(bootstrapLmcTenant({database:db.app.db,authDatabase:auth.db},{...seed,name:"Changed name"})).rejects.toThrow("TENANT_BOOTSTRAP_MISMATCH");
  } finally {
    if(created)await db.admin.db.transaction(async tx=>{await tx.execute(sql`delete from outbox_messages where business_id=${created}::uuid`);await tx.delete(businesses).where(eq(businesses.id,created!));});
    await h.close();await db.close();await auth.pool.end();
  }
});

it("inspects only an administrator's tenant and never returns encrypted calendar credentials",async()=>{
  const a=await createLmcHarness({now:"2030-01-09T03:40:00Z"}),b=await createLmcHarness({now:"2030-01-09T03:40:00Z"}),db=openLmcTestDatabase(),auth=createDatabaseClient("lobbystack_auth");
  try {
    const viewer=await a.addViewer();
    for(const id of [a.ownerId,viewer])await db.admin.db.update(users).set({emailVerified:true}).where(eq(users.id,id));
    const context={database:db.app.db,authDatabase:auth.db},seed={tenantId:a.tenantId,userId:a.ownerId};
    const result=await inspectLmcTenantSetup(context,seed);
    expect(result.staff).toHaveLength(1);expect(result.calendars).toHaveLength(1);
    expect(Object.keys(result.calendars[0]!).sort()).toEqual(["connectionId","provider","selectedCalendarId","staffId","status"].sort());
    await expect(inspectLmcTenantSetup(context,{...seed,tenantId:b.tenantId})).rejects.toThrow();
    await expect(inspectLmcTenantSetup(context,{...seed,userId:viewer})).rejects.toThrow();
  } finally {await b.close();await a.close();await db.close();await auth.pool.end();}
});

it("issues a compatible expiring OAuth state through the CLI, stores only its lookup digest and writes its URL privately",async()=>{
  const h=await createLmcHarness({now:"2030-01-09T03:40:00Z"}),db=openLmcTestDatabase();
  const directory=mkdtempSync(join(tmpdir(),"lmc-setup-cli-")),config=join(directory,"authorize.json"),output=join(directory,"oauth.json");
  const signing=randomBytes(32).toString("hex"),previous=process.env.BETTER_AUTH_SECRET;
  let identifier:string|undefined;
  try {
    process.env.BETTER_AUTH_SECRET=signing;
    await db.admin.db.update(users).set({emailVerified:true}).where(eq(users.id,h.ownerId));
    writeFileSync(config,JSON.stringify({operation:"calendar-authorize",tenantId:h.tenantId,userId:h.ownerId}));
    const env={...process.env,NODE_ENV:"test",LOBBYSTACK_SKIP_ENV_FILES:"true",GOOGLE_CLIENT_ID:"fixture-client",GOOGLE_CLIENT_SECRET:"fixture-client-secret",GOOGLE_REDIRECT_URI:"http://localhost:3000/api/calendar/google/callback"};
    for(const key of ["VITEST","VITEST_POOL_ID","VITEST_WORKER_ID"])delete env[key as keyof typeof env];
    const run=()=>promisify(execFile)("pnpm",["--silent","lmc:tenant-setup","--config",config,"--private-output",output],{cwd:fileURLToPath(new URL("../../",import.meta.url)),env,timeout:30000,maxBuffer:1024*1024});
    const {stdout}=await run(),privateResult=JSON.parse(readFileSync(output,"utf8")),url=new URL(privateResult.authorizationUrl),state=url.searchParams.get("state")!;
    expect(JSON.parse(stdout)).toMatchObject({status:"ready",operation:"calendar-authorize",tenantId:h.tenantId});
    expect(url.origin).toBe("https://accounts.google.com");expect(url.searchParams.get("redirect_uri")).toBe(env.GOOGLE_REDIRECT_URI);
    expect(verifyCalendarOAuthState(state)).toMatchObject({userId:h.ownerId,businessId:h.tenantId});
    identifier=`google-calendar:${calendarOAuthStateDigest(state)}`;
    const rows=await db.admin.db.select().from(verifications).where(eq(verifications.identifier,identifier));
    expect(rows).toHaveLength(1);expect(rows[0]!.value).toBe(`${h.ownerId}:${h.tenantId}`);
    expect(rows[0]!.expiresAt.getTime()-Date.now()).toBeGreaterThan(500000);
    expect(rows[0]!.expiresAt.getTime()-Date.now()).toBeLessThanOrEqual(600000);
    expect(JSON.stringify(rows)).not.toContain(state);expect(stdout).not.toContain(state);expect(stdout).not.toContain(signing);expect(statSync(output).mode&0o777).toBe(0o600);
    await expect(run()).rejects.toMatchObject({stderr:expect.stringContaining("PRIVATE_OUTPUT_EXISTS")});
    expect(await db.admin.db.select().from(verifications).where(eq(verifications.identifier,identifier))).toHaveLength(1);
  } finally {
    if(identifier)await db.admin.db.delete(verifications).where(eq(verifications.identifier,identifier));
    if(previous===undefined)delete process.env.BETTER_AUTH_SECRET;else process.env.BETTER_AUTH_SECRET=previous;
    await h.close();await db.close();
    if(dirname(resolve(directory))!==resolve(tmpdir())||!basename(directory).startsWith("lmc-setup-cli-"))throw new Error("UNSAFE_SETUP_TEST_CLEANUP");
    rmSync(directory,{recursive:true,force:true});
  }
},40000);

it("refuses unsafe or mismatched OAuth redirects before storing a capability",async()=>{
  const h=await createLmcHarness({now:"2030-01-09T03:40:00Z"}),db=openLmcTestDatabase(),auth=createDatabaseClient("lobbystack_auth");
  const keys=["NODE_ENV","APP_BASE_URL","GOOGLE_CLIENT_ID","GOOGLE_CLIENT_SECRET","GOOGLE_REDIRECT_URI","BETTER_AUTH_SECRET"] as const,previous=keys.map(key=>process.env[key]);
  try {
    await db.admin.db.update(users).set({emailVerified:true}).where(eq(users.id,h.ownerId));
    process.env.NODE_ENV="production";process.env.APP_BASE_URL="https://pilot.example.invalid";
    process.env.GOOGLE_CLIENT_ID="fixture-client";process.env.GOOGLE_CLIENT_SECRET="fixture-client-secret";
    const before=await db.admin.db.select().from(verifications).where(eq(verifications.value,`${h.ownerId}:${h.tenantId}`));
    for(const redirect of ["http://pilot.example.invalid/api/calendar/google/callback","https://pilot.example.invalid/other","https://foreign.example.invalid/api/calendar/google/callback","https://pilot.example.invalid/api/calendar/google/callback?extra=1"]){
      process.env.GOOGLE_REDIRECT_URI=redirect;
      await expect(issueLmcCalendarAuthorization({database:db.app.db,authDatabase:auth.db},{tenantId:h.tenantId,userId:h.ownerId})).rejects.toThrow(/INVALID_GOOGLE_REDIRECT_URI|GOOGLE_REDIRECT_ORIGIN_MISMATCH/);
    }
    process.env.GOOGLE_REDIRECT_URI="https://pilot.example.invalid/api/calendar/google/callback";
    process.env.BETTER_AUTH_SECRET="too-short";
    await expect(issueLmcCalendarAuthorization({database:db.app.db,authDatabase:auth.db},{tenantId:h.tenantId,userId:h.ownerId})).rejects.toThrow("GOOGLE_OAUTH_SIGNING_SECRET_REQUIRED");
    expect(await db.admin.db.select().from(verifications).where(eq(verifications.value,`${h.ownerId}:${h.tenantId}`))).toEqual(before);
  }finally{
    keys.forEach((key,index)=>{const value=previous[index];if(value===undefined)delete process.env[key];else process.env[key]=value;});
    await h.close();await db.close();await auth.pool.end();
  }
});

it("runs bootstrap and inspection through the CLI and removes its reserved output on a pre-write authorization failure",async()=>{
  const h=await createLmcHarness({now:"2030-01-09T03:40:00Z"}),db=openLmcTestDatabase();
  const directory=mkdtempSync(join(tmpdir(),"lmc-setup-cli-")),config=join(directory,"bootstrap.json"),output=join(directory,"business.json");
  const slug=`pilot-cli-${randomUUID()}`;
  try {
    writeFileSync(config,JSON.stringify({operation:"bootstrap",userId:h.ownerId,name:"CLI pilot",slug,timezone:"America/New_York",businessType:"service_company"}));
    const env={...process.env,NODE_ENV:"test",LOBBYSTACK_SKIP_ENV_FILES:"true"};
    for(const key of ["VITEST","VITEST_POOL_ID","VITEST_WORKER_ID"])delete env[key as keyof typeof env];
    const run=(destination:string)=>promisify(execFile)("pnpm",["--silent","lmc:tenant-setup","--config",config,"--private-output",destination],{cwd:fileURLToPath(new URL("../../",import.meta.url)),env,timeout:30000,maxBuffer:1024*1024});
    await expect(run(output)).rejects.toMatchObject({stderr:expect.stringContaining("TENANT_OPERATOR_NOT_VERIFIED")});
    expect(await db.admin.db.select().from(businesses).where(eq(businesses.slug,slug))).toEqual([]);
    await db.admin.db.update(users).set({emailVerified:true}).where(eq(users.id,h.ownerId));
    const {stdout}=await run(output),result=JSON.parse(readFileSync(output,"utf8"));
    expect(JSON.parse(stdout)).toMatchObject({status:"ready",operation:"bootstrap",tenantId:result.tenantId});
    expect(result.created).toBe(true);expect(result.staff).toHaveLength(1);expect(result.calendars).toEqual([]);
    writeFileSync(config,JSON.stringify({operation:"inspect",tenantId:result.tenantId,userId:h.ownerId}));
    const inspection=join(directory,"inspection.json");await run(inspection);
    expect(JSON.parse(readFileSync(inspection,"utf8"))).toEqual({tenantId:result.tenantId,staff:result.staff,calendars:[]});
  }finally{
    const [created]=await db.admin.db.select({id:businesses.id}).from(businesses).where(eq(businesses.slug,slug));
    if(created)await db.admin.db.transaction(async tx=>{await tx.execute(sql`delete from outbox_messages where business_id=${created.id}::uuid`);await tx.delete(businesses).where(eq(businesses.id,created.id));});
    await h.close();await db.close();
    if(dirname(resolve(directory))!==resolve(tmpdir())||!basename(directory).startsWith("lmc-setup-cli-"))throw new Error("UNSAFE_SETUP_TEST_CLEANUP");
    rmSync(directory,{recursive:true,force:true});
  }
},60000);
