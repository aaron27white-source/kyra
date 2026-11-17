import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync, fsyncSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { ZodError } from "zod";
import { lmcTenantSeedSchema } from "@lobbystack/contracts";
import { assertDatabaseRole, createDatabaseClient } from "@lobbystack/db";
import { getLmcEnvironment } from "@lobbystack/providers";
import { configureLmcTenant } from "../packages/domain/src/server/lmc/configure-tenant";
import { loadLocalEnv } from "./load-local-env.mjs";

async function main() {
  let configuration: string | undefined, output: string | undefined, check = false;
  const args = process.argv.slice(2).filter(arg => arg !== "--");
  for (let index=0;index<args.length;index++) {
    const arg=args[index];
    if(arg==="--help") { console.log("pnpm lmc:tenant --config tenant.json --check | --capabilities-file /absolute/new/private.json"); return; }
    if(arg==="--check"&&!check)check=true;
    else if(arg==="--config"&&!configuration)configuration=args[++index];
    else if(arg==="--capabilities-file"&&!output)output=args[++index];
    else throw new Error("INVALID_ARGUMENTS");
  }
  if(!configuration||(!check&&!output)||(check&&output))throw new Error("INVALID_ARGUMENTS");
  const input=openSync(resolve(configuration),constants.O_RDONLY|constants.O_NOFOLLOW);
  let raw:unknown;
  try { const info=fstatSync(input);if(!info.isFile()||info.size>524288)throw new Error("INVALID_CONFIGURATION_FILE");raw=JSON.parse(readFileSync(input,"utf8")); } finally {closeSync(input);}
  const seed=lmcTenantSeedSchema.parse(raw);
  if(check){console.log(JSON.stringify({status:"valid",tenantId:seed.tenantId,services:seed.settings.services.length,configuredDays:seed.hours.length}));return;}
  if(!output||!isAbsolute(output)||process.platform==="win32")throw new Error("PRIVATE_OUTPUT_REQUIRES_ABSOLUTE_WSL_LINUX_PATH");
  if(process.env.LOBBYSTACK_SKIP_ENV_FILES!=="true")loadLocalEnv([".env",".env.local"]);
  const environment=getLmcEnvironment();
  let fd:number;
  try {fd=openSync(output,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);}catch(error){if((error as NodeJS.ErrnoException).code==="EEXIST")throw new Error("CAPABILITIES_FILE_EXISTS");throw new Error("CAPABILITIES_FILE_UNAVAILABLE");}
  const reserved=fstatSync(fd);
  let committed=false;
  let app: ReturnType<typeof createDatabaseClient> | undefined;
  let auth: ReturnType<typeof createDatabaseClient> | undefined;
  try {
    app=createDatabaseClient("lobbystack_app");
    auth=createDatabaseClient("lobbystack_auth");
    if((reserved.mode&0o077)!==0)throw new Error("PRIVATE_OUTPUT_REQUIRED");
    // Always verify actual logins, including test/development. Never fall back
    // to a privileged migrator connection for configuration or auth reads.
    await assertDatabaseRole(app,{NODE_ENV:"production"});
    await assertDatabaseRole(auth,{NODE_ENV:"production"});
    const result=await configureLmcTenant({database:app.db,authDatabase:auth.db,senderEmail:environment.senderEmail,now:()=>new Date()},seed);
    committed=true;
    const credentials={tenantId:result.tenantId,...(result.captureToken?{captureToken:result.captureToken,captureUrl:`${environment.baseUrl}/api/lmc/capture/${result.captureToken}`,directEmail:`lead+${result.captureToken}@${environment.receivingDomain}`,forwardEmail:`forward+${result.captureToken}@${environment.receivingDomain}`}:{note:"Existing capture token preserved; it is not retrievable. Keep the prior private file or rotate through operator settings."})};
    try {writeFileSync(fd,JSON.stringify(credentials,null,2)+"\n");fsyncSync(fd);}catch{throw new Error("TENANT_CONFIGURED_OUTPUT_FAILED");}
    console.log(JSON.stringify({status:"configured",tenantId:result.tenantId,changed:result.changed,services:result.services.length,calendarSyncRequired:result.calendarSyncRequired,capabilitiesWritten:true}));
  } finally {
    closeSync(fd);
    await Promise.allSettled([app?.pool.end(),auth?.pool.end()]);
    if(!committed){try{const current=lstatSync(output);if(current.ino===reserved.ino&&current.dev===reserved.dev)unlinkSync(output);}catch{}}
  }
}

void main().catch(error=>{
  const message=error instanceof ZodError?`INVALID_TENANT_CONFIGURATION:${error.issues.map(issue=>issue.path.join(".")+":"+issue.code).slice(0,8).join(",")}`:error instanceof Error&&/^[A-Z][A-Z0-9_]{2,80}$/.test(error.message)?error.message:"TENANT_CONFIGURATION_FAILED";
  console.error(message);process.exitCode=1;
});
