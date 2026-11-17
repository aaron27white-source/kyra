import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { parse } from "yaml";

const root=new URL("../../",import.meta.url);
test("pilot production profile exposes only the admin and keeps storage/DB/cache private",async()=>{
  const compose=parse(await readFile(new URL("docker-compose.pilot.yml",root),"utf8"));
  assert.deepEqual(Object.keys(compose.services).sort(),["admin","migrator","postgres","redis","worker"]);
  for(const service of Object.values(compose.services))assert.deepEqual(service.profiles,["prod"]);
  for(const name of ["postgres","redis","worker","migrator"])assert.equal(compose.services[name].ports,undefined);
  assert.deepEqual(compose.services.admin.ports,["127.0.0.1:${ADMIN_PORT:-3000}:3000"]);
  for(const name of ["postgres","redis"])assert.match(compose.services[name].image,/@sha256:[a-f0-9]{64}$/);
  assert.deepEqual(compose.services.postgres.volumes,["postgres_data:/var/lib/postgresql/data"]);
  assert.match(compose.services.migrator.command.at(-1),/migrate && .*bootstrap/);
  for(const name of ["admin","worker"]){
    const env=compose.services[name].environment;
    assert.equal(env.NODE_ENV,"production");assert.equal(env.LMC_PILOT_MODE,"true");assert.equal(env.LMC_PROVIDER_MODE,"real");
    assert.equal(env.LMC_EMAIL_WORKER_ENABLED,"true");assert.equal(env.LIVE_PROTOTYPE_ENABLED,"false");
    assert.equal(env.STORAGE_PROVIDER,"local");assert.equal(env.SMTP_HOST,"smtp.resend.com");assert.equal(env.SMTP_SECURE,"true");
    for(const key of ["RESEND_API_KEY","RESEND_WEBHOOK_SECRET","GOOGLE_CLIENT_ID","GOOGLE_CLIENT_SECRET","GOOGLE_REDIRECT_URI","AI_CHAT_API_KEY","AI_CHAT_MODEL","LMC_SIGNING_SECRET"])assert.ok(key in env,key);
    assert.ok(!Object.keys(env).some(key=>/TWILIO|POLAR|FIRECRAWL|POSTHOG|FAKE_INBOUND/.test(key)));
  }
  assert.ok(!("LOBBYSTACK_AUTH_PASSWORD" in compose.services.worker.environment));
  assert.equal(compose.services.worker.depends_on.migrator.condition,"service_completed_successfully");
});

test("production environment rejects placeholders, insecure URLs, key reuse and mismatched callback origins without echoing values",async()=>{
  const {validatePilotProductionEnvironment}=await import(new URL("scripts/pilot-check-env.mjs",root));
  const env={NODE_ENV:"production",SERVICE_VERSION:"configured-commit",APP_BASE_URL:"https://app.contractor.test",LMC_PUBLIC_BASE_URL:"https://app.contractor.test",LMC_EMAIL_FROM:"team@contractor.test",LMC_RECEIVING_DOMAIN:"inbound.contractor.test",GOOGLE_REDIRECT_URI:"https://app.contractor.test/api/calendar/google/callback",GOOGLE_CLIENT_ID:"configured.apps.googleusercontent.com",GOOGLE_CLIENT_SECRET:randomBytes(24).toString("hex"),RESEND_API_KEY:"re_"+randomBytes(24).toString("hex"),RESEND_WEBHOOK_SECRET:"whsec_"+randomBytes(32).toString("base64"),AI_CHAT_API_KEY:randomBytes(24).toString("hex"),AI_CHAT_MODEL:"configured-model"};
  for(const name of ["POSTGRES_PASSWORD","LOBBYSTACK_MIGRATOR_PASSWORD","LOBBYSTACK_AUTH_PASSWORD","LOBBYSTACK_APP_PASSWORD","LOBBYSTACK_SYSTEM_PASSWORD","LOBBYSTACK_WORKER_PASSWORD","LOBBYSTACK_DISPATCHER_PASSWORD","LOBBYSTACK_READONLY_PASSWORD","BETTER_AUTH_SECRET","INTERNAL_SERVICE_SECRET","INTERNAL_SERVICE_TOKEN","WIDGET_SESSION_SECRET","ENCRYPTION_KEY","OTP_HASH_SECRET","LOCAL_STORAGE_SIGNING_SECRET","LMC_SIGNING_SECRET"])env[name]=randomBytes(32).toString("hex");
  assert.deepEqual(validatePilotProductionEnvironment(env),[]);
  for(const change of [{SERVICE_VERSION:"[FILL]"},{GOOGLE_CLIENT_SECRET:"x"},{GOOGLE_CLIENT_ID:"not-a-web-client"},{APP_BASE_URL:"http://app.contractor.test"},{LMC_PUBLIC_BASE_URL:"https://foreign.test"},{GOOGLE_REDIRECT_URI:"https://foreign.test/api/calendar/google/callback"},{RESEND_API_KEY:"[FILL]"},{AI_CHAT_API_KEY:""},{LOBBYSTACK_AUTH_PASSWORD:env.LOBBYSTACK_APP_PASSWORD},{LMC_SIGNING_SECRET:"a".repeat(64)},{LMC_RECEIVING_DOMAIN:"inbound.example.invalid"},{LMC_EMAIL_FROM:"team@example.invalid"}]){
    const result=validatePilotProductionEnvironment({...env,...change});assert.ok(result.length>0);
    for(const value of Object.values(change))if(value)assert.ok(!JSON.stringify(result).includes(value));
  }
});

test("backup and restore accept an explicit Compose file and the drill owns a fresh isolated project",async()=>{
  for(const name of ["replacement-backup.sh","replacement-restore.sh","replacement-restore-drill.sh"]){
    const text=await readFile(new URL("scripts/"+name,root),"utf8");assert.match(text,/REPLACEMENT_COMPOSE_FILE/);assert.match(text,/-f "\$COMPOSE_FILE"/);
  }
  const drill=await readFile(new URL("scripts/pilot-restore-rehearsal.sh",root),"utf8");
  assert.match(drill,/lmc-restore-/);assert.match(drill,/mktemp/);assert.match(drill,/COMPOSE_PROFILES=prod/);assert.match(drill,/replacement-restore-drill.sh/);
  assert.match(drill,/postgres redis/);assert.doesNotMatch(drill,/up[^\n]+admin|up[^\n]+worker/);
  assert.match(drill,/db:|bootstrap|dist\/cli.js/);
  assert.match(drill,/EXPECTED_APPLICATION_TABLES_NOT_88/);assert.match(drill,/ACTUAL_TABLES.*EXPECTED_TABLES/);
  assert.match(drill,/Migration journal was not preserved/);assert.match(drill,/Reviewed runtime image revision mismatch/);
});
