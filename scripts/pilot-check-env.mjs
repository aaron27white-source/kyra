import { pathToFileURL } from "node:url";

const passwords=["POSTGRES_PASSWORD",... ["MIGRATOR","AUTH","APP","SYSTEM","WORKER","DISPATCHER","READONLY"].map(role=>`LOBBYSTACK_${role}_PASSWORD`)];
const secrets=["BETTER_AUTH_SECRET","INTERNAL_SERVICE_SECRET","INTERNAL_SERVICE_TOKEN","WIDGET_SESSION_SECRET","ENCRYPTION_KEY","OTP_HASH_SECRET","LOCAL_STORAGE_SIGNING_SECRET","LMC_SIGNING_SECRET"];
const placeholder=value=>!value||/\[FILL|placeholder|change.?me|replace|example\.|\.invalid|^(.)\1+$/i.test(value);
export function validatePilotProductionEnvironment(env){
  const errors=[],seen=new Set();
  const fail=name=>errors.push(`${name}: missing or unsafe production configuration`);
  if(env.NODE_ENV!=="production")fail("NODE_ENV");
  if(placeholder(env.SERVICE_VERSION??"")||!(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(env.SERVICE_VERSION??"")))fail("SERVICE_VERSION");
  for(const name of [...passwords,...secrets]){
    const value=env[name]??"";
    if(placeholder(value)||!(/^[a-f0-9]{64,}$/i.test(value))||seen.has(value))fail(name);
    seen.add(value);
  }
  for(const name of ["GOOGLE_CLIENT_ID","GOOGLE_CLIENT_SECRET","AI_CHAT_MODEL","AI_CHAT_API_KEY"]){
    if(placeholder(env[name]??""))fail(name);
  }
  if((env.AI_CHAT_API_KEY??"").length<16)fail("AI_CHAT_API_KEY");
  if((env.GOOGLE_CLIENT_SECRET??"").length<16)fail("GOOGLE_CLIENT_SECRET");
  if(!/^[A-Za-z0-9_.-]+\.apps\.googleusercontent\.com$/.test(env.GOOGLE_CLIENT_ID??""))fail("GOOGLE_CLIENT_ID");
  if(!/^re_[A-Za-z0-9_-]{8,}$/.test(env.RESEND_API_KEY??"")||placeholder(env.RESEND_API_KEY??""))fail("RESEND_API_KEY");
  const webhook=env.RESEND_WEBHOOK_SECRET??"";
  if(!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(webhook)||Buffer.from(webhook.slice(6),"base64").length<16)fail("RESEND_WEBHOOK_SECRET");
  let origin;
  try{
    const url=new URL(env.APP_BASE_URL??"");
    if(url.protocol!=="https:"||url.username||url.password||url.pathname!=="/"||url.search||url.hash||placeholder(url.hostname)||["localhost","127.0.0.1","[::1]"].includes(url.hostname))throw new Error();
    origin=url.origin;
  }catch{fail("APP_BASE_URL");}
  if(!origin||env.LMC_PUBLIC_BASE_URL?.replace(/\/$/,"")!==origin)fail("LMC_PUBLIC_BASE_URL");
  if(!origin||env.GOOGLE_REDIRECT_URI!==origin+"/api/calendar/google/callback")fail("GOOGLE_REDIRECT_URI");
  if(!/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(env.LMC_EMAIL_FROM??"")||placeholder(env.LMC_EMAIL_FROM??""))fail("LMC_EMAIL_FROM");
  if(!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(env.LMC_RECEIVING_DOMAIN??"")||placeholder(env.LMC_RECEIVING_DOMAIN??""))fail("LMC_RECEIVING_DOMAIN");
  return [...new Set(errors)];
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const errors=validatePilotProductionEnvironment(process.env);
  if(errors.length){for(const error of errors)console.error(error);process.exitCode=1;}
  else console.log("Pilot production environment syntax passed; DNS, credentials, provider contracts and delivery still require manual verification.");
}
