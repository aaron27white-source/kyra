import { expect, it } from "vitest";
import { openLmcTestDatabase } from "./support/database";
import { readIsolationCatalog } from "./support/isolation-inventory";
import { probeTableInserts } from "./support/isolation-inserts";

it("proves each cross-tenant INSERT payload is valid before testing app-role denial on every table", async () => {
  const db = openLmcTestDatabase();
  try {
    const catalog = await readIsolationCatalog(db);
    const result = await probeTableInserts(db, catalog.tables);
    expect(result.failures).toEqual([]);
    expect(result.probed.sort()).toEqual(
      catalog.tables.map((table) => table.name).sort(),
    );
  } finally {
    await db.close();
  }
}, 60_000);
