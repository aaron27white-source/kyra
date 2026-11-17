import { isDeepStrictEqual } from "node:util";
import type { HttpAuditContext } from "./isolation-http";
import { scopedSnapshot } from "./isolation-pilot-guards";

const routes = [
  "/api/internal/superadmin/overview",
  "/api/internal/superadmin/clients",
] as const;

/** Proves that tenant sessions cannot cross the platform-admin boundary. */
export async function probePilotSuperAdminContext(context: HttpAuditContext) {
  const { a, b, cookieA, cookieB, request, check, probed, db } = context;
  const original = await db.admin.pool.query<{
    platform_role: string;
    two_factor_enabled: boolean;
  }>(
    "select platform_role, two_factor_enabled from users where id=$1",
    [a.ownerId],
  );
  if (!original.rows[0]) throw new Error("PILOT_SUPERADMIN_CONTROL_MISSING");
  const foreignBefore = await scopedSnapshot(context, "b");

  try {
    await db.admin.pool.query(
      "update users set platform_role='platform_admin', two_factor_enabled=true where id=$1",
      [a.ownerId],
    );

    for (const route of routes) {
      for (const method of ["GET", "HEAD"] as const) {
        const anonymous = await request(route, "", a.tenantId, method);
        check(anonymous.status === 401, `PILOT_SUPERADMIN_ANONYMOUS:${method}:${route}:${anonymous.status}`);
        await anonymous.arrayBuffer();

        const tenant = await request(route, cookieB, b.tenantId, method);
        check(tenant.status === 403, `PILOT_SUPERADMIN_TENANT:${method}:${route}:${tenant.status}`);
        await tenant.arrayBuffer();

        const forged = await request(route, cookieB, a.tenantId, method, {
          "x-user-id": a.ownerId,
          "x-actor-type": "system",
        });
        check(forged.status === 403, `PILOT_SUPERADMIN_FORGED:${method}:${route}:${forged.status}`);
        await forged.arrayBuffer();

        const admin = await request(route, cookieA, a.tenantId, method);
        const body = await admin.text();
        const valid = admin.status === 200 && (method === "HEAD" || (
          route.endsWith("/clients")
            ? body.includes(a.tenantId) && body.includes(b.tenantId)
            : Number((JSON.parse(body) as { total?: number }).total) >= 2
        ));
        check(valid, `PILOT_SUPERADMIN_CONTROL:${method}:${route}:${admin.status}`);
        if (valid) probed.push(`${method} ${route}`);
      }

      const options = await request(route, cookieA, a.tenantId, "OPTIONS");
      const allow = (options.headers.get("allow") ?? "").split(/,\s*/);
      const validOptions = options.status === 204 && ["GET", "HEAD", "OPTIONS"].every((method) => allow.includes(method)) && await options.text() === "";
      check(validOptions, `PILOT_SUPERADMIN_OPTIONS:${route}:${options.status}`);
      if (validOptions) probed.push(`OPTIONS ${route}`);
    }

    const managedDenials = [
      { pattern: "/api/internal/superadmin/clients", path: "/api/internal/superadmin/clients", method: "POST" },
      { pattern: "/api/internal/superadmin/clients/[tenantId]/draft", path: `/api/internal/superadmin/clients/${a.tenantId}/draft`, method: "GET" },
      { pattern: "/api/internal/superadmin/clients/[tenantId]/draft", path: `/api/internal/superadmin/clients/${a.tenantId}/draft`, method: "HEAD" },
      { pattern: "/api/internal/superadmin/clients/[tenantId]/draft", path: `/api/internal/superadmin/clients/${a.tenantId}/draft`, method: "PUT" },
      { pattern: "/api/internal/superadmin/clients/[tenantId]/invite", path: `/api/internal/superadmin/clients/${a.tenantId}/invite`, method: "POST" },
      { pattern: "/api/internal/superadmin/clients/[tenantId]/activation", path: `/api/internal/superadmin/clients/${a.tenantId}/activation`, method: "GET" },
      { pattern: "/api/internal/superadmin/clients/[tenantId]/activation", path: `/api/internal/superadmin/clients/${a.tenantId}/activation`, method: "HEAD" },
      { pattern: "/api/internal/superadmin/clients/[tenantId]/activation", path: `/api/internal/superadmin/clients/${a.tenantId}/activation`, method: "POST" },
      { pattern: "/api/internal/superadmin/clients/[tenantId]/voice", path: `/api/internal/superadmin/clients/${a.tenantId}/voice`, method: "PATCH" },
    ] as const;
    for (const target of managedDenials) {
      const response = await request(target.path, cookieB, b.tenantId, target.method, {
        "x-user-id": a.ownerId,
        "x-actor-type": "system",
      }, ["POST", "PUT"].includes(target.method) ? {} : undefined);
      check(response.status === 403, `PILOT_SUPERADMIN_MANAGED_DENIAL:${target.method}:${target.pattern}:${response.status}`);
      await response.arrayBuffer();
      if (response.status === 403) probed.push(`${target.method} ${target.pattern}`);
    }

    for (const target of [
      { pattern: "/api/internal/superadmin/clients/[tenantId]/draft", path: `/api/internal/superadmin/clients/${a.tenantId}/draft`, allow: ["GET", "HEAD", "OPTIONS", "PUT"] },
      { pattern: "/api/internal/superadmin/clients/[tenantId]/invite", path: `/api/internal/superadmin/clients/${a.tenantId}/invite`, allow: ["OPTIONS", "POST"] },
      { pattern: "/api/internal/superadmin/clients/[tenantId]/activation", path: `/api/internal/superadmin/clients/${a.tenantId}/activation`, allow: ["GET", "HEAD", "OPTIONS", "POST"] },
      { pattern: "/api/internal/superadmin/clients/[tenantId]/voice", path: `/api/internal/superadmin/clients/${a.tenantId}/voice`, allow: ["OPTIONS", "PATCH"] },
    ] as const) {
      const response = await request(target.path, cookieA, a.tenantId, "OPTIONS");
      const allow = (response.headers.get("allow") ?? "").split(/,\s*/);
      const valid = response.status === 204 && target.allow.every((method) => allow.includes(method)) && await response.text() === "";
      check(valid, `PILOT_SUPERADMIN_MANAGED_OPTIONS:${target.pattern}:${response.status}`);
      if (valid) probed.push(`OPTIONS ${target.pattern}`);
    }

    const voicePath = `/api/internal/superadmin/clients/${a.tenantId}/voice`;
    const beforeVoice = await db.admin.pool.query<{ id: string; lmc_voice_enabled: boolean }>(
      "select id, lmc_voice_enabled from businesses where id=any($1::uuid[]) order by id",
      [[a.tenantId, b.tenantId]],
    );
    const enabled = await request(voicePath, cookieA, a.tenantId, "PATCH", {}, { enabled: true });
    check(enabled.status === 200, `PILOT_SUPERADMIN_VOICE_ENABLE:${enabled.status}`);
    await enabled.arrayBuffer();
    const afterEnable = await db.admin.pool.query<{ id: string; lmc_voice_enabled: boolean }>(
      "select id, lmc_voice_enabled from businesses where id=any($1::uuid[]) order by id",
      [[a.tenantId, b.tenantId]],
    );
    check(afterEnable.rows.find((row) => row.id === a.tenantId)?.lmc_voice_enabled === true, "PILOT_SUPERADMIN_VOICE_ENABLE_DID_NOT_APPLY");
    check(afterEnable.rows.find((row) => row.id === b.tenantId)?.lmc_voice_enabled === beforeVoice.rows.find((row) => row.id === b.tenantId)?.lmc_voice_enabled, "PILOT_SUPERADMIN_VOICE_ENABLE_CHANGED_FOREIGN_TENANT");
    if (enabled.status === 200) probed.push("PATCH /api/internal/superadmin/clients/[tenantId]/voice");
    const disabled = await request(voicePath, cookieA, a.tenantId, "PATCH", {}, { enabled: false });
    check(disabled.status === 200, `PILOT_SUPERADMIN_VOICE_DISABLE:${disabled.status}`);
    await disabled.arrayBuffer();
    const afterDisable = await db.admin.pool.query<{ id: string; lmc_voice_enabled: boolean }>(
      "select id, lmc_voice_enabled from businesses where id=any($1::uuid[]) order by id",
      [[a.tenantId, b.tenantId]],
    );
    check(afterDisable.rows.find((row) => row.id === a.tenantId)?.lmc_voice_enabled === false, "PILOT_SUPERADMIN_VOICE_DISABLE_DID_NOT_APPLY");
    check(afterDisable.rows.find((row) => row.id === b.tenantId)?.lmc_voice_enabled === beforeVoice.rows.find((row) => row.id === b.tenantId)?.lmc_voice_enabled, "PILOT_SUPERADMIN_VOICE_DISABLE_CHANGED_FOREIGN_TENANT");

    const invitationPreview = await request("/api/team/accept");
    const previewBody = await invitationPreview.json() as { invitation?: unknown };
    check(invitationPreview.status === 200 && previewBody.invitation === null, `PILOT_INVITATION_PREVIEW:${invitationPreview.status}`);
    if (invitationPreview.status === 200 && previewBody.invitation === null) probed.push("GET /api/team/accept");

    const invitationAccept = await request("/api/team/accept", "", "", "POST", {}, { token: "synthetic-invalid" });
    check(invitationAccept.status === 401, `PILOT_INVITATION_ANONYMOUS_ACCEPT:${invitationAccept.status}`);
    await invitationAccept.arrayBuffer();
    if (invitationAccept.status === 401) probed.push("POST /api/team/accept");

    const invitationOptions = await request("/api/team/accept", "", "", "OPTIONS");
    const invitationAllow = (invitationOptions.headers.get("allow") ?? "").split(/,\s*/);
    const validInvitationOptions = invitationOptions.status === 204 && ["GET", "POST", "OPTIONS"].every((method) => invitationAllow.includes(method)) && await invitationOptions.text() === "";
    check(validInvitationOptions, `PILOT_INVITATION_OPTIONS:${invitationOptions.status}`);
    if (validInvitationOptions) probed.push("OPTIONS /api/team/accept");

    check(isDeepStrictEqual(foreignBefore, await scopedSnapshot(context, "b")), "PILOT_SUPERADMIN_CHANGED_FOREIGN_TENANT");
  } finally {
    await db.admin.pool.query(
      "update users set platform_role=$2, two_factor_enabled=$3 where id=$1",
      [a.ownerId, original.rows[0].platform_role, original.rows[0].two_factor_enabled],
    );
  }
}
