import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { readdir, readFile, mkdir, open, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import { PILOT_ADMIN_ROUTES, pilotAdminRoute } from "../../packages/shared/dist/pilot.js";

const root=fileURLToPath(new URL("../../",import.meta.url));
const admin=join(root,"apps/admin");
const methods=["GET","HEAD","POST","PUT","PATCH","DELETE","OPTIONS"];
const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
async function files(directory,prefix="") {
  const result=[];
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    const name=prefix+entry.name;
    if(entry.isDirectory())result.push(...await files(join(directory,entry.name),name+"/"));
    else if(entry.isFile())result.push(name);
    else throw new Error("UNSUPPORTED_STATIC_ENTRY");
  }
  return result.sort();
}

test("production-default pilot auth displays and every published static asset enforce all seven methods",{timeout:180000},async()=>{
  const port=3101,base=`http://127.0.0.1:${port}`;
  const env={...process.env,NODE_ENV:"production",LMC_PROVIDER_MODE:"real",LOBBYSTACK_SKIP_ENV_FILES:"true",OTEL_SDK_DISABLED:"true",APP_BASE_URL:base,AUTH_TRUSTED_ORIGINS:base};
  delete env.LMC_PILOT_MODE;
  delete env.LMC_FAKE_INBOUND_FIXTURE_FILE;
  for(const name of ["BETTER_AUTH_SECRET","INTERNAL_SERVICE_SECRET","INTERNAL_SERVICE_TOKEN","WIDGET_SESSION_SECRET","ENCRYPTION_KEY","OTP_HASH_SECRET","LOCAL_STORAGE_SIGNING_SECRET"])env[name]=randomBytes(32).toString("hex");
  const reportDir=join(root,".tmp/security");await mkdir(reportDir,{recursive:true});
  const log=await open(join(reportDir,"pilot-public-assets-server.log"),"w",0o600);
  const child=spawn(process.execPath,[join(admin,"node_modules/next/dist/bin/next"),"start","--hostname","127.0.0.1","--port",String(port)],{cwd:admin,env,stdio:["ignore",log.fd,log.fd]});
  await log.close();
  const failures=[],covered=new Set();let probes=0,positiveBytes=0;
  function check(value,code){if(!value)failures.push(code);}
  async function request(path,method){probes++;return fetch(base+path,{method,redirect:"manual",signal:AbortSignal.timeout(15000),headers:{origin:base,"accept-encoding":"identity"}});}
  try{
    let ready=false;
    for(let attempt=0;attempt<60;attempt++){
      if(child.exitCode!==null)throw new Error("PRODUCTION_SERVER_EXITED: inspect private local log");
      try{const response=await fetch(base+"/healthz",{signal:AbortSignal.timeout(1000)});ready=response.status===200;await response.arrayBuffer();}catch{}
      if(ready)break;
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    assert(ready,"PRODUCTION_SERVER_NOT_READY");
    const pages=["login","signup","forgot-password","reset-password","verify-email","confirm-email-change"];
    const paths=["","/en","/fr"].flatMap(prefix=>[...pages.map(page=>prefix+"/"+page),prefix+"/reset-password/synthetic-display-only"]);
    const staticFiles=[
      {path:"/favicon.ico",file:join(admin,"public/brand/lmc-logo.svg")},
      ...["lmc-logo","logo-icon","logo-wordmark"].map(name=>({path:`/brand/${name}.svg`,file:join(admin,`public/brand/${name}.svg`)})),
      ...["en","fr"].flatMap(locale=>["common","auth","onboarding","lmc","nav","settings","agent","contacts","knowledge","widget"].map(ns=>({path:`/locales/${locale}/${ns}.json`,file:join(admin,`public/locales/${locale}/${ns}.json`)}))),
      ...(await files(join(admin,".next/static"))).map(name=>({path:"/_next/static/"+name,file:join(admin,".next/static",name)})),
    ];
    assert(staticFiles.length>20,"NEXT_BUILD_ASSETS_MISSING");
    for(const path of paths)for(const method of methods){
      const response=await request(path,method),body=await response.text();
      const route=pilotAdminRoute(path);check(!!route,`AUTH_DISPLAY_NOT_ALLOWLISTED:${path}`);if(route)covered.add(route.pattern);
      if(!["GET","HEAD"].includes(method))check(response.status===405&&response.headers.get("allow")==="GET, HEAD"&&body==="",`AUTH_METHOD:${method}:${path}:${response.status}`);
      else if(!/^\/(en|fr)\//.test(path)){
        const location=response.headers.get("location");
        check(response.status===308&&!!location&&new URL(location,base).pathname==="/en"+path,`AUTH_CANONICAL:${method}:${path}:${response.status}`);
      }else{
        check(response.status===200&&!response.headers.has("location"),`AUTH_DISPLAY:${method}:${path}:${response.status}`);
        if(method==="GET"){
          check(response.headers.get("content-type")?.includes("text/html")&&body.includes('<html lang="'+path.split("/")[1]+'"'),`AUTH_DOCUMENT:${path}`);
          check(/<link[^>]*rel="icon"[^>]*href="\/brand\/lmc-logo.svg"/.test(body),`AUTH_ICON:${path}`);
        }
      }
      if(method==="HEAD")check(body==="",`AUTH_HEAD_BODY:${path}`);
    }
    for(const asset of staticFiles){
      const expected=await readFile(asset.file),route=pilotAdminRoute(asset.path);
      check(!!route,`STATIC_NOT_ALLOWLISTED:${asset.path}`);if(route)covered.add(route.pattern);
      for(const method of methods){
        const response=await request(asset.path,method),body=Buffer.from(await response.arrayBuffer());
        if(!["GET","HEAD"].includes(method))check(response.status===405&&response.headers.get("allow")==="GET, HEAD"&&body.length===0,`STATIC_METHOD:${method}:${asset.path}:${response.status}`);
        else{
          check(response.status===200&&!response.headers.has("location"),`STATIC_POSITIVE:${method}:${asset.path}:${response.status}`);
          if(method==="GET"){
            check(digest(body)===digest(expected),`STATIC_BYTES:${asset.path}`);
            if(asset.path==="/favicon.ico")check(response.headers.get("content-type")?.includes("image/svg+xml"),"FAVICON_SVG_CONTENT_TYPE");
            positiveBytes++;
          }
          else check(body.length===0,`STATIC_HEAD_BODY:${asset.path}`);
        }
      }
    }
    // Missing/retired assets are denials, never counted as positive controls.
    for(const path of ["/embed.js","/lmc-form.js","/locales/en/billing.json","/brand/unknown.svg"])
      for(const method of methods){const response=await request(path,method);await response.arrayBuffer();check(response.status===404,`CLOSED_ASSET:${method}:${path}:${response.status}`);}
    // Inventory the actual production build; every inherited non-pilot route
    // must fail closed before a handler can run, for every supported method.
    const manifest=JSON.parse(await readFile(join(admin,".next/app-path-routes-manifest.json"),"utf8"));
    const deniedPaths=[...new Set(Object.values(manifest).flatMap(path=>
      path.includes("[locale]")?["en","fr"].map(locale=>path.replace("[locale]",locale)):[path]
    ).map(path=>path.replace(/\[\[?\.\.\.[^\]]+\]\]?/g,"synthetic/path").replace(/\[[^\]]+\]/g,"00000000-0000-4000-8000-000000000001"))
      .filter(path=>!pilotAdminRoute(path)))].sort();
    assert(deniedPaths.length>100,"INHERITED_BUILD_ROUTE_INVENTORY_MISSING");
    for(const path of deniedPaths)for(const method of methods){
      const response=await request(path,method),body=await response.text();
      check(response.status===404&&body===""&&response.headers.get("cache-control")?.includes("no-store"),`INHERITED_DENIAL:${method}:${path}:${response.status}`);
    }
    const actionControls=[["/leads","POST"],["/api/lmc/settings","PUT"]];
    for(const [path,method] of actionControls){
      probes++;
      const response=await fetch(base+path,{method,redirect:"manual",signal:AbortSignal.timeout(15000),headers:{origin:base,"next-action":"synthetic-action-boundary"}});
      const body=await response.text();
      check(response.status===404&&body===""&&response.headers.get("cache-control")?.includes("no-store"),`SERVER_ACTION_DENIAL:${method}:${path}:${response.status}`);
    }
    const authenticatedPagePatterns=new Set([
      "/", "/leads", "/contacts", "/contacts/[contactId]", "/agent/knowledge", "/agent/services", "/setup-required", "/settings/email", "/settings/business",
      "/agent", "/agent/basic-settings", "/agent/rules", "/appointments", "/integrations", "/calls", "/calls/[callId]",
      "/internal", "/internal/clients", "/internal/clients/new", "/internal/clients/[tenantId]",
      "/internal/mfa", "/internal/mfa/setup",
      "/healthz", "/readyz",
    ]);
    const expectedPatterns=PILOT_ADMIN_ROUTES.filter(route=>!route.pattern.startsWith("/api/")&&!authenticatedPagePatterns.has(route.pattern)).map(route=>route.pattern).sort();
    check(JSON.stringify([...covered].sort())===JSON.stringify(expectedPatterns),"PUBLIC_PATTERN_COVERAGE");
    const report={environment:"local production Next build; real provider mode; no provider requests",pilotFlag:"unset; production default",deniedBuildPaths:deniedPaths.length,deniedMethodProbes:deniedPaths.length*methods.length,serverActionControls:actionControls.length,authDisplayPaths:paths.length,staticAssets:staticFiles.length,staticExactByteGet:positiveBytes,probes,methods,coveredPatterns:[...covered].sort(),failures,limitations:"Synthetic token display is SSR coverage only; real auth/token mutation is covered by the separate 238-pair PostgreSQL audit. No browser QA or hosted execution claimed."};
    await writeFile(join(reportDir,"pilot-public-assets.json"),JSON.stringify(report,null,2)+"\n");
    assert.equal(child.exitCode,null,"OWNED_PRODUCTION_SERVER_EXITED");
    assert.deepEqual(failures,[]);
    console.log(JSON.stringify({deniedBuildPaths:deniedPaths.length,deniedMethodProbes:deniedPaths.length*methods.length,serverActionControls:actionControls.length,authDisplayPaths:paths.length,staticAssets:staticFiles.length,probes,failures:0}));
  }finally{
    if(child.exitCode===null){const ended=once(child,"exit");child.kill("SIGTERM");await ended;}
  }
});
