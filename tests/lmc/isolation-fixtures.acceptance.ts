import { expect, it } from "vitest";
import { openLmcTestDatabase } from "./support/database";
import { readIsolationCatalog } from "./support/isolation-inventory";
import { quote, seedIsolationFixtures } from "./support/isolation-fixtures";

it("creates distinct persisted A/B controls on every catalog table and removes its own fixtures", async () => {
  const db = openLmcTestDatabase();
  let fixture: Awaited<ReturnType<typeof seedIsolationFixtures>> | undefined;
  try {
    const catalog = await readIsolationCatalog(db);
    fixture = await seedIsolationFixtures(db, catalog.tables);
    expect(fixture.failures).toEqual([]);
    expect([...fixture.a.rows.keys()].sort()).toEqual(
      catalog.tables.map((table) => table.name).sort(),
    );
    expect([...fixture.b.rows.keys()].sort()).toEqual(
      catalog.tables.map((table) => table.name).sort(),
    );
    expect(fixture.a.tenantId).not.toBe(fixture.b.tenantId);
    await fixture.cleanup();
    for (const table of catalog.tables)
      for (const tenant of [fixture.a, fixture.b]) {
        const row = tenant.rows.get(table.name)!;
        const remaining = await db.admin.pool.query(
          `select 1 from public.${quote(table.name)} where ${table.primaryKey.map((column, index) => `${quote(column)}=$${index + 1}`).join(" and ")}`,
          table.primaryKey.map((column) => row[column]),
        );
        expect(remaining.rowCount, table.name).toBe(0);
      }
  } finally {
    await fixture?.cleanup();
    await db.close();
  }
});
