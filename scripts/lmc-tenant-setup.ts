import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { ZodError } from "zod";
import { lmcTenantSetupSchema } from "@lobbystack/contracts";
import { assertDatabaseRole, createDatabaseClient } from "@lobbystack/db";
import { bootstrapLmcTenant, inspectLmcTenantSetup } from "../packages/domain/src/server/lmc/provision-tenant";
import { issueLmcCalendarAuthorization } from "./lmc/tenant-setup";
import { loadLocalEnv } from "./load-local-env.mjs";

async function main(){
  let config:string|undefined,output:string|undefined,check=false;
  const args=process.argv.slice(2).filter(arg=>arg!=="--");
  for(let index=0;index<args.length;index++){
    const arg=args[index];
    if(arg==="--help"){console.log("pnpm lmc:tenant-setup --config operation.json --check | --private-output /absolute/new/private.json");return;}
    if(arg==="--check"&&!check)check=true;
    else if(arg==="--config"&&!config)config=args[++index];
    else if(arg==="--private-output"&&!output)output=args[++index];
    else throw new Error("INVALID_ARGUMENTS");
  }
  if(!config||(!check&&!output)||(check&&output))throw new Error("INVALID_ARGUMENTS");
  const input=openSync(resolve(config),constants.O_RDONLY|constants.O_NOFOLLOW);
  let raw:unknown;
  try{const info=fstatSync(input);if(!info.isFile()||info.size>524288)throw new Error("INVALID_CONFIGURATION_FILE");raw=JSON.parse(readFileSync(input,"utf8"));}finally{closeSync(input);}
  const seed=lmcTenantSetupSchema.parse(raw);
  if(check){console.log(JSON.stringify({status:"valid",operation:seed.operation}));return;}
  if(!output||!isAbsolute(output)||process.platform==="win32")throw new Error("PRIVATE_OUTPUT_REQUIRES_ABSOLUTE_WSL_LINUX_PATH");
  if(process.env.LOBBYSTACK_SKIP_ENV_FILES!=="true")loadLocalEnv([".env",".env.local"]);
  let fd:number;
  try{fd=openSync(output,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);}catch(error){if((error as NodeJS.ErrnoException).code==="EEXIST")throw new Error("PRIVATE_OUTPUT_EXISTS");throw new Error("PRIVATE_OUTPUT_UNAVAILABLE");}
  const reserved=fstatSync(fd);
  let performed=false;
  let app:ReturnType<typeof createDatabaseClient>|undefined,auth:ReturnType<typeof createDatabaseClient>|undefined;
  try{
    if((reserved.mode&0o077)!==0)throw new Error("PRIVATE_OUTPUT_REQUIRED");
    app=createDatabaseClient("lobbystack_app");auth=createDatabaseClient("lobbystack_auth");
    await assertDatabaseRole(app,{NODE_ENV:"production"});await assertDatabaseRole(auth,{NODE_ENV:"production"});
    const context={database:app.db,authDatabase:auth.db};
    const {operation,...input}=seed;
    const result=operation==="bootstrap"?await bootstrapLmcTenant(context,input):operation==="inspect"?await inspectLmcTenantSetup(context,input):await issueLmcCalendarAuthorization(context,input);
    performed=true;
    try{writeFileSync(fd,JSON.stringify(result,null,2)+"\n");fsyncSync(fd);}catch{throw new Error("TENANT_SETUP_PERFORMED_OUTPUT_FAILED");}
    console.log(JSON.stringify({status:"ready",operation,tenantId:result.tenantId,privateOutputWritten:true}));
  }finally{
    closeSync(fd);await Promise.allSettled([app?.pool.end(),auth?.pool.end()]);
    if(!performed){try{const current=lstatSync(output);if(current.ino===reserved.ino&&current.dev===reserved.dev)unlinkSync(output);}catch{}}
  }
}
void main().catch(error=>{
  const message=error instanceof ZodError?`INVALID_TENANT_SETUP:${error.issues.map(issue=>issue.path.join(".")+":"+issue.code).slice(0,8).join(",")}`:error instanceof Error&&/^[A-Z][A-Z0-9_]{2,80}$/.test(error.message)?error.message:"TENANT_SETUP_FAILED";
  console.error(message);process.exitCode=1;
});
