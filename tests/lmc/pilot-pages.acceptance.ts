import { expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { businesses, lmcSettings, users } from "@lobbystack/db";
import { withHttpAudit } from "./support/isolation-http";

it("serves configured pilot pages without voice onboarding or closed links, and denies every unsupported page method",async()=>{
  let expectedPageProbes: string[] = [];
  const result=await withHttpAudit(process.env.LMC_TEST_HTTP_BASE_URL??"http://localhost:3000",async context=>{
    const {db,a,b,base,cookieA,cookieB,check,probed}=context;
    for(const fixture of [a,b]){
      await db.admin.db.update(users).set({activeBusinessId:fixture.tenantId}).where(eq(users.id,fixture.ownerId));
      await db.admin.db.update(businesses).set({onboardingStage:"website"}).where(eq(businesses.id,fixture.tenantId));
    }
    const methods=["GET","HEAD","POST","PUT","PATCH","DELETE","OPTIONS"];
    const identities=[{label:"anonymous",cookie:"",own:null},{label:"a",cookie:cookieA,own:a},{label:"b",cookie:cookieB,own:b},{label:"forged",cookie:"",own:null}];
    const pages=["/","/leads","/contacts",`/contacts/${a.tenantId}`,"/agent/knowledge","/agent/services","/settings/business","/settings/email","/integrations"];
    expectedPageProbes=pages.flatMap(path=>methods.map(method=>`${method} ${path}`));
    for(const path of pages)for(const method of methods){
      for(const identity of identities){
        const response=await fetch(new URL(path,base),{method,redirect:"manual",signal:AbortSignal.timeout(15000),headers:{...(identity.cookie?{cookie:identity.cookie}:{}),"x-user-id":b.ownerId,"x-business-id":b.tenantId,"x-tenant-id":b.tenantId,"x-actor-type":"system"}});
        const body=await response.text(),location=response.headers.get("location");
        if(!["GET","HEAD"].includes(method)){
          check(response.status===405&&response.headers.get("allow")==="GET, HEAD"&&body==="",`PILOT_PAGE_METHOD:${path}:${method}:${identity.label}:${response.status}`);
        }else if(path==="/"){
          check(response.status===307&&!!location&&new URL(location,base).pathname==="/leads",`PILOT_ROOT_REDIRECT:${identity.label}:${method}:${response.status}`);
        }else if(!identity.own){
          check(response.status===307&&!!location&&new URL(location,base).pathname==="/en/login",`PILOT_PAGE_SESSION:${path}:${identity.label}:${method}:${response.status}`);
        }else{
          check(response.status===200&&!location,`PILOT_PAGE_CONFIGURED_ACCESS:${path}:${identity.label}:${method}:${response.status}`);
          if(method==="GET"&&response.status===200){
            const links=[...body.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map(match=>match[1]!);
            const allowedLinks=["#dashboard-main-content","/leads","/contacts","/agent/knowledge","/agent/services","/settings/business","/settings/email","/integrations"];
            check(links.includes("/leads")&&links.includes("/settings/email")&&links.includes("/agent/knowledge")&&links.includes("/integrations")&&links.every(link=>allowedLinks.includes(link)),`PILOT_PAGE_CLOSED_LINK:${path}:${identity.label}`);
            const foreign=identity.own===a?b:a;
            check(body.includes(`${identity.own.ownerId}@example.invalid`)&&!body.includes(`${foreign.ownerId}@example.invalid`),`PILOT_PAGE_CANONICAL_IDENTITY:${path}:${identity.label}`);
          }
        }
        if(method==="HEAD")check(body==="",`PILOT_PAGE_HEAD_BODY:${path}:${identity.label}`);
      }
      probed.push(`${method} ${path}`);
    }
    // Verified fresh accounts get an explicit, guarded setup state, not a false 404.
    await db.admin.db.update(users).set({activeBusinessId:null}).where(eq(users.id,a.ownerId));
    let unconfigured=await fetch(new URL("/leads",base),{headers:{cookie:cookieA},redirect:"manual"});
    check(unconfigured.status===307&&new URL(unconfigured.headers.get("location")??"/",base).pathname==="/setup-required","PILOT_NEW_ACCOUNT_SETUP_REDIRECT");
    await unconfigured.arrayBuffer();
    unconfigured=await fetch(new URL("/setup-required",base),{headers:{cookie:cookieA},redirect:"manual"});
    const setupBody=await unconfigured.text();
    check(unconfigured.status===200&&setupBody.includes("Workspace setup required"),"PILOT_NEW_ACCOUNT_SETUP_PAGE");
    check(!setupBody.includes(b.ownerId),"PILOT_NEW_ACCOUNT_ISOLATION");
    unconfigured=await fetch(new URL("/setup-required",base),{redirect:"manual"});
    check(unconfigured.status===307&&new URL(unconfigured.headers.get("location")??"/",base).pathname==="/en/login","PILOT_SETUP_PAGE_REQUIRES_SESSION");
    await unconfigured.arrayBuffer();
    await db.admin.db.update(users).set({activeBusinessId:a.tenantId}).where(eq(users.id,a.ownerId));
    unconfigured=await fetch(new URL("/setup-required",base),{headers:{cookie:cookieA},redirect:"manual"});
    check(unconfigured.status===404,"PILOT_CONFIGURED_ACCOUNT_SETUP_PAGE_DENIED");
    await unconfigured.arrayBuffer();

    // The onboarding exception is confined to verified, configured, active members.
    await db.admin.db.update(users).set({emailVerified:false}).where(eq(users.id,a.ownerId));
    let denied=await fetch(new URL("/leads",base),{headers:{cookie:cookieA},redirect:"manual"});
    check(denied.status===404,"PILOT_PAGE_UNVERIFIED_IDENTITY");await denied.arrayBuffer();
    await db.admin.db.update(users).set({emailVerified:true,activeBusinessId:b.tenantId}).where(eq(users.id,a.ownerId));
    denied=await fetch(new URL("/leads",base),{headers:{cookie:cookieA},redirect:"manual"});
    check(denied.status===404,"PILOT_PAGE_FOREIGN_ACTIVE_WORKSPACE");await denied.arrayBuffer();
    await db.admin.db.update(users).set({activeBusinessId:a.tenantId}).where(eq(users.id,a.ownerId));
    const [settings]=await db.admin.db.select().from(lmcSettings).where(eq(lmcSettings.tenantId,a.tenantId));
    await db.admin.pool.query("update lmc_settings set config=$1::jsonb where tenant_id=$2",["{}",a.tenantId]);
    denied=await fetch(new URL("/settings/email",base),{headers:{cookie:cookieA},redirect:"manual"});
    check(denied.status===404,"PILOT_PAGE_UNCONFIGURED_WORKSPACE");await denied.arrayBuffer();
    await db.admin.db.update(lmcSettings).set({config:settings!.config}).where(eq(lmcSettings.tenantId,a.tenantId));
    const positive=await fetch(new URL("/leads",base),{headers:{cookie:cookieB},redirect:"manual"});
    check(positive.status===200,"PILOT_PAGE_INDEPENDENT_CONFIGURED_WORKSPACE");await positive.arrayBuffer();
    for(const fixture of [a,b]){
      const [business]=await db.admin.db.select({stage:businesses.onboardingStage}).from(businesses).where(eq(businesses.id,fixture.tenantId));
      check(business?.stage==="website","PILOT_PAGES_MUTATED_LEGACY_ONBOARDING");
    }
  });
  expect(result.failures).toEqual([]);
  expect([...result.probed].sort()).toEqual(expectedPageProbes.sort());
},120000);
