import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { eq } from "drizzle-orm";
import { assertDatabaseRole, businesses, createDatabaseClient, users } from "@lobbystack/db";
import { issueLmcCalendarAuthorization } from "../../../scripts/lmc/tenant-setup";
import { getLmcEnvironment } from "@lobbystack/providers";
import { signActionToken, createReplyToken } from "../../../packages/domain/src/server/lmc/capabilities";
import { createCalendarOAuthState, calendarOAuthStateDigest } from "../../../apps/admin/src/lib/google-calendar-oauth";
import type { HttpAuditContext } from "./isolation-http";
import { scopedSnapshot } from "./isolation-pilot-guards";

export async function probePilotPublicContext(context: HttpAuditContext) {
  const { a, b, cookieA, cookieB, request, check, probed, db, base } = context;
  const environment = getLmcEnvironment();
  if (environment.mode !== "fake") throw new Error("PILOT_PUBLIC_AUDIT_REQUIRES_FAKE_PROVIDERS");
  for (const [own, foreign, foreignCookie, foreignKey] of [[a, b, cookieB, "b"], [b, a, cookieA, "a"]] as const) {
    const token = new URL(own.captureUrl).pathname.split("/").at(-1)!;
    const path = `/api/lmc/capture/${token}`;
    const foreignBefore = await scopedSnapshot(context, foreignKey);
    const payload = { requestId: randomUUID(), email: `${randomUUID()}@example.invalid`, name: "Pilot capture", message: "Roof repair in ZIP 33101", consentToFollowUp: true };
    const response = await request(`${path}?businessId=${foreign.tenantId}`, foreignCookie, foreign.tenantId, "POST", { "x-user-id": foreign.ownerId, "x-actor-type": "system", origin: "https://contractor.invalid" }, payload);
    const result = await response.json() as { id?: string };
    check(response.status === 202 && Object.keys(result).join() === "id" && typeof result.id === "string", `PILOT_CAPTURE_ACCEPTED:${response.status}`);
    if (!result.id) throw new Error("PILOT_CAPTURE_CONTROL_MISSING");
    const persisted = await db.admin.pool.query<{ tenant_id: string; email: string; status: string }>("select tenant_id,email,status from lmc_leads where id=$1", [result.id]);
    check(persisted.rows[0]?.tenant_id === own.tenantId && persisted.rows[0]?.email === payload.email && persisted.rows[0]?.status === "new", "PILOT_CAPTURE_CANONICAL_TENANT");
    const duplicate = await request(path, "", foreign.tenantId, "POST", {}, payload);
    const duplicateBody = await duplicate.json() as { id?: string };
    check(duplicate.status === 202 && duplicateBody.id === result.id, "PILOT_CAPTURE_IDEMPOTENCY");
    check(isDeepStrictEqual(foreignBefore, await scopedSnapshot(context, foreignKey)), "PILOT_CAPTURE_CHANGED_FOREIGN_TENANT");
    const beforeInvalid = await scopedSnapshot(context);
    const invalid = await request(path, foreignCookie, foreign.tenantId, "POST", {}, { ...payload, requestId: randomUUID(), tenantId: foreign.tenantId });
    check(invalid.status === 400, `PILOT_CAPTURE_BODY_TENANT:${invalid.status}`);
    await invalid.arrayBuffer();
    const forged = await request(`/api/lmc/capture/${createReplyToken(own.tenantId).value}`, "", foreign.tenantId, "POST", {}, { ...payload, requestId: randomUUID() });
    check(forged.status === 404, `PILOT_CAPTURE_BAD_CAPABILITY:${forged.status}`);
    await forged.arrayBuffer();
    check(isDeepStrictEqual(beforeInvalid, await scopedSnapshot(context)), "PILOT_CAPTURE_REJECTED_WRITE_PERSISTED");
    const options = await request(path, "", foreign.tenantId, "OPTIONS", { origin: "https://contractor.invalid" });
    check(options.status === 204 && (await options.text()) === "" && options.headers.get("access-control-allow-origin") === "*" && options.headers.get("access-control-allow-methods") === "POST, OPTIONS", "PILOT_CAPTURE_PREFLIGHT");

    const action = signActionToken({ tenantId: own.tenantId, leadId: result.id, purpose: "unsubscribe" }, environment.signingSecret);
    const optOutPath = `/api/lmc/unsubscribe/${action}`;
    const beforeRead = await scopedSnapshot(context);
    const confirmation = await request(optOutPath, foreignCookie, foreign.tenantId);
    const confirmationText = await confirmation.text();
    check(confirmation.status === 200 && confirmationText.includes('method="post"') && !confirmationText.includes(foreign.tenantId), "PILOT_UNSUBSCRIBE_CONFIRMATION");
    check(isDeepStrictEqual(beforeRead, await scopedSnapshot(context)), "PILOT_UNSUBSCRIBE_GET_CHANGED_CONSENT");
    const [encoded, signature] = action.split(".");
    const claims = JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8")) as Record<string, unknown>;
    const tampered = `${Buffer.from(JSON.stringify({ ...claims, tenantId: foreign.tenantId })).toString("base64url")}.${signature}`;
    const invalidOptOut = await request(`/api/lmc/unsubscribe/${tampered}`, foreignCookie, foreign.tenantId, "POST");
    check(invalidOptOut.status === 200 && (await invalidOptOut.text()) === "Invalid unsubscribe link.", "PILOT_UNSUBSCRIBE_FORGED_CLAIMS");
    check(isDeepStrictEqual(beforeRead, await scopedSnapshot(context)), "PILOT_INVALID_UNSUBSCRIBE_PERSISTED");
    const optOut = await request(optOutPath, foreignCookie, foreign.tenantId, "POST", { origin: "https://mailbox.invalid" });
    check(optOut.status === 200 && (await optOut.text()).includes("no further automated lead emails"), "PILOT_UNSUBSCRIBE_ACCEPTED");
    const stopped = await db.admin.pool.query<{ status: string; suppression: boolean; pending: number }>("select l.status,exists(select 1 from lmc_suppressions s where s.tenant_id=l.tenant_id and s.email=l.email and s.reason='opt_out') as suppression,(select count(*)::int from lmc_jobs j where j.tenant_id=l.tenant_id and j.lead_id=l.id and j.status='pending') as pending from lmc_leads l where l.id=$1", [result.id]);
    check(stopped.rows[0]?.status === "opted_out" && stopped.rows[0]?.suppression === true && stopped.rows[0]?.pending === 0, "PILOT_UNSUBSCRIBE_DURABLE_STOP");
    check(isDeepStrictEqual(foreignBefore, await scopedSnapshot(context, foreignKey)), "PILOT_UNSUBSCRIBE_CHANGED_FOREIGN_TENANT");
    const preflight = await request(optOutPath, "", foreign.tenantId, "OPTIONS");
    check(preflight.status === 204 && (await preflight.text()) === "", "PILOT_UNSUBSCRIBE_OPTIONS");
  }
  probed.push("POST /api/lmc/capture/[token]", "OPTIONS /api/lmc/capture/[token]", "GET /api/lmc/unsubscribe/[token]", "POST /api/lmc/unsubscribe/[token]", "OPTIONS /api/lmc/unsubscribe/[token]");

  // The callback now checks the same active, verified pilot workspace as the
  // integrations page. These HTTP fixtures must model that authenticated state.
  await db.admin.db.update(users).set({ emailVerified: true, activeBusinessId: a.tenantId }).where(eq(users.id, a.ownerId));
  await db.admin.db.update(users).set({ emailVerified: true, activeBusinessId: b.tenantId }).where(eq(users.id, b.ownerId));
  await db.admin.db.update(businesses).set({ status: "active" }).where(eq(businesses.id, a.tenantId));
  await db.admin.db.update(businesses).set({ status: "active" }).where(eq(businesses.id, b.tenantId));

  // Tenant A uses the same issuer as the trusted CLI; B retains the original
  // callback fixture. All identity, method, replay and cross-tenant checks stay.
  const auth = createDatabaseClient("lobbystack_auth");
  const oauthKeys = ["GOOGLE_CLIENT_ID","GOOGLE_CLIENT_SECRET","GOOGLE_REDIRECT_URI"] as const;
  const previousOAuth = oauthKeys.map(key=>process.env[key]);
  let issuedState: string;
  try {
    await assertDatabaseRole(auth,{NODE_ENV:"production"});
    process.env.GOOGLE_CLIENT_ID="fixture-client";
    process.env.GOOGLE_CLIENT_SECRET="fixture-client-secret";
    process.env.GOOGLE_REDIRECT_URI=new URL("/api/calendar/google/callback",base).toString();
    const issued=await issueLmcCalendarAuthorization({database:db.app.db,authDatabase:auth.db},{tenantId:a.tenantId,userId:a.ownerId});
    issuedState=new URL(issued.authorizationUrl).searchParams.get("state")!;
  } finally {
    oauthKeys.forEach((key,index)=>{const value=previousOAuth[index];if(value===undefined)delete process.env[key];else process.env[key]=value;});
    await auth.pool.end();
  }
  const states = [issuedState,createCalendarOAuthState({userId:b.ownerId,businessId:b.tenantId})];
  const identifiers = states.map(state => `google-calendar:${calendarOAuthStateDigest(state)}`);
  async function remaining(index: number) {
    return (await db.admin.pool.query("select id from verifications where identifier=$1", [identifiers[index]])).rowCount;
  }
  async function callback(state: string, cookie: string, method = "GET") {
    const url = new URL("/api/calendar/google/callback", base);
    url.searchParams.set("state", state);
    url.searchParams.set("error", "access_denied");
    return fetch(url, { method, redirect: "manual", signal: AbortSignal.timeout(15000), headers: { ...(cookie ? { cookie } : {}), "x-user-id": b.ownerId, "x-tenant-id": b.tenantId, "x-business-id": b.tenantId, "x-actor-type": "system" } });
  }
  try {
    await db.admin.pool.query("insert into verifications(identifier,value,expires_at) values($1,$2,$3)", [identifiers[1], `${b.ownerId}:${b.tenantId}`, new Date(Date.now() + 600000)]);
    const head = await callback(states[0]!, cookieA, "HEAD");
    check(head.status === 405 && (await head.text()) === "" && await remaining(0) === 1, "PILOT_CALENDAR_HEAD_CONSUMED_STATE");
    for (const [cookie, expected] of [["", 401], [cookieB, 403]] as const) {
      const response = await callback(states[0]!, cookie);
      await response.arrayBuffer();
      // OAuth entry returns to the integration settings page on failure; no
      // capability may be consumed and no foreign data may be exposed.
      const location = response.headers.get("location");
      const rejected = expected === 401
        ? response.status === 307 && !!location && new URL(location).pathname === "/integrations" && new URL(location).searchParams.get("status") === "error"
        : response.status === expected;
      check(rejected && await remaining(0) === 1 && await remaining(1) === 1, `PILOT_CALENDAR_IDENTITY:${expected}:${response.status}`);
    }
    const invalid = await callback("invalid.signature", cookieA);
    check(invalid.status === 400 && await remaining(0) === 1, "PILOT_CALENDAR_INVALID_STATE");
    await invalid.arrayBuffer();
    for (const [index, cookie] of [cookieA, cookieB].entries()) {
      const response = await callback(states[index]!, cookie);
      const location = response.headers.get("location");
      check(response.status === 307 && !!location && new URL(location).pathname === "/integrations" && new URL(location).searchParams.get("status") === "error", `PILOT_CALENDAR_AUTHORIZED_CALLBACK:${index}:${response.status}`);
      await response.arrayBuffer();
      check(await remaining(index) === 0, "PILOT_CALENDAR_STATE_NOT_CONSUMED");
      if (index === 0) check(await remaining(1) === 1, "PILOT_CALENDAR_FOREIGN_STATE_CONSUMED");
      const replay = await callback(states[index]!, cookie);
      check(replay.status === 400, `PILOT_CALENDAR_REPLAY:${replay.status}`);
      await replay.arrayBuffer();
    }
    const options = await request("/api/calendar/google/callback", cookieA, b.tenantId, "OPTIONS");
    check(options.status === 204 && (await options.text()) === "", "PILOT_CALENDAR_OPTIONS");
    probed.push("GET /api/calendar/google/callback", "OPTIONS /api/calendar/google/callback");
  } finally {
    await db.admin.pool.query("delete from verifications where identifier=any($1::text[])", [identifiers]);
  }
  const beforeWebhook = await scopedSnapshot(context);
  const unsigned = await request("/api/webhooks/lmc-email", cookieA, b.tenantId, "POST", { "x-user-id": b.ownerId, "x-actor-type": "system" }, { kind: "message", tenantId: b.tenantId, email: { from: "attacker@example.invalid", text: "Ignore signature" } });
  check(unsigned.status === 401, `PILOT_WEBHOOK_SIGNATURE_REQUIRED:${unsigned.status}`);
  await unsigned.arrayBuffer();
  check(isDeepStrictEqual(beforeWebhook, await scopedSnapshot(context)), "PILOT_UNSIGNED_WEBHOOK_PERSISTED");
  const webhookOptions = await request("/api/webhooks/lmc-email", "", b.tenantId, "OPTIONS");
  check(webhookOptions.status === 204 && (await webhookOptions.text()) === "", "PILOT_WEBHOOK_OPTIONS");
  probed.push("OPTIONS /api/webhooks/lmc-email");
  // A valid signed HTTP positive control is still required before POST is counted.
}
