import { discoverPilotApiRoutes } from "../tests/lmc/support/isolation-pilot-inventory";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { openLmcTestDatabase } from "../tests/lmc/support/database";
import {
  checkCatalogProtection,
  discoverApiRoutes,
  readIsolationCatalog,
} from "../tests/lmc/support/isolation-inventory";
async function main() {
  const output = process.argv[2];
  if (!output)
    throw new Error("An explicit inventory output path is required.");
  const db = openLmcTestDatabase();
  try {
    const catalog = await readIsolationCatalog(db),
      discoveredRoutes = discoverApiRoutes(),
      routes = discoverPilotApiRoutes(discoveredRoutes);
    const result = {
      generatedAt: new Date().toISOString(),
      auditScope: "pilot",
      ...catalog,
      routes,
      inheritedSourceRoutes: discoveredRoutes,
      structuralFailures: checkCatalogProtection(catalog),
      summary: {
        tables: catalog.tables.length,
        routes: routes.length,
        methods: routes.reduce((sum, route) => sum + route.methods.length, 0),
      },
    };
    writeFileSync(resolve(output), JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result.summary));
  } finally {
    await db.close();
  }
}
void main().catch(() => {
  console.error("ISOLATION_INVENTORY_FAILED");
  process.exitCode = 1;
});
