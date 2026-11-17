import { isDeepStrictEqual } from "node:util";

import type { HttpAuditContext } from "./isolation-http";
import { scopedSnapshot } from "./isolation-pilot-guards";

/** Proves that owner-managed calendar setup cannot select another tenant. */
export async function probePilotManagedSetupContext(context: HttpAuditContext) {
  const { a, b, cookieA, request, check, probed, db } = context;
  const before = await scopedSnapshot(context);
  const original = await db.admin.pool.query<{ status: string; onboarding_stage: string }>(
    "select status,onboarding_stage from businesses where id=$1",
    [a.tenantId],
  );
  const foreignConnection = await db.admin.pool.query<{ id: string }>(
    "select id from calendar_connections where business_id=$1 order by created_at limit 1",
    [b.tenantId],
  );
  if (!original.rows[0] || !foreignConnection.rows[0]) throw new Error("PILOT_MANAGED_SETUP_CONTROL_MISSING");

  try {
    await db.admin.pool.query(
      "update businesses set status='draft',onboarding_stage='managed_draft' where id=$1",
      [a.tenantId],
    );

    for (const method of ["GET", "HEAD"] as const) {
      const response = await request("/api/lmc/setup/calendar", cookieA, "", method);
      const valid = response.status === 200;
      check(valid, `PILOT_MANAGED_SETUP_CONTROL:${method}:${response.status}`);
      await response.arrayBuffer();
      if (valid) probed.push(`${method} /api/lmc/setup/calendar`);
    }

    await db.admin.pool.query(
      "update businesses set status='paused',onboarding_stage='managed_active' where id=$1",
      [a.tenantId],
    );
    const pausedRecovery = await request("/api/lmc/setup/calendar", cookieA);
    check(pausedRecovery.status === 200, `PILOT_MANAGED_SETUP_PAUSED_RECOVERY:${pausedRecovery.status}`);
    await pausedRecovery.arrayBuffer();

    const foreignSelection = await request(
      "/api/lmc/setup/calendar",
      cookieA,
      "",
      "PATCH",
      {},
      { connectionId: foreignConnection.rows[0].id, calendarId: "primary" },
    );
    check(foreignSelection.status === 404, `PILOT_MANAGED_SETUP_FOREIGN_CONNECTION:${foreignSelection.status}`);
    await foreignSelection.arrayBuffer();
    if (foreignSelection.status === 404) probed.push("PATCH /api/lmc/setup/calendar");

    const setupOptions = await request("/api/lmc/setup/calendar", cookieA, "", "OPTIONS");
    const setupAllow = (setupOptions.headers.get("allow") ?? "").split(/,\s*/);
    const validSetupOptions = setupOptions.status === 204 && ["GET", "HEAD", "OPTIONS", "PATCH"].every((method) => setupAllow.includes(method)) && await setupOptions.text() === "";
    check(validSetupOptions, `PILOT_MANAGED_SETUP_OPTIONS:${setupOptions.status}`);
    if (validSetupOptions) probed.push("OPTIONS /api/lmc/setup/calendar");

    const foreignStart = await request(`/api/calendar/google/start?businessId=${b.tenantId}`, cookieA, "", "GET");
    check(foreignStart.status === 404, `PILOT_CALENDAR_START_FOREIGN_TENANT:${foreignStart.status}`);
    await foreignStart.arrayBuffer();
    if (foreignStart.status === 404) probed.push("GET /api/calendar/google/start");

    const startOptions = await request("/api/calendar/google/start", cookieA, "", "OPTIONS");
    const startAllow = (startOptions.headers.get("allow") ?? "").split(/,\s*/);
    const validStartOptions = startOptions.status === 204 && ["GET", "OPTIONS"].every((method) => startAllow.includes(method)) && await startOptions.text() === "";
    check(validStartOptions, `PILOT_CALENDAR_START_OPTIONS:${startOptions.status}`);
    if (validStartOptions) probed.push("OPTIONS /api/calendar/google/start");
  } finally {
    await db.admin.pool.query(
      "update businesses set status=$2,onboarding_stage=$3 where id=$1",
      [a.tenantId, original.rows[0].status, original.rows[0].onboarding_stage],
    );
  }

  check(isDeepStrictEqual(before, await scopedSnapshot(context)), "PILOT_MANAGED_SETUP_CHANGED_SCOPED_DATABASE");
}
