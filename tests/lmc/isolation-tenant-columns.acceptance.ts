import { expect, it } from "vitest";
import { openLmcTestDatabase } from "./support/database";
import { readIsolationCatalog } from "./support/isolation-inventory";
import { quote, seedIsolationFixtures } from "./support/isolation-fixtures";

it("requires a non-null immutable tenant identity on every directly business-owned legacy table", async () => {
  const db = openLmcTestDatabase();
  let fixtures: Awaited<ReturnType<typeof seedIsolationFixtures>> | undefined;
  try {
    const catalog = await readIsolationCatalog(db);
    const owned = catalog.tables.filter(
      (table) =>
        table.name === "businesses" ||
        table.columns.some(
          (column) => column.name === "business_id" && !column.nullable,
        ),
    );
    expect(owned.length).toBeGreaterThan(50);
    const missing = owned.filter((table) => {
      const tenant = table.columns.find(
        (column) => column.name === "tenant_id",
      );
      return (
        !tenant ||
        tenant.nullable ||
        tenant.generated !== "s" ||
        tenant.default !== (table.name === "businesses" ? "id" : "business_id")
      );
    });
    expect(missing.map((table) => table.name)).toEqual([]);
    fixtures = await seedIsolationFixtures(db, catalog.tables);
    expect(fixtures.failures).toEqual([]);
    const client = await db.admin.pool.connect();
    try {
      await client.query("begin");
      for (const table of owned) {
        expect(table.rls && table.forced && table.policies.length > 0).toBe(
          true,
        );
        for (const context of [fixtures.a, fixtures.b])
          expect(context.rows.get(table.name)?.tenant_id).toBe(
            context.tenantId,
          );
        const row = fixtures.a.rows.get(table.name)!;
        const predicate = table.primaryKey
          .map((key, index) => `${quote(key)}=$${index + 2}`)
          .join(" and ");
        await client.query("savepoint identity_probe");
        let code = "";
        try {
          await client.query(
            `update public.${quote(table.name)} set tenant_id=$1 where ${predicate}`,
            [fixtures.b.tenantId, ...table.primaryKey.map((key) => row[key])],
          );
        } catch (error) {
          code = String((error as { code?: string }).code ?? "UNKNOWN");
        } finally {
          await client.query("rollback to savepoint identity_probe");
          await client.query("release savepoint identity_probe");
        }
        expect(code, table.name).toBe("428C9");
      }
    } finally {
      await client.query("rollback");
      client.release();
    }
  } finally {
    try {
      await fixtures?.cleanup();
    } finally {
      await db.close();
    }
  }
});
