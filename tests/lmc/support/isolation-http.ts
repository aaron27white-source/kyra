import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { accounts, users } from "@lobbystack/db";
import { verifyReplyToken } from "../../../packages/domain/src/server/lmc/capabilities";
import { hashReplacementPassword } from "../../../apps/admin/src/lib/password";
import { openLmcTestDatabase } from "./database";
import { createLmcHarness } from "./harness";

type Harness = Awaited<ReturnType<typeof createLmcHarness>>;
// The exhaustive audit intentionally cold-compiles every allowlisted Next.js
// route. Hosted runners can spend more than 15 seconds compiling a route even
// when the request itself is healthy; keep the enclosing 180-second audit cap
// while allowing an individual cold compile to finish deterministically.
const HTTP_AUDIT_REQUEST_TIMEOUT_MS = 30_000;
type AuditRequest = (
  path: string,
  cookie?: string,
  tenant?: string,
  method?: string,
  extra?: Record<string, string>,
  body?: unknown,
) => Promise<Response>;
export type HttpAuditContext = {
  db: ReturnType<typeof openLmcTestDatabase>;
  base: URL;
  a: Harness;
  b: Harness;
  one: { id: string };
  other: { id: string };
  cookieA: string;
  cookieB: string;
  verifiedLoginUsers: readonly string[];
  request: AuditRequest;
  login: (h: Harness) => Promise<string>;
  check: (condition: boolean, code: string) => void;
  probed: string[];
};

/** Exercises the running Next HTTP/auth boundaries. Only synthetic .invalid identities and lead content are used. */
export async function withHttpAudit(
  baseUrl: string,
  run: (context: HttpAuditContext) => Promise<void>,
) {
  const base = new URL(baseUrl);
  if (
    base.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new Error("ISOLATION_HTTP_REQUIRES_LOCAL_ORIGIN");
  const db = openLmcTestDatabase(),
    failures: string[] = [],
    probed: string[] = [];
  let a: Harness | undefined, b: Harness | undefined;
  const loggedInCookies: string[] = [];
  const verifiedLoginUsers: string[] = [];
  const check = (condition: boolean, code: string) => {
    if (!condition) failures.push(code);
  };
  async function request(
    path: string,
    cookie = "",
    tenant = "",
    method = "GET",
    extra: Record<string, string> = {},
    body?: unknown,
  ) {
    const send = () => fetch(new URL(path, base), {
      method,
      headers: {
        ...(!["GET", "HEAD", "OPTIONS"].includes(method)
          ? { origin: base.origin, "Content-Type": "application/json" }
          : {}),
        ...(cookie ? { cookie } : {}),
        ...(tenant ? { "x-business-id": tenant } : {}),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(HTTP_AUDIT_REQUEST_TIMEOUT_MS),
      redirect: "error",
    });
    let response = await send();
    // Recovery/logout positive controls also log in. Respect the same real
    // per-path quota as fixture login, without replaying an accepted write.
    if (path === "/api/auth/sign-in/email" && method === "POST") {
      for (let retry = 0; response.status === 429 && retry < 2; retry += 1) {
        const seconds = Number(response.headers.get("retry-after") ?? 60);
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60)
          throw new Error("AUDIT_AUTH_RETRY_AFTER_INVALID");
        await response.arrayBuffer();
        console.info("AUDIT_LOGIN_429_RETRY_AFTER_RESPECTED");
        let remaining = (seconds + 0.25) * 1000;
        while (remaining > 0) {
          const delay = Math.min(remaining, 30_000);
          await new Promise((resolve) => setTimeout(resolve, delay));
          remaining -= delay;
        }
        response = await send();
      }
    }
    return response;
  }
  async function login(h: Harness) {
    const password = `Audit-${randomBytes(24).toString("hex")}!`;
    const hash = await hashReplacementPassword(password);
    await db.admin.db
      .update(users)
      .set({ emailVerified: true, passwordHash: hash })
      .where(eq(users.id, h.ownerId));
    await db.admin.db.insert(accounts).values({
      userId: h.ownerId,
      providerId: "credential",
      accountId: h.ownerId,
      password: hash,
    });
    let response: Response | undefined;
    for (let attempt = 0; attempt <= 2; attempt += 1) {
      response = await fetch(new URL("/api/auth/sign-in/email", base), {
        method: "POST",
        headers: { "Content-Type": "application/json", origin: base.origin },
        body: JSON.stringify({
          email: `${h.ownerId}@example.invalid`,
          password,
        }),
        signal: AbortSignal.timeout(HTTP_AUDIT_REQUEST_TIMEOUT_MS),
        redirect: "error",
      });
      if (response.status !== 429 || attempt === 2) break;
      const seconds = Number(response.headers.get("retry-after") ?? 60);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60)
        throw new Error("AUDIT_AUTH_RETRY_AFTER_INVALID");
      await response.arrayBuffer();
      // Respect the real login quota. Never retry successful or uncertain writes.
      let remaining = (seconds + 0.25) * 1000;
      while (remaining > 0) {
        const delay = Math.min(remaining, 30_000);
        await new Promise((resolve) => setTimeout(resolve, delay));
        remaining -= delay;
      }
    }
    if (!response) throw new Error("AUDIT_AUTH_RESPONSE_MISSING");
    if (response.status !== 200)
      throw new Error(`AUDIT_SIGN_IN_STATUS:${response.status}`);
    const result = (await response.json()) as { user?: { id?: string } };
    if (result.user?.id !== h.ownerId)
      throw new Error("AUDIT_SERVER_DATABASE_MISMATCH");
    const cookies = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .filter(Boolean)
      .join("; ");
    if (!cookies.includes("session_token="))
      throw new Error("AUDIT_SESSION_COOKIE_MISSING");
    loggedInCookies.push(cookies);
    verifiedLoginUsers.push(h.ownerId);
    return cookies;
  }
  try {
    a = await createLmcHarness({ now: "2030-01-09T03:40:00Z" });
    b = await createLmcHarness({ now: "2030-01-09T03:40:00Z" });
    const one = await a.capture({
      email: "http-a@example.invalid",
      message: "Private tenant A roof request",
    });
    const other = await b.capture({
      email: "http-b@example.invalid",
      message: "Private tenant B roof request",
    });
    const cookieA = await login(a),
      cookieB = await login(b);
    await run({
      db,
      base,
      a,
      b,
      one,
      other,
      cookieA,
      cookieB,
      verifiedLoginUsers,
      request,
      login,
      check,
      probed,
    });
  } finally {
    for (const cookie of loggedInCookies) {
      try {
        const response = await fetch(new URL("/api/auth/sign-out", base), {
          method: "POST",
          headers: {
            cookie,
            origin: base.origin,
            "Content-Type": "application/json",
          },
          body: "{}",
          signal: AbortSignal.timeout(5_000),
          redirect: "error",
        });
        if (!response.ok)
          failures.push(`HTTP_SESSION_CLEANUP:${response.status}`);
        await response.arrayBuffer();
      } catch {
        failures.push("HTTP_SESSION_CLEANUP_FAILED");
      }
    }
    try {
      const tenants = [a, b].flatMap((fixture) =>
        fixture ? [fixture.tenantId] : [],
      );
      if (tenants.length) {
        const cleanup = await db.admin.pool.connect();
        try {
          await cleanup.query("begin");
          // Parent locks serialize any in-flight FK writer before queue cleanup.
          // Delete queue and parent together so ON DELETE SET NULL cannot orphan a late job.
          await cleanup.query(
            "select id from businesses where id=any($1::uuid[]) order by id for update",
            [tenants],
          );
          await cleanup.query(
            "delete from outbox_messages where business_id=any($1::uuid[])",
            [tenants],
          );
          await cleanup.query(
            "delete from businesses where id=any($1::uuid[])",
            [tenants],
          );
          await cleanup.query("commit");
        } catch (error) {
          await cleanup.query("rollback");
          throw error;
        } finally {
          cleanup.release();
        }
      }
    } finally {
      try {
        await b?.close();
      } finally {
        try {
          await a?.close();
        } finally {
          await db.close();
        }
      }
    }
  }
  return { failures, probed };
}

export async function probeEmailReadContext({
  a,
  b,
  one,
  other,
  cookieA,
  cookieB,
  request,
  check,
  probed,
}: HttpAuditContext) {
  for (const target of [
    { route: "/api/leads", a: "/api/leads", b: "/api/leads" },
    {
      route: "/api/leads/[leadId]",
      a: `/api/leads/${one.id}`,
      b: `/api/leads/${other.id}`,
    },
  ]) {
    const ownA = await request(target.a, cookieA, a.tenantId);
    const dataA = await ownA.text();
    check(
      ownA.status === 200 &&
        dataA.includes(one.id) &&
        !dataA.includes(other.id) &&
        !dataA.includes("Private tenant B roof request"),
      `HTTP_OWN_A:${target.route}:${ownA.status}`,
    );
    check(
      ownA.headers.get("cache-control")?.includes("private") === true &&
        ownA.headers.get("cache-control")?.includes("no-store") === true,
      `HTTP_PRIVATE_CACHE:${target.route}`,
    );
    const ownB = await request(target.b, cookieB, b.tenantId),
      dataB = await ownB.text();
    check(
      ownB.status === 200 &&
        dataB.includes(other.id) &&
        !dataB.includes(one.id),
      `HTTP_OWN_B:${target.route}:${ownB.status}`,
    );
    for (const method of ["GET", "HEAD"]) {
      const own = await request(target.a, cookieA, a.tenantId, method);
      check(
        own.status === 200,
        `HTTP_OWN_METHOD:${method}:${target.route}:${own.status}`,
      );
      await own.arrayBuffer();
      const unauthorized = await request(target.a, "", a.tenantId, method);
      check(
        unauthorized.status === 401,
        `HTTP_ANONYMOUS:${method}:${target.route}:${unauthorized.status}`,
      );
      await unauthorized.arrayBuffer();
      for (const path of [target.b, `${target.b}?businessId=${b.tenantId}`]) {
        const foreign = await request(path, cookieA, b.tenantId, method, {
          "x-user-id": b.ownerId,
          "x-actor-type": "system",
        });
        const body = await foreign.text();
        check(
          foreign.status === 403 &&
            !body.includes(other.id) &&
            !body.includes("Private tenant B roof request"),
          `HTTP_FOREIGN_TENANT:${method}:${target.route}:${foreign.status}`,
        );
      }
      if (target.route.includes("[leadId]")) {
        const foreignId = await request(target.b, cookieA, a.tenantId, method);
        check(
          foreignId.status === 404,
          `HTTP_FOREIGN_RESOURCE:${method}:${target.route}:${foreignId.status}`,
        );
        await foreignId.arrayBuffer();
      }
      probed.push(`${method} ${target.route}`);
    }
    for (const [cookie, tenant, path] of [
      [cookieA, a.tenantId, target.a],
      [cookieA, b.tenantId, target.b],
    ]) {
      const options = await request(path!, cookie!, tenant!, "OPTIONS");
      const allow = options.headers.get("allow") ?? "",
        text = await options.text();
      check(
        options.status === 204 &&
          ["GET", "HEAD", "OPTIONS"].every((method) =>
            allow.split(/,\s*/).includes(method),
          ) &&
          text === "",
        `HTTP_OPTIONS:${target.route}:${options.status}`,
      );
    }
    probed.push(`OPTIONS ${target.route}`);
  }
}

export function probeEmailReadRoutes(baseUrl: string) {
  return withHttpAudit(baseUrl, probeEmailReadContext);
}

export async function probeEmailMutationContext({
  db,
  a,
  b,
  one,
  other,
  cookieA,
  cookieB,
  request,
  login,
  check,
  probed,
}: HttpAuditContext) {
  await a.work();
  await b.work();
  const viewerId = await a.addViewer();
  const viewerCookie = await login({ ...a, ownerId: viewerId });
  async function snapshot(tenant: string) {
    const state: Record<string, unknown> = {};
    for (const table of [
      "lmc_settings",
      "lmc_leads",
      "lmc_messages",
      "lmc_events",
      "lmc_suppressions",
      "lmc_rate_windows",
      "lmc_jobs",
      "contacts",
      "appointments",
      "outbox_messages",
    ]) {
      const column = table.startsWith("lmc_") ? "tenant_id" : "business_id";
      const rows = await db.admin.pool.query(
        `select to_jsonb(t) as value from public.${table} t where ${column}=$1`,
        [tenant],
      );
      state[table] = rows.rows.map((row) => JSON.stringify(row.value)).sort();
    }
    return JSON.stringify(state);
  }
  async function settings(cookie: string, tenant: string) {
    const response = await request("/api/lmc/settings", cookie, tenant);
    if (response.status !== 200)
      throw new Error(`AUDIT_SETTINGS_CONTROL:${response.status}`);
    const result = (await response.json()) as {
      providerMode?: string;
      config: Record<string, unknown>;
      catalog: Array<{ id: string }>;
      senderEmail: string;
    };
    if (result.providerMode !== "fake")
      throw new Error("AUDIT_REQUIRES_FAKE_SERVER_PROVIDERS");
    return result;
  }
  const settingsA = await settings(cookieA, a.tenantId),
    settingsB = await settings(cookieB, b.tenantId);
  check(
    settingsA.catalog.every(
      (item) => !settingsB.catalog.some((other) => other.id === item.id),
    ),
    "HTTP_SETTINGS_CATALOG_ISOLATION",
  );
  const viewerRead = await request(
    "/api/lmc/settings",
    viewerCookie,
    a.tenantId,
  );
  check(viewerRead.status === 200, "HTTP_VIEWER_SETTINGS_READ");
  await viewerRead.arrayBuffer();
  for (const method of ["GET", "HEAD"]) {
    for (const [cookie, tenant] of [
      [cookieA, a.tenantId],
      [cookieB, b.tenantId],
    ]) {
      const own = await request("/api/lmc/settings", cookie, tenant, method);
      check(
        own.status === 200 &&
          own.headers.get("cache-control")?.includes("no-store") === true,
        `HTTP_SETTINGS_OWN:${method}:${own.status}`,
      );
      await own.arrayBuffer();
    }
    const anonymous = await request(
      "/api/lmc/settings",
      "",
      a.tenantId,
      method,
    );
    check(
      anonymous.status === 401,
      `HTTP_SETTINGS_ANONYMOUS:${method}:${anonymous.status}`,
    );
    await anonymous.arrayBuffer();
    for (const path of [
      "/api/lmc/settings",
      `/api/lmc/settings?businessId=${b.tenantId}`,
    ]) {
      const foreign = await request(path, cookieA, b.tenantId, method),
        text = await foreign.text();
      check(
        foreign.status === 403 && !text.includes(b.tenantId),
        `HTTP_SETTINGS_FOREIGN:${method}:${foreign.status}`,
      );
    }
    probed.push(`${method} /api/lmc/settings`);
  }
  const cases = [
    {
      route: "/api/leads/[leadId]/automation",
      method: "PATCH",
      pathA: `/api/leads/${one.id}/automation`,
      pathB: `/api/leads/${other.id}/automation`,
      bodyA: { paused: true },
      bodyB: { paused: true },
      allow: ["PATCH", "OPTIONS"],
    },
    {
      route: "/api/leads/[leadId]/reply",
      method: "POST",
      pathA: `/api/leads/${one.id}/reply`,
      pathB: `/api/leads/${other.id}/reply`,
      bodyA: { requestId: randomUUID(), text: "Audit owner A response" },
      bodyB: { requestId: randomUUID(), text: "Audit owner B response" },
      allow: ["POST", "OPTIONS"],
    },
    {
      route: "/api/lmc/settings",
      method: "PUT",
      pathA: "/api/lmc/settings",
      pathB: "/api/lmc/settings",
      bodyA: {
        enabled: true,
        config: {
          ...settingsA.config,
          fromEmail: settingsA.senderEmail,
          tone: "friendly",
        },
      },
      bodyB: {
        enabled: true,
        config: {
          ...settingsB.config,
          fromEmail: settingsB.senderEmail,
          tone: "concise",
        },
      },
      allow: ["GET", "HEAD", "PUT", "OPTIONS"],
    },
    {
      route: "/api/lmc/settings/capture-token",
      method: "POST",
      pathA: "/api/lmc/settings/capture-token",
      pathB: "/api/lmc/settings/capture-token",
      bodyA: {},
      bodyB: {},
      allow: ["POST", "OPTIONS"],
    },
  ];
  for (const target of cases) {
    async function confirm(
      h: Harness,
      leadId: string,
      data: { id?: string; captureToken?: string },
      label: string,
    ) {
      const lead = await h.lead(leadId);
      if (target.route.endsWith("/automation"))
        check(lead.aiPaused === true, `HTTP_PAUSE_NOT_PERSISTED:${label}`);
      if (target.route.endsWith("/reply")) {
        const message = await db.admin.pool.query(
          `select 1 from lmc_messages where tenant_id=$1 and lead_id=$2 and id=$3 and direction='human' and status='queued'`,
          [h.tenantId, leadId, data.id],
        );
        const job = await db.admin.pool.query(
          `select 1 from lmc_jobs where tenant_id=$1 and lead_id=$2 and kind='send' and payload->>'messageId'=$3`,
          [h.tenantId, leadId, data.id],
        );
        check(
          lead.aiPaused === true &&
            message.rowCount === 1 &&
            job.rowCount === 1,
          `HTTP_HUMAN_QUEUE_NOT_PERSISTED:${label}`,
        );
      }
      if (target.route === "/api/lmc/settings") {
        const row = await db.admin.pool.query<{
          config: { tone: string };
          enabled: boolean;
        }>("select config,enabled from lmc_settings where tenant_id=$1", [
          h.tenantId,
        ]);
        check(
          row.rows[0]?.enabled === true &&
            row.rows[0].config.tone ===
              (label === "A" ? "friendly" : "concise"),
          `HTTP_SETTINGS_NOT_PERSISTED:${label}`,
        );
      }
      if (target.route.endsWith("/capture-token")) {
        const row = await db.admin.pool.query<{ hash: string }>(
          "select capture_token_hash as hash from lmc_settings where tenant_id=$1",
          [h.tenantId],
        );
        const previous = new URL(h.captureUrl).pathname.split("/").at(-1)!;
        check(
          !!data.captureToken &&
            !!row.rows[0] &&
            verifyReplyToken(data.captureToken, h.tenantId, row.rows[0].hash) &&
            !verifyReplyToken(previous, h.tenantId, row.rows[0].hash),
          `HTTP_CAPTURE_ROTATION_NOT_PERSISTED:${label}`,
        );
      }
    }
    // Valid owned writes are positive controls, with unchanged foreign state in both directions.
    const beforeA = await snapshot(a.tenantId),
      beforeB = await snapshot(b.tenantId);
    const ownA = await request(
      target.pathA,
      cookieA,
      a.tenantId,
      target.method,
      {},
      target.bodyA,
    );
    check(
      ownA.status === 200,
      `HTTP_MUTATION_OWN_A:${target.route}:${ownA.status}`,
    );
    const ownData = (await ownA.json()) as {
      id?: string;
      captureToken?: string;
    };
    await confirm(a, one.id, ownData, "A");
    const changedA = await snapshot(a.tenantId);
    check(
      changedA !== beforeA,
      `HTTP_MUTATION_OWN_A_NOT_PERSISTED:${target.route}`,
    );
    check(
      (await snapshot(b.tenantId)) === beforeB,
      `HTTP_MUTATION_OWN_A_CHANGED_B:${target.route}`,
    );
    const ownB = await request(
      target.pathB,
      cookieB,
      b.tenantId,
      target.method,
      {},
      target.bodyB,
    );
    check(
      ownB.status === 200,
      `HTTP_MUTATION_OWN_B:${target.route}:${ownB.status}`,
    );
    await confirm(
      b,
      other.id,
      (await ownB.json()) as { id?: string; captureToken?: string },
      "B",
    );
    check(
      (await snapshot(b.tenantId)) !== beforeB,
      `HTTP_MUTATION_OWN_B_NOT_PERSISTED:${target.route}`,
    );
    check(
      (await snapshot(a.tenantId)) === changedA,
      `HTTP_MUTATION_OWN_B_CHANGED_A:${target.route}`,
    );
    if (target.route.endsWith("/reply")) {
      const repeat = await request(
          target.pathA,
          cookieA,
          a.tenantId,
          target.method,
          {},
          target.bodyA,
        ),
        data = (await repeat.json()) as { id?: string };
      check(
        repeat.status === 200 &&
          !!ownData.id &&
          data.id === ownData.id &&
          (await snapshot(a.tenantId)) === changedA,
        "HTTP_HUMAN_REPLY_IDEMPOTENCY",
      );
    }
    if (target.route.endsWith("/capture-token"))
      check(
        typeof ownData.captureToken === "string" &&
          ownData.captureToken.length === 43,
        "HTTP_ROTATE_TOKEN_CONTROL",
      );
    const denied: Array<{
      label: string;
      path: string;
      cookie: string;
      tenant: string;
      expected: number;
      extra: Record<string, string>;
      body?: unknown;
    }> = [
      {
        label: "anonymous",
        path: target.pathB,
        cookie: "",
        tenant: b.tenantId,
        expected: 401,
        extra: {},
      },
      {
        label: "foreign-header",
        path: target.pathB,
        cookie: cookieA,
        tenant: b.tenantId,
        expected: 403,
        extra: { "x-user-id": b.ownerId, "x-actor-type": "system" },
      },
      {
        label: "foreign-query",
        path: `${target.pathB}?businessId=${b.tenantId}`,
        cookie: cookieA,
        tenant: a.tenantId,
        expected: 403,
        extra: {},
      },
      {
        label: "viewer",
        path: target.pathA,
        cookie: viewerCookie,
        tenant: a.tenantId,
        expected: 403,
        extra: {},
      },
      {
        label: "csrf",
        path: target.pathA,
        cookie: cookieA,
        tenant: a.tenantId,
        expected: 403,
        extra: { origin: "https://attacker.example.invalid" },
      },
      ...(target.route.includes("[leadId]")
        ? [
            {
              label: "foreign-resource",
              path: target.pathB,
              cookie: cookieA,
              tenant: a.tenantId,
              expected: 404,
              extra: {},
            },
          ]
        : []),
    ];
    if (target.route === "/api/lmc/settings") {
      denied.push(
        {
          label: "foreign-service",
          path: target.pathA,
          cookie: cookieA,
          tenant: a.tenantId,
          expected: 422,
          extra: {},
          body: {
            enabled: true,
            config: {
              ...settingsA.config,
              fromEmail: settingsA.senderEmail,
              services: settingsB.config.services,
            },
          },
        },
        {
          label: "foreign-sending-identity",
          path: target.pathA,
          cookie: cookieA,
          tenant: a.tenantId,
          expected: 422,
          extra: {},
          body: {
            enabled: true,
            config: {
              ...settingsA.config,
              fromEmail: "spoofed@example.invalid",
            },
          },
        },
      );
    }
    for (const attempt of denied) {
      const stableA = await snapshot(a.tenantId),
        stableB = await snapshot(b.tenantId);
      const response = await request(
        attempt.path,
        attempt.cookie,
        attempt.tenant,
        target.method,
        attempt.extra,
        attempt.body ?? target.bodyB,
      );
      const text = await response.text();
      check(
        response.status === attempt.expected && !text.includes(other.id),
        `HTTP_MUTATION_DENIAL:${target.route}:${attempt.label}:${response.status}`,
      );
      check(
        (await snapshot(a.tenantId)) === stableA &&
          (await snapshot(b.tenantId)) === stableB,
        `HTTP_MUTATION_SIDE_EFFECT:${target.route}:${attempt.label}`,
      );
    }
    for (const [path, tenant] of [
      [target.pathA, a.tenantId],
      [target.pathB, b.tenantId],
    ]) {
      const response = await request(path!, cookieA, tenant!, "OPTIONS"),
        allow = response.headers.get("allow") ?? "";
      check(
        response.status === 204 &&
          target.allow.every((method) =>
            allow.split(/,\s*/).includes(method),
          ) &&
          (await response.text()) === "",
        `HTTP_MUTATION_OPTIONS:${target.route}:${response.status}`,
      );
    }
    probed.push(`${target.method} ${target.route}`, `OPTIONS ${target.route}`);
  }
}

export function probeEmailMutationRoutes(baseUrl: string) {
  return withHttpAudit(baseUrl, probeEmailMutationContext);
}
