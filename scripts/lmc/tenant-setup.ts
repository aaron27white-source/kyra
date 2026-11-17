import { GoogleCalendarProvider } from "@lobbystack/providers";
import { verifications, type Database } from "@lobbystack/db";
import { lmcTenantIdentitySchema } from "@lobbystack/contracts";
import { inspectLmcTenantSetup } from "../../packages/domain/src/server/lmc/provision-tenant";
import { createCalendarOAuthState, calendarOAuthStateDigest, verifyCalendarOAuthState } from "../../apps/admin/src/lib/google-calendar-oauth";

/** The existing callback verifies the same signature, session identity and one-use digest. */
export async function issueLmcCalendarAuthorization(context:{database:Database;authDatabase:Database},raw:unknown) {
  const seed=lmcTenantIdentitySchema.parse(raw);
  await inspectLmcTenantSetup(context,seed);
  const clientId=process.env.GOOGLE_CLIENT_ID,clientSecret=process.env.GOOGLE_CLIENT_SECRET,redirectUri=process.env.GOOGLE_REDIRECT_URI;
  if(!clientId||!clientSecret||!redirectUri)throw new Error("GOOGLE_OAUTH_CONFIGURATION_REQUIRED");
  let redirect:URL;
  try{redirect=new URL(redirectUri);}catch{throw new Error("INVALID_GOOGLE_REDIRECT_URI");}
  const local=process.env.NODE_ENV!=="production"&&redirect.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(redirect.hostname);
  if((redirect.protocol!=="https:"&&!local)||redirect.username||redirect.password||redirect.search||redirect.hash||redirect.pathname!=="/api/calendar/google/callback")throw new Error("INVALID_GOOGLE_REDIRECT_URI");
  if(process.env.NODE_ENV==="production"){
    const base=process.env.APP_BASE_URL;
    if(!base||new URL(base).origin!==redirect.origin)throw new Error("GOOGLE_REDIRECT_ORIGIN_MISMATCH");
  }
  if((process.env.BETTER_AUTH_SECRET??process.env.INTERNAL_SERVICE_SECRET??"").trim().length<32)throw new Error("GOOGLE_OAUTH_SIGNING_SECRET_REQUIRED");
  const state=createCalendarOAuthState({userId:seed.userId,businessId:seed.tenantId});
  const parsed=verifyCalendarOAuthState(state);
  if(!parsed)throw new Error("GOOGLE_OAUTH_STATE_UNAVAILABLE");
  const authorizationUrl=new GoogleCalendarProvider({clientId,clientSecret,redirectUri}).buildAuthorizationUrl({state});
  const expiresAt=new Date(parsed.issuedAt+10*60_000);
  await context.authDatabase.insert(verifications).values({identifier:`google-calendar:${calendarOAuthStateDigest(state)}`,value:`${seed.userId}:${seed.tenantId}`,expiresAt});
  return {tenantId:seed.tenantId,authorizationUrl,expiresAt:expiresAt.toISOString()};
}
