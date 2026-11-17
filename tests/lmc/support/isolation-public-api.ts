import { randomUUID } from "node:crypto";
import { withHttpAudit, type HttpAuditContext } from "./isolation-http";
import { readIsolationCatalog } from "./isolation-inventory";
import { quote } from "./isolation-fixtures";

type Key = { key: string; apiKey: { id: string; prefix: string } };
type Contact = { id: string; name: string | null; email: string | null };

export async function probePublicApiContext({
  db,
  base,
  a,
  b,
  cookieA,
  cookieB,
  request,
  login,
  check,
  probed,
}: HttpAuditContext) {
  const environment = await request("/api/lmc/settings", cookieA, a.tenantId);
  if (
    environment.status !== 200 ||
    ((await environment.json()) as { providerMode?: string }).providerMode !==
      "fake"
  )
    throw new Error("PUBLIC_AUDIT_REQUIRES_FAKE_SERVER_PROVIDERS");
  const methods = ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"];
  const catalog = await readIsolationCatalog(db);
  const scoped = catalog.tables.flatMap((table) => {
    const column =
      table.columns.find((column) => column.name === "tenant_id") ??
      table.columns.find((column) => column.name === "business_id");
    return column ? [{ table: table.name, column: column.name }] : [];
  });
  async function snapshot(tenant: string, touchKey?: string) {
    const selects = scoped.map(({ table, column }) => {
      const value =
        table === "api_keys"
          ? "case when t.id=$2::uuid then to_jsonb(t)-'last_used_at' else to_jsonb(t) end"
          : "to_jsonb(t)";
      return `select '${table.replaceAll("'", "''")}' as name,coalesce(jsonb_agg(v order by v::text),'[]'::jsonb) as rows from (select ${value} as v from public.${quote(table)} t where ${quote(column)}=$1) s`;
    });
    const rows = await db.admin.pool.query(
      `select jsonb_object_agg(name,rows order by name) as state from (${selects.join(" union all ")}) all_tables`,
      [tenant, touchKey ?? null],
    );
    return JSON.stringify(rows.rows[0]?.state);
  }
  const keys: Key[] = [];
  async function issue(
    cookie: string,
    tenant: string,
    scopes: string[],
    name: string,
  ) {
    const response = await request(
      "/api/api-keys",
      cookie,
      tenant,
      "POST",
      {},
      { name, scopes },
    );
    if (response.status !== 201)
      throw new Error(`PUBLIC_API_KEY_CONTROL:${response.status}`);
    const result = (await response.json()) as Key;
    if (!result.key || !result.apiKey?.id)
      throw new Error("PUBLIC_API_KEY_CONTROL_SHAPE");
    const stored = await db.admin.pool.query<{
      key_hash: string;
      business_id: string;
    }>("select key_hash,business_id from api_keys where id=$1", [
      result.apiKey.id,
    ]);
    check(
      stored.rows[0]?.business_id === tenant &&
        stored.rows[0]?.key_hash !== result.key &&
        stored.rows[0]?.key_hash.length === 64,
      "PUBLIC_API_KEY_HASH_STORAGE",
    );
    keys.push(result);
    return result;
  }
  const ka = await issue(
    cookieA,
    a.tenantId,
    ["business:read", "business:write", "contacts:read", "contacts:write"],
    "Public fixture A",
  );
  const kb = await issue(
    cookieB,
    b.tenantId,
    ["business:read", "business:write", "contacts:read", "contacts:write"],
    "Public fixture B",
  );
  const narrow = await issue(
    cookieA,
    a.tenantId,
    ["business:read"],
    "Public read scope fixture",
  );
  const viewerId = await a.addViewer(),
    viewerCookie = await login({ ...a, ownerId: viewerId });
  async function api(
    path: string,
    key = "",
    method = "GET",
    body?: unknown,
    extra: Record<string, string> = {},
  ) {
    const known = keys.find((candidate) => candidate.key === key),
      started = Date.now();
    const before = known
      ? await db.admin.pool.query<{ last_used_at: Date | null }>(
          "select last_used_at from api_keys where id=$1",
          [known.apiKey.id],
        )
      : undefined;
    const response = await fetch(new URL(path, base), {
      method,
      headers: {
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    // The real after-response last-used write is expected only on this presented key.
    // Settle it before snapshots; it must never be mistaken for a business mutation.
    if (
      known &&
      [200, 201, 400, 404, 409, 422].includes(response.status) &&
      (!before?.rows[0]?.last_used_at ||
        before.rows[0].last_used_at.getTime() <= started - 60_000)
    ) {
      await response.clone().arrayBuffer();
      let settled = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const row = await db.admin.pool.query<{ last_used_at: Date | null }>(
          "select last_used_at from api_keys where id=$1",
          [known.apiKey.id],
        );
        if (
          row.rows[0]?.last_used_at &&
          row.rows[0].last_used_at.getTime() >= started - 10
        ) {
          settled = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      check(settled, "PUBLIC_API_LAST_USED_CONTROL");
    }
    return response;
  }
  // Dashboard keys are private, tenant-scoped and never disclose plaintext after issuance.
  for (const method of ["GET", "HEAD"]) {
    for (const [cookie, tenant, own, foreign] of [
      [cookieA, a.tenantId, ka, kb],
      [cookieB, b.tenantId, kb, ka],
    ] as const) {
      const response = await request("/api/api-keys", cookie, tenant, method),
        text = await response.text();
      check(
        response.status === 200 &&
          response.headers.get("cache-control")?.includes("no-store") === true,
        `KEY_LIST_CONTROL:${method}`,
      );
      if (method === "GET")
        check(
          text.includes(own.apiKey.id) &&
            !text.includes(foreign.apiKey.id) &&
            keys.every((key) => !text.includes(key.key)) &&
            !text.includes("keyHash") &&
            !text.includes("key_hash"),
          "KEY_LIST_PRIVATE_CONTENT",
        );
    }
    for (const [cookie, tenant, path, expected] of [
      ["", a.tenantId, "/api/api-keys", 401],
      [viewerCookie, a.tenantId, "/api/api-keys", 403],
      [cookieA, b.tenantId, "/api/api-keys", 403],
      [cookieA, a.tenantId, `/api/api-keys?businessId=${b.tenantId}`, 403],
    ] as const) {
      const response = await request(path, cookie, tenant, method);
      check(
        response.status === expected,
        `KEY_LIST_DENIAL:${method}:${response.status}`,
      );
      await response.arrayBuffer();
    }
    probed.push(`${method} /api/api-keys`);
  }
  for (const attempt of [
    {
      label: "anonymous",
      cookie: "",
      tenant: a.tenantId,
      path: "/api/api-keys",
      extra: {},
      status: 401,
    },
    {
      label: "viewer",
      cookie: viewerCookie,
      tenant: a.tenantId,
      path: "/api/api-keys",
      extra: {},
      status: 403,
    },
    {
      label: "foreign-header",
      cookie: cookieA,
      tenant: b.tenantId,
      path: "/api/api-keys",
      extra: {},
      status: 403,
    },
    {
      label: "foreign-query",
      cookie: cookieA,
      tenant: a.tenantId,
      path: `/api/api-keys?businessId=${b.tenantId}`,
      extra: {},
      status: 403,
    },
    {
      label: "csrf",
      cookie: cookieA,
      tenant: a.tenantId,
      path: "/api/api-keys",
      extra: { origin: "https://attacker.example.invalid" },
      status: 403,
    },
  ] as Array<{
    label: string;
    cookie: string;
    tenant: string;
    path: string;
    extra: Record<string, string>;
    status: number;
  }>) {
    const beforeA = await snapshot(a.tenantId),
      beforeB = await snapshot(b.tenantId);
    const response = await request(
      attempt.path,
      attempt.cookie,
      attempt.tenant,
      "POST",
      attempt.extra,
      { name: "Unauthorized key", scopes: ["contacts:read"] },
    );
    check(
      response.status === attempt.status,
      `KEY_CREATE_DENIAL:${attempt.label}:${response.status}`,
    );
    await response.arrayBuffer();
    check(
      (await snapshot(a.tenantId)) === beforeA &&
        (await snapshot(b.tenantId)) === beforeB,
      `KEY_CREATE_SIDE_EFFECT:${attempt.label}`,
    );
  }
  probed.push("POST /api/api-keys");
  const optionKeys = await request(
    "/api/api-keys",
    cookieA,
    b.tenantId,
    "OPTIONS",
  );
  check(
    optionKeys.status === 204 &&
      (await optionKeys.text()) === "" &&
      ["GET", "HEAD", "POST", "OPTIONS"].every((method) =>
        (optionKeys.headers.get("allow") ?? "").split(/,\s*/).includes(method),
      ),
    "KEY_OPTIONS_METADATA",
  );
  probed.push("OPTIONS /api/api-keys");

  async function create(key: Key, tenant: string, email: string, name: string) {
    const beforeOther = await snapshot(
        tenant === a.tenantId ? b.tenantId : a.tenantId,
        key.apiKey.id,
      ),
      idempotency = randomUUID();
    const response = await api(
      "/api/v1/contacts",
      key.key,
      "POST",
      { email, name },
      { "idempotency-key": idempotency },
    );
    if (response.status !== 201)
      throw new Error(`PUBLIC_CONTACT_CREATE_CONTROL:${response.status}`);
    const text = await response.text(),
      result = JSON.parse(text) as { data: Contact };
    const stored = await db.admin.pool.query<{
      business_id: string;
      name: string;
    }>("select business_id,name from contacts where id=$1", [result.data.id]);
    check(
      stored.rows[0]?.business_id === tenant && stored.rows[0]?.name === name,
      "PUBLIC_CONTACT_CREATE_STORAGE",
    );
    const replay = await api(
      "/api/v1/contacts",
      key.key,
      "POST",
      { email, name },
      { "idempotency-key": idempotency },
    );
    check(
      replay.status === 201 &&
        (await replay.text()) === text &&
        replay.headers.get("idempotent-replayed") === "true",
      "PUBLIC_CONTACT_IDEMPOTENCY",
    );
    const conflict = await api(
      "/api/v1/contacts",
      key.key,
      "POST",
      { email, name: "Changed request" },
      { "idempotency-key": idempotency },
    );
    check(conflict.status === 422, "PUBLIC_CONTACT_IDEMPOTENCY_CONFLICT");
    await conflict.arrayBuffer();
    check(
      (await snapshot(
        tenant === a.tenantId ? b.tenantId : a.tenantId,
        key.apiKey.id,
      )) === beforeOther,
      "PUBLIC_CONTACT_CREATE_CHANGED_FOREIGN",
    );
    return result.data;
  }
  const ca = await create(
      ka,
      a.tenantId,
      "api-a@example.invalid",
      "API private contact A",
    ),
    cb = await create(
      kb,
      b.tenantId,
      "api-b@example.invalid",
      "API private contact B",
    );
  const serviceA = (
    await db.admin.pool.query<{ id: string }>(
      "select id from services where business_id=$1",
      [a.tenantId],
    )
  ).rows[0]!.id;
  const serviceB = (
    await db.admin.pool.query<{ id: string }>(
      "select id from services where business_id=$1",
      [b.tenantId],
    )
  ).rows[0]!.id;
  const staffA = (
    await db.admin.pool.query<{ id: string }>(
      "select id from staff where business_id=$1",
      [a.tenantId],
    )
  ).rows[0]!.id;
  const staffB = (
    await db.admin.pool.query<{ id: string }>(
      "select id from staff where business_id=$1",
      [b.tenantId],
    )
  ).rows[0]!.id;
  const targets = [
    {
      route: "/api/v1/contacts",
      pathA: "/api/v1/contacts",
      pathB: "/api/v1/contacts",
      own: ca.id,
      foreign: cb.id,
      allowed: ["GET", "POST"],
    },
    {
      route: "/api/v1/contacts/[contact_id]",
      pathA: `/api/v1/contacts/${ca.id}`,
      pathB: `/api/v1/contacts/${cb.id}`,
      own: ca.id,
      foreign: cb.id,
      allowed: ["GET", "PATCH"],
    },
    {
      route: "/api/v1/services",
      pathA: "/api/v1/services",
      pathB: "/api/v1/services",
      own: serviceA,
      foreign: serviceB,
      allowed: ["GET"],
    },
    {
      route: "/api/v1/staff",
      pathA: "/api/v1/staff",
      pathB: "/api/v1/staff",
      own: staffA,
      foreign: staffB,
      allowed: ["GET"],
    },
    {
      route: "/api/v1/me",
      pathA: "/api/v1/me",
      pathB: "/api/v1/me",
      own: a.tenantId,
      foreign: b.tenantId,
      allowed: ["GET"],
    },
    {
      route: "/api/v1/business",
      pathA: "/api/v1/business",
      pathB: "/api/v1/business",
      own: a.tenantId,
      foreign: b.tenantId,
      allowed: ["GET", "PATCH"],
    },
  ];
  for (const target of targets) {
    for (const [key, path, own, foreign] of [
      [ka, target.pathA, target.own, target.foreign],
      [kb, target.pathB, target.foreign, target.own],
    ] as const) {
      const response = await api(path, key.key),
        text = await response.text();
      check(
        response.status === 200 &&
          text.includes(own) &&
          !text.includes(foreign) &&
          response.headers.get("cache-control")?.includes("no-store") === true,
        `PUBLIC_READ_CONTROL:${target.route}`,
      );
    }
    for (const method of ["GET", "HEAD"]) {
      const own = await api(target.pathA, ka.key, method);
      check(own.status === 200, `PUBLIC_OWN_METHOD:${method}:${target.route}`);
      await own.arrayBuffer();
      const anonymous = await api(target.pathA, "", method);
      check(
        anonymous.status === 401,
        `PUBLIC_ANONYMOUS:${method}:${target.route}`,
      );
      await anonymous.arrayBuffer();
      const cookieOnly = await api(target.pathA, "", method, undefined, {
        cookie: cookieA,
      });
      check(
        cookieOnly.status === 401,
        `PUBLIC_COOKIE_AUTH_REJECTED:${method}:${target.route}`,
      );
      await cookieOnly.arrayBuffer();
      const foreign = await api(
          `${target.pathB}?businessId=${b.tenantId}&business_id=${b.tenantId}`,
          ka.key,
          method,
          undefined,
          {
            cookie: cookieB,
            "x-business-id": b.tenantId,
            "x-user-id": b.ownerId,
            "x-actor-type": "system",
          },
        ),
        text = await foreign.text();
      check(
        foreign.status ===
          (target.route.includes("[contact_id]") ? 404 : 200) &&
          !text.includes(target.foreign),
        `PUBLIC_FOREIGN_CONTEXT:${method}:${target.route}:${foreign.status}`,
      );
      const scopedResponse = await api(target.pathA, narrow.key, method);
      check(
        scopedResponse.status ===
          (target.route.startsWith("/api/v1/contacts") ? 403 : 200),
        `PUBLIC_SCOPE_BOUNDARY:${method}:${target.route}`,
      );
      await scopedResponse.arrayBuffer();
      probed.push(`${method} ${target.route}`);
    }
    for (const method of methods.filter(
      (method) => ![...target.allowed, "HEAD", "OPTIONS"].includes(method),
    )) {
      const beforeA = await snapshot(a.tenantId),
        beforeB = await snapshot(b.tenantId);
      for (const key of ["", ka.key, kb.key]) {
        const response = await api(target.pathA, key, method, {
            name: "Forbidden method",
          }),
          text = await response.text();
        const expectedAllow = [...target.allowed, "HEAD", "OPTIONS"].sort();
        check(
          response.status === 405 &&
            text.includes("method_not_allowed") &&
            JSON.stringify(
              (response.headers.get("allow") ?? "").split(/,\s*/).sort(),
            ) === JSON.stringify(expectedAllow),
          `PUBLIC_UNSUPPORTED:${method}:${target.route}:${response.status}`,
        );
      }
      check(
        (await snapshot(a.tenantId)) === beforeA &&
          (await snapshot(b.tenantId)) === beforeB,
        `PUBLIC_UNSUPPORTED_SIDE_EFFECT:${method}:${target.route}`,
      );
      probed.push(`${method} ${target.route}`);
    }
    const options = await api(target.pathA, "", "OPTIONS");
    check(
      options.status === 204 &&
        (await options.text()) === "" &&
        [...target.allowed, "HEAD", "OPTIONS"].every((method) =>
          (options.headers.get("allow") ?? "").split(/,\s*/).includes(method),
        ),
      `PUBLIC_OPTIONS:${target.route}`,
    );
    probed.push(`OPTIONS ${target.route}`);
  }
  // Supported PATCH writes and all rejected writes use constraint-valid payloads.
  for (const [key, tenant, contact, otherTenant] of [
    [ka, a.tenantId, ca, b.tenantId],
    [kb, b.tenantId, cb, a.tenantId],
  ] as const) {
    const beforeOther = await snapshot(otherTenant, key.apiKey.id),
      name = `Updated ${contact.name}`;
    const response = await api(
      `/api/v1/contacts/${contact.id}`,
      key.key,
      "PATCH",
      { name },
    );
    check(response.status === 200, "PUBLIC_PATCH_CONTROL");
    await response.arrayBuffer();
    const row = await db.admin.pool.query<{ name: string }>(
      "select name from contacts where id=$1 and business_id=$2",
      [contact.id, tenant],
    );
    check(
      row.rows[0]?.name === name &&
        (await snapshot(otherTenant, key.apiKey.id)) === beforeOther,
      "PUBLIC_PATCH_STORAGE",
    );
  }
  for (const [key, tenant, otherTenant] of [
    [ka, a.tenantId, b.tenantId],
    [kb, b.tenantId, a.tenantId],
  ] as const) {
    const stableOther = await snapshot(otherTenant, key.apiKey.id),
      name = `API business ${tenant}`;
    const response = await api(
      `/api/v1/business?businessId=${otherTenant}&business_id=${otherTenant}`,
      key.key,
      "PATCH",
      { name },
      { "x-business-id": otherTenant },
    );
    check(response.status === 200, "PUBLIC_BUSINESS_PATCH_CONTROL");
    await response.arrayBuffer();
    const row = await db.admin.pool.query<{ name: string }>(
      "select name from businesses where id=$1",
      [tenant],
    );
    const queue = await db.admin.pool.query(
      "select 1 from outbox_messages where business_id=$1 and topic='snapshot.refresh' and payload->>'businessId'=$1::text",
      [tenant],
    );
    check(
      row.rows[0]?.name === name &&
        queue.rowCount === 1 &&
        (await snapshot(otherTenant, key.apiKey.id)) === stableOther,
      "PUBLIC_BUSINESS_PATCH_STORAGE",
    );
  }
  const denials: Array<{
    path: string;
    method: string;
    key: string;
    keyId?: string;
    body: unknown;
    status: number;
    label: string;
    extra?: Record<string, string>;
  }> = [
    {
      label: "foreign-id",
      path: `/api/v1/contacts/${cb.id}`,
      method: "PATCH",
      key: ka.key,
      keyId: ka.apiKey.id,
      body: { name: "Foreign overwrite" },
      status: 404,
      extra: { "x-business-id": b.tenantId, cookie: cookieB },
    },
    {
      label: "foreign-id-reverse",
      path: `/api/v1/contacts/${ca.id}`,
      method: "PATCH",
      key: kb.key,
      keyId: kb.apiKey.id,
      body: { name: "Foreign reverse overwrite" },
      status: 404,
    },
    {
      label: "missing-scope-patch",
      path: `/api/v1/contacts/${ca.id}`,
      method: "PATCH",
      key: narrow.key,
      body: { name: "Scope overwrite" },
      status: 403,
    },
    {
      label: "missing-scope-create",
      path: "/api/v1/contacts",
      method: "POST",
      key: narrow.key,
      body: { email: "no-scope@example.invalid" },
      status: 403,
    },
    {
      label: "business-write-scope",
      path: "/api/v1/business",
      method: "PATCH",
      key: narrow.key,
      body: { name: "Scope business overwrite" },
      status: 403,
    },
    {
      label: "business-body-tenant",
      path: "/api/v1/business",
      method: "PATCH",
      key: ka.key,
      keyId: ka.apiKey.id,
      body: { name: "Business reassignment", business_id: b.tenantId },
      status: 400,
    },
    {
      label: "business-cookie-only",
      path: "/api/v1/business",
      method: "PATCH",
      key: "",
      body: { name: "Cookie business overwrite" },
      status: 401,
      extra: { cookie: cookieA },
    },
    {
      label: "tampered-key",
      path: "/api/v1/contacts",
      method: "POST",
      key: ka.key.slice(0, -1) + (ka.key.endsWith("x") ? "y" : "x"),
      body: { email: "tampered-key@example.invalid" },
      status: 401,
    },
    {
      label: "anonymous-patch",
      path: `/api/v1/contacts/${ca.id}`,
      method: "PATCH",
      key: "",
      body: { name: "Anonymous overwrite" },
      status: 401,
    },
    {
      label: "anonymous-create",
      path: "/api/v1/contacts",
      method: "POST",
      key: "",
      body: { email: "anonymous@example.invalid" },
      status: 401,
    },
    {
      label: "cookie-only-create",
      path: "/api/v1/contacts",
      method: "POST",
      key: "",
      body: { email: "cookie@example.invalid" },
      status: 401,
      extra: { cookie: cookieA },
    },
    {
      label: "body-tenant-create",
      path: "/api/v1/contacts",
      method: "POST",
      key: ka.key,
      keyId: ka.apiKey.id,
      body: { email: "injected@example.invalid", business_id: b.tenantId },
      status: 400,
    },
    {
      label: "body-tenant-patch",
      path: `/api/v1/contacts/${ca.id}`,
      method: "PATCH",
      key: ka.key,
      keyId: ka.apiKey.id,
      body: { name: "Tenant reassignment", business_id: b.tenantId },
      status: 400,
    },
  ];
  for (const attempt of denials) {
    const beforeA = await snapshot(a.tenantId, attempt.keyId),
      beforeB = await snapshot(b.tenantId, attempt.keyId);
    const response = await api(
        attempt.path,
        attempt.key,
        attempt.method,
        attempt.body,
        attempt.extra,
      ),
      text = await response.text();
    check(
      response.status === attempt.status && !text.includes(cb.id),
      `PUBLIC_MUTATION_DENIAL:${attempt.label}:${response.status}`,
    );
    check(
      (await snapshot(a.tenantId, attempt.keyId)) === beforeA &&
        (await snapshot(b.tenantId, attempt.keyId)) === beforeB,
      `PUBLIC_MUTATION_SIDE_EFFECT:${attempt.label}`,
    );
  }
  probed.push(
    "POST /api/v1/contacts",
    "PATCH /api/v1/contacts/[contact_id]",
    "PATCH /api/v1/business",
  );

  for (const [cookie, tenant, path, status, label] of [
    [cookieA, a.tenantId, `/api/api-keys/${kb.apiKey.id}`, 404, "foreign-id"],
    [
      cookieA,
      b.tenantId,
      `/api/api-keys/${kb.apiKey.id}`,
      403,
      "foreign-header",
    ],
    [
      cookieA,
      a.tenantId,
      `/api/api-keys/${kb.apiKey.id}?businessId=${b.tenantId}`,
      403,
      "foreign-query",
    ],
    [viewerCookie, a.tenantId, `/api/api-keys/${ka.apiKey.id}`, 403, "viewer"],
    ["", a.tenantId, `/api/api-keys/${ka.apiKey.id}`, 401, "anonymous"],
  ] as const) {
    const beforeA = await snapshot(a.tenantId),
      beforeB = await snapshot(b.tenantId);
    const response = await request(path, cookie, tenant, "DELETE");
    check(
      response.status === status,
      `KEY_REVOKE_DENIAL:${label}:${response.status}`,
    );
    await response.arrayBuffer();
    check(
      (await snapshot(a.tenantId)) === beforeA &&
        (await snapshot(b.tenantId)) === beforeB,
      `KEY_REVOKE_SIDE_EFFECT:${label}`,
    );
  }
  {
    const stableA = await snapshot(a.tenantId),
      stableB = await snapshot(b.tenantId);
    const response = await request(
      `/api/api-keys/${ka.apiKey.id}`,
      cookieA,
      a.tenantId,
      "DELETE",
      { origin: "https://attacker.example.invalid" },
    );
    check(response.status === 403, "KEY_REVOKE_CSRF_DENIAL");
    await response.arrayBuffer();
    check(
      (await snapshot(a.tenantId)) === stableA &&
        (await snapshot(b.tenantId)) === stableB,
      "KEY_REVOKE_CSRF_SIDE_EFFECT",
    );
  }
  for (const [cookie, tenant, key, foreignTenant] of [
    [cookieA, a.tenantId, ka, b.tenantId],
    [cookieB, b.tenantId, kb, a.tenantId],
  ] as const) {
    const beforeOther = await snapshot(foreignTenant),
      path = `/api/api-keys/${key.apiKey.id}`;
    const response = await request(path, cookie, tenant, "DELETE");
    check(response.status === 200, "KEY_REVOKE_CONTROL");
    await response.arrayBuffer();
    const stored = await db.admin.pool.query<{
      revoked_at: Date | null;
      revoked_by_user_id: string | null;
    }>("select revoked_at,revoked_by_user_id from api_keys where id=$1", [
      key.apiKey.id,
    ]);
    check(
      !!stored.rows[0]?.revoked_at &&
        stored.rows[0].revoked_by_user_id ===
          (tenant === a.tenantId ? a.ownerId : b.ownerId),
      "KEY_REVOKE_STORAGE",
    );
    check(
      (await snapshot(foreignTenant)) === beforeOther,
      "KEY_REVOKE_CHANGED_FOREIGN",
    );
    const rejected = await api("/api/v1/contacts", key.key);
    check(rejected.status === 401, "KEY_REVOKED_AUTH_REJECTED");
    await rejected.arrayBuffer();
    const stable = await snapshot(tenant),
      repeat = await request(path, cookie, tenant, "DELETE");
    check(repeat.status === 200, "KEY_REVOKE_REPLAY");
    await repeat.arrayBuffer();
    check((await snapshot(tenant)) === stable, "KEY_REVOKE_REPLAY_SIDE_EFFECT");
    const options = await request(path, cookie, foreignTenant, "OPTIONS");
    check(
      options.status === 204 &&
        (await options.text()) === "" &&
        (options.headers.get("allow") ?? "").includes("DELETE"),
      "KEY_REVOKE_OPTIONS",
    );
  }
  probed.push(
    "DELETE /api/api-keys/[apiKeyId]",
    "OPTIONS /api/api-keys/[apiKeyId]",
  );
}

export function probePublicApiResources(baseUrl: string) {
  return withHttpAudit(baseUrl, probePublicApiContext);
}
