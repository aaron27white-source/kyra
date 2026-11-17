import { expect, it } from "vitest";
import { openLmcTestDatabase } from "./support/database";
import {
  discoverApiRoutes,
  readIsolationCatalog,
  checkCatalogProtection,
} from "./support/isolation-inventory";

it("discovers application tables independently from the live catalog and checks effective runtime logins", async () => {
  const db = openLmcTestDatabase();
  try {
    const catalog = await readIsolationCatalog(db);
    expect(catalog.tables.length).toBeGreaterThanOrEqual(88);
    expect(new Set(catalog.tables.map((table) => table.name)).size).toBe(
      catalog.tables.length,
    );
    expect(checkCatalogProtection(catalog)).toEqual([]);
    expect(catalog.logins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expected: "lobbystack_system",
          actual: "lobbystack_system",
          superuser: false,
          bypassRls: false,
        }),
        expect.objectContaining({
          expected: "lobbystack_app",
          actual: "lobbystack_app",
          superuser: false,
          bypassRls: false,
        }),
        expect.objectContaining({
          expected: "lobbystack_worker",
          actual: "lobbystack_worker",
          superuser: false,
          bypassRls: false,
        }),
        expect.objectContaining({
          expected: "lobbystack_dispatcher",
          actual: "lobbystack_dispatcher",
          superuser: false,
          bypassRls: false,
        }),
      ]),
    );
    const routes = discoverApiRoutes();
    expect(routes.length).toBeGreaterThan(100);
    expect(
      routes.find((route) => route.path === "/api/leads/[leadId]/reply")
        ?.methods,
    ).toContain("POST");
    expect(
      routes.find((route) => route.path === "/api/auth/[...all]")?.methods,
    ).toEqual(expect.arrayContaining(["GET", "POST"]));
    expect(routes.every((route) => route.methods.length > 0)).toBe(true);
  } finally {
    await db.close();
  }
});
it("rejects a newly introduced unprotected table or a privileged runtime login", () => {
  const table = {
    name: "new_unprotected_table",
    rls: false,
    forced: false,
    policies: [],
    columns: [],
    foreignKeys: [],
    primaryKey: [],
    checks: [],
  };
  const failures = checkCatalogProtection({
    tables: [table],
    logins: [
      {
        expected: "lobbystack_app",
        actual: "postgres",
        superuser: true,
        bypassRls: true,
      },
    ],
    roles: [],
    appElevations: ["lobbystack_system"],
  });
  expect(failures).toEqual(
    expect.arrayContaining([
      expect.stringContaining("new_unprotected_table"),
      expect.stringContaining("lobbystack_app"),
      "APP_ROLE_ELEVATION:lobbystack_system",
      "MISSING_RUNTIME_ROLE:lobbystack_system",
    ]),
  );
});
