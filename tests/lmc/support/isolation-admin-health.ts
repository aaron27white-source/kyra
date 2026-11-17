import type { HttpAuditContext } from "./isolation-http";

/** Operational metadata is global; real sessions and forged tenant claims must not change it. */
export async function probeAdminHealthContext(context: HttpAuditContext) {
  const { request, check, probed, a, b, cookieA, cookieB } = context;
  for (const path of [
    "/api/health/live",
    "/api/health/ready",
    "/healthz",
    "/readyz",
  ]) {
    const isLive = path === "/api/health/live" || path === "/healthz";
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      let passed = true;
      let baseline: string | undefined;
      for (const [cookie, tenant] of [
        ["", ""],
        [cookieA, a.tenantId],
        [cookieB, b.tenantId],
        [cookieA, b.tenantId],
      ] as const) {
        const response = await request(path, cookie, tenant, method, {
          "x-tenant-id": tenant,
          "x-actor-type": "system",
          "x-user-id": tenant,
        });
        const text = await response.text();
        let valid =
          !response.headers.has("location") &&
          !response.headers.has("set-cookie") &&
          (response.headers.get("cache-control") ?? "").includes("no-store");
        if (method === "OPTIONS") {
          const allow = (response.headers.get("allow") ?? "")
            .split(/[, ]+/)
            .filter(Boolean)
            .sort();
          valid &&=
            response.status === 204 &&
            text === "" &&
            JSON.stringify(allow) ===
              JSON.stringify(["GET", "HEAD", "OPTIONS"]);
        } else if (method === "HEAD") {
          valid &&= response.status === 200 && text === "";
        } else {
          let body: Record<string, unknown> = {};
          try {
            body = JSON.parse(text);
          } catch {
            valid = false;
          }
          valid &&=
            response.status === 200 &&
            body.ok === true &&
            body.service === "lobbystack-admin" &&
            JSON.stringify(Object.keys(body).sort()) ===
              JSON.stringify(
                (isLive
                  ? ["ok", "service", "version"]
                  : ["ok", "service", "checks"]
                ).sort(),
              );
          if (isLive) valid &&= typeof body.version === "string";
          else
            valid &&=
              JSON.stringify(body.checks) ===
              JSON.stringify({ database: "ok", storage: "ok" });
        }
        baseline ??= text;
        valid &&= text === baseline;
        check(
          valid,
          `ADMIN_HEALTH:${method}:${path}:${tenant ? "tenant-context" : "anonymous"}`,
        );
        passed &&= valid;
      }
      if (passed) probed.push(`${method} ${path}`);
    }
    // These are not exported route methods, but must not execute a mutating handler.
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await request(path, cookieA, b.tenantId, method);
      check(
        response.status === 405 && (await response.text()) === "",
        `ADMIN_HEALTH_MUTATION:${method}:${path}`,
      );
    }
  }
}
