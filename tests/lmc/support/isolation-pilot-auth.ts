import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { verifyLegacyPassword } from "../../../apps/admin/src/lib/password";
import type { HttpAuditContext } from "./isolation-http";
import { scopedSnapshot } from "./isolation-pilot-guards";

/** All credentials and delivery capabilities stay inside the test process and isolated database. */
export async function probePilotAuthContext(context: HttpAuditContext) {
  const { a, b, cookieA, cookieB, request, check, probed, db, base } = context;
  if (!process.env.BETTER_AUTH_SECRET) throw new Error("PILOT_AUTH_PRIVATE_OVERLAY_REQUIRED");
  const emails = Array.from({ length: 3 }, () => `${randomUUID()}@example.invalid`);
  const [signupEmail, otpEmail, linkEmail] = emails as [string, string, string];
  const temporaryIds: string[] = [], ownedCookies: string[] = [], resetIdentifiers: string[] = [];
  const password = () => `Pilot-${randomUUID()}!9`;
  const initialPassword = password();
  const adminRequire = createRequire(new URL("../../../apps/admin/package.json", import.meta.url));
  async function consume(response: Response) {
    const cookies = response.headers.getSetCookie().map(value => value.split(";")[0]).filter(Boolean).join("; ");
    if (cookies.includes("session_token=")) ownedCookies.push(cookies);
    return await response.json() as { user?: { id?: string; email?: string } };
  }
  async function credential(userId: string) {
    const result = await db.admin.pool.query<{ password_hash: string; password: string }>("select u.password_hash,a.password from users u join accounts a on a.user_id=u.id and a.provider_id='credential' where u.id=$1", [userId]);
    if (!result.rows[0]) throw new Error("PILOT_AUTH_CREDENTIAL_CONTROL_MISSING");
    return result.rows[0];
  }
  async function delivery(userId: string, field: "code" | "url", template: string) {
    const result = await db.admin.pool.query<{ value: string }>(`select payload->'variables'->>$2 as value from outbox_messages where aggregate_type='auth_email' and aggregate_id::text=$1 and payload->>'template'=$3 and payload->'variables'->>$2 is not null order by created_at desc,id desc limit 1`, [userId, field, template]);
    const value = result.rows[0]?.value;
    if (!value) throw new Error("PILOT_AUTH_QUEUED_DELIVERY_MISSING");
    return value;
  }
  async function session(cookie: string) {
    const response = await request("/api/auth/get-session", cookie, b.tenantId, "GET", { "x-user-id": b.ownerId, "x-actor-type": "system" });
    check(response.status === 200, "PILOT_AUTH_SESSION_STATUS");
    return await response.json() as { user?: { id?: string } } | null;
  }
  const foreignBefore = await scopedSnapshot(context, "b");
  const foreignCredential = await credential(b.ownerId);
  try {
    const signup = await request("/api/auth/sign-up/email", cookieB, b.tenantId, "POST", { "x-user-id": b.ownerId, "x-actor-type": "system" }, { email: signupEmail, password: initialPassword, name: "Pilot auth audit", userId: b.ownerId, tenantId: b.tenantId, businessId: b.tenantId, role: "platform_admin", emailVerified: true });
    const created = await consume(signup);
    const signupId = created.user?.id as string | undefined;
    check(signup.status === 200 && !!signupId && signupId !== b.ownerId && created.user?.email === signupEmail, `PILOT_AUTH_SIGNUP:${signup.status}`);
    if (!signupId) throw new Error("PILOT_AUTH_SIGNUP_CONTROL_MISSING");
    temporaryIds.push(signupId);
    const membership = await db.admin.pool.query("select 1 from business_memberships where user_id=$1", [signupId]);
    const state = await db.admin.pool.query<{ email_verified: boolean }>("select email_verified from users where id=$1", [signupId]);
    check(membership.rowCount === 0 && state.rows[0]?.email_verified === false, "PILOT_AUTH_SIGNUP_PRIVILEGE_INJECTION");
    probed.push("POST /api/auth/sign-up/email");
    for (const email of [otpEmail, linkEmail]) {
      const id = randomUUID(); temporaryIds.push(id);
      await db.admin.pool.query("insert into users(id,email,normalized_email) values($1,$2,$2)", [id, email]);
    }
    const signupCode = await delivery(signupId, "code", "verify_email");
    const wrongRecipient = await request("/api/auth/email-otp/verify-email", cookieB, b.tenantId, "POST", {}, { email: otpEmail, otp: signupCode, userId: b.ownerId });
    check([400,401,403].includes(wrongRecipient.status), `PILOT_AUTH_OTP_RECIPIENT_BINDING:${wrongRecipient.status}`);
    await wrongRecipient.arrayBuffer();
    const verified = await request("/api/auth/email-otp/verify-email", cookieB, b.tenantId, "POST", {}, { email: signupEmail, otp: signupCode, userId: b.ownerId, tenantId: b.tenantId });
    await consume(verified);
    check(verified.status === 200, `PILOT_AUTH_OTP_VERIFY:${verified.status}`);
    const verifiedUser = await db.admin.pool.query<{ email_verified: boolean }>("select email_verified from users where id=$1", [signupId]);
    check(verifiedUser.rows[0]?.email_verified === true, "PILOT_AUTH_OTP_NOT_PERSISTED");

    const send = await request("/api/auth/email-otp/send-verification-otp", cookieB, b.tenantId, "POST", { "x-user-id": b.ownerId }, { email: otpEmail, type: "email-verification", userId: b.ownerId });
    await consume(send);
    check(send.status === 200, `PILOT_AUTH_CUSTOM_OTP_SEND:${send.status}`);
    const sentCode = await delivery(temporaryIds[1]!, "code", "verify_email");
    const verifySent = await request("/api/auth/email-otp/verify-email", cookieB, b.tenantId, "POST", {}, { email: otpEmail, otp: sentCode });
    await consume(verifySent);
    check(verifySent.status === 200, `PILOT_AUTH_CUSTOM_OTP_VERIFY:${verifySent.status}`);
    const recipient = await db.admin.pool.query<{ email_verified: boolean }>("select email_verified from users where id=$1", [temporaryIds[1]]);
    check(recipient.rows[0]?.email_verified === true, "PILOT_AUTH_CUSTOM_OTP_RECIPIENT");
    probed.push("POST /api/auth/email-otp/send-verification-otp", "POST /api/auth/email-otp/verify-email");

    // The SDK sender is intentionally disabled by the application hook; the
    // supported custom OTP sender above is its real positive control.
    const disabledBefore = await db.admin.pool.query("select id from outbox_messages where aggregate_id::text=$1", [temporaryIds[2]]);
    const disabled = await request("/api/auth/send-verification-email", cookieB, b.tenantId, "POST", {}, { email: linkEmail });
    check(disabled.status === 404, `PILOT_AUTH_DISABLED_SDK_SENDER:${disabled.status}`);
    await disabled.arrayBuffer();
    check((await db.admin.pool.query("select id from outbox_messages where aggregate_id::text=$1", [temporaryIds[2]])).rowCount === disabledBefore.rowCount, "PILOT_DISABLED_SENDER_QUEUED_EMAIL");
    probed.push("POST /api/auth/send-verification-email");
    const sdk = await import(adminRequire.resolve("better-auth/api")) as { createEmailVerificationToken(secret: string, email: string): Promise<string> };
    const linkToken = await sdk.createEmailVerificationToken(process.env.BETTER_AUTH_SECRET, linkEmail);
    const parts = linkToken.split(".");
    const forged = `${parts[0]}.${Buffer.from(JSON.stringify({ email: `${b.ownerId}@example.invalid` })).toString("base64url")}.${parts[2]}`;
    const rejected = await request(`/api/auth/verify-email?token=${encodeURIComponent(forged)}`, cookieB, b.tenantId);
    check(rejected.status === 401, `PILOT_AUTH_FORGED_VERIFICATION:${rejected.status}`);
    await rejected.arrayBuffer();
    const verifyLink = await request(`/api/auth/verify-email?token=${encodeURIComponent(linkToken)}`, cookieB, b.tenantId);
    await consume(verifyLink);
    check(verifyLink.status === 200, `PILOT_AUTH_LINK_VERIFY:${verifyLink.status}`);
    check((await db.admin.pool.query<{ email_verified: boolean }>("select email_verified from users where id=$1", [temporaryIds[2]])).rows[0]?.email_verified === true, "PILOT_AUTH_LINK_VERIFICATION_NOT_PERSISTED");
    probed.push("GET /api/auth/verify-email");

    const recovery = await request("/api/auth/request-password-reset", cookieB, b.tenantId, "POST", {}, { email: `${a.ownerId}@example.invalid`, redirectTo: `${base.origin}/en/reset-password`, userId: b.ownerId });
    await consume(recovery);
    check(recovery.status === 200, `PILOT_AUTH_LINK_RESET_REQUEST:${recovery.status}`);
    const resetUrl = new URL(await delivery(a.ownerId, "url", "password_reset"));
    if (resetUrl.origin !== base.origin || !/^\/api\/auth\/reset-password\/[A-Za-z0-9_-]+$/.test(resetUrl.pathname)) throw new Error("PILOT_AUTH_RESET_CALLBACK_ORIGIN");
    const resetToken = resetUrl.pathname.split("/").at(-1)!;
    resetIdentifiers.push(`reset-password:${resetToken}`);
    const callback = await fetch(resetUrl, { redirect: "manual", headers: { cookie: cookieB }, signal: AbortSignal.timeout(15000) });
    const target = callback.headers.get("location");
    check(callback.status === 302 && !!target && new URL(target).origin === base.origin && new URL(target).pathname === "/en/reset-password" && new URL(target).searchParams.get("token") === resetToken, `PILOT_AUTH_RESET_CALLBACK:${callback.status}`);
    await callback.arrayBuffer();
    probed.push("POST /api/auth/request-password-reset", "GET /api/auth/reset-password/[token]");
    const replacement = password();
    const reset = await request("/api/auth/reset-password", cookieB, b.tenantId, "POST", { "x-user-id": b.ownerId }, { token: resetToken, newPassword: replacement, userId: b.ownerId });
    await consume(reset);
    check(reset.status === 200, `PILOT_AUTH_LINK_RESET:${reset.status}`);
    const stored = await credential(a.ownerId);
    check(stored.password === stored.password_hash && await verifyLegacyPassword(stored.password_hash, replacement), "PILOT_AUTH_LINK_RESET_WRONG_USER");
    check(await session(cookieA) === null && (await session(cookieB))?.user?.id === b.ownerId, "PILOT_AUTH_LINK_RESET_SESSION_REVOCATION");
    const replay = await request("/api/auth/reset-password", cookieB, b.tenantId, "POST", {}, { token: resetToken, newPassword: password() });
    check(replay.status === 400, `PILOT_AUTH_LINK_RESET_REPLAY:${replay.status}`);
    await replay.arrayBuffer();
    check(isDeepStrictEqual(stored, await credential(a.ownerId)), "PILOT_AUTH_RESET_REPLAY_CHANGED_PASSWORD");
    probed.push("POST /api/auth/reset-password");

    const loginA = await request("/api/auth/sign-in/email", "", a.tenantId, "POST", {}, { email: `${a.ownerId}@example.invalid`, password: replacement });
    const cookieFreshA = loginA.headers.getSetCookie().map(value => value.split(";")[0]).filter(Boolean).join("; ");
    await consume(loginA);
    check(loginA.status === 200 && (await session(cookieFreshA))?.user?.id === a.ownerId, "PILOT_AUTH_NEW_PASSWORD_LOGIN");
    const requestOtp = await request("/api/auth/email-otp/request-password-reset", cookieB, b.tenantId, "POST", {}, { email: `${a.ownerId}@example.invalid`, userId: b.ownerId });
    await consume(requestOtp);
    check(requestOtp.status === 200, `PILOT_AUTH_RECOVERY_OTP_REQUEST:${requestOtp.status}`);
    const recoveryCode = await delivery(a.ownerId, "code", "password_reset");
    const nextPassword = password();
    const wrongReset = await request("/api/auth/email-otp/reset-password", cookieB, b.tenantId, "POST", {}, { email: `${b.ownerId}@example.invalid`, otp: recoveryCode, password: nextPassword });
    check([400,401,403].includes(wrongReset.status), `PILOT_AUTH_RESET_OTP_RECIPIENT:${wrongReset.status}`);
    await wrongReset.arrayBuffer();
    const otpReset = await request("/api/auth/email-otp/reset-password", cookieB, b.tenantId, "POST", { "x-user-id": b.ownerId }, { email: `${a.ownerId}@example.invalid`, otp: recoveryCode, password: nextPassword, userId: b.ownerId });
    await consume(otpReset);
    check(otpReset.status === 200, `PILOT_AUTH_RESET_OTP:${otpReset.status}`);
    const finalPassword = await credential(a.ownerId);
    check(finalPassword.password === finalPassword.password_hash && await verifyLegacyPassword(finalPassword.password, nextPassword), "PILOT_AUTH_OTP_RESET_WRONG_USER");
    check(await session(cookieFreshA) === null && (await session(cookieB))?.user?.id === b.ownerId, "PILOT_AUTH_OTP_RESET_SESSION_REVOCATION");
    probed.push("POST /api/auth/email-otp/request-password-reset", "POST /api/auth/email-otp/reset-password");

    const login = await request("/api/auth/sign-in/email", "", a.tenantId, "POST", {}, { email: signupEmail, password: initialPassword });
    const logoutCookie = login.headers.getSetCookie().map(value => value.split(";")[0]).filter(Boolean).join("; ");
    await consume(login);
    check(login.status === 200 && (await session(logoutCookie))?.user?.id === signupId, "PILOT_AUTH_LOGOUT_POSITIVE_CONTROL");

    const enableMfa = await request("/api/auth/two-factor/enable", logoutCookie, a.tenantId, "POST", { "x-user-id": b.ownerId, "x-actor-type": "system" }, { password: initialPassword, method: "totp" });
    const enrollment = await enableMfa.json() as { totpURI?: string; backupCodes?: string[] };
    const secret = enrollment.totpURI ? new URL(enrollment.totpURI).searchParams.get("secret") : null;
    check(enableMfa.status === 200 && !!secret && (enrollment.backupCodes?.length ?? 0) > 0, `PILOT_AUTH_MFA_ENABLE:${enableMfa.status}`);
    if (!secret || !enrollment.backupCodes?.[0]) throw new Error("PILOT_AUTH_MFA_CONTROL_MISSING");
    const authEntry = adminRequire.resolve("better-auth");
    const authRequire = createRequire(authEntry);
    const [{ createOTP }, { base32 }] = await Promise.all([
      import(authRequire.resolve("@better-auth/utils/otp")) as Promise<{ createOTP(secret: string): { totp(): Promise<string> } }>,
      import(authRequire.resolve("@better-auth/utils/base32")) as Promise<{ base32: { decode(value: string): Uint8Array } }>,
    ]);
    const code = await createOTP(new TextDecoder().decode(base32.decode(secret))).totp();
    const verifyMfa = await request("/api/auth/two-factor/verify-totp", logoutCookie, a.tenantId, "POST", { "x-user-id": b.ownerId, "x-actor-type": "system" }, { code, trustDevice: false });
    const mfaCookie = verifyMfa.headers.getSetCookie().map(value => value.split(";")[0]).filter(Boolean).join("; ");
    await consume(verifyMfa);
    const mfaState = await db.admin.pool.query<{ two_factor_enabled: boolean; verified: boolean }>("select u.two_factor_enabled,t.verified from users u join two_factors t on t.user_id=u.id where u.id=$1", [signupId]);
    check(verifyMfa.status === 200 && mfaCookie.includes("session_token=") && mfaState.rows[0]?.two_factor_enabled === true && mfaState.rows[0]?.verified === true, `PILOT_AUTH_MFA_TOTP:${verifyMfa.status}`);
    const backup = await request("/api/auth/two-factor/verify-backup-code", mfaCookie, a.tenantId, "POST", { "x-user-id": b.ownerId, "x-actor-type": "system" }, { code: enrollment.backupCodes[0], trustDevice: false });
    check(backup.status === 200, `PILOT_AUTH_MFA_BACKUP:${backup.status}`);
    await backup.arrayBuffer();
    const mfaReplay = await request("/api/auth/two-factor/verify-backup-code", mfaCookie, a.tenantId, "POST", {}, { code: enrollment.backupCodes[0], trustDevice: false });
    check(mfaReplay.status === 401, `PILOT_AUTH_MFA_BACKUP_REPLAY:${mfaReplay.status}`);
    await mfaReplay.arrayBuffer();
    probed.push("POST /api/auth/two-factor/enable", "POST /api/auth/two-factor/verify-totp", "POST /api/auth/two-factor/verify-backup-code");

    const logout = await request("/api/auth/sign-out", mfaCookie, b.tenantId, "POST", { "x-user-id": b.ownerId }, {});
    await logout.arrayBuffer();
    check(logout.status === 200 && await session(mfaCookie) === null && (await session(cookieB))?.user?.id === b.ownerId, "PILOT_AUTH_LOGOUT_OTHER_USER_AFFECTED");
    probed.push("POST /api/auth/sign-out");
    check(isDeepStrictEqual(foreignCredential, await credential(b.ownerId)), "PILOT_AUTH_FOREIGN_PASSWORD_CHANGED");
    check(isDeepStrictEqual(foreignBefore, await scopedSnapshot(context, "b")), "PILOT_AUTH_FOREIGN_TENANT_CHANGED");
  } finally {
    for (const cookie of ownedCookies) {
      const response = await request("/api/auth/sign-out", cookie, "", "POST", {}, {});
      check(response.status === 200, "PILOT_AUTH_EXTRA_SESSION_CLEANUP");
      await response.arrayBuffer();
    }
    const created = await db.admin.pool.query<{ id: string }>("select id from users where email=any($1::text[])", [emails]);
    const ids = [a.ownerId, b.ownerId, ...created.rows.map(row => row.id)];
    await db.admin.pool.query("delete from outbox_messages where aggregate_type='auth_email' and aggregate_id::text=any($1::text[])", [ids]);
    await db.admin.pool.query("delete from verifications where identifier=any($1::text[]) or value=any($2::text[]) or identifier like any($3::text[])", [resetIdentifiers, ids, [...emails, `${a.ownerId}@example.invalid`, `${b.ownerId}@example.invalid`].map(email => `%${email}%`)]);
    await db.admin.pool.query("delete from users where email=any($1::text[])", [emails]);
  }
}
