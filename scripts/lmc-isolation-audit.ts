import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runTenantIsolationAudit } from "../tests/lmc/support/isolation-audit";

async function main() {
  const output = process.argv[2];
  if (!output) throw new Error("An explicit audit output path is required.");
  const report = await runTenantIsolationAudit();
  writeFileSync(
    resolve(output),
    JSON.stringify(
      { generatedAt: new Date().toISOString(), ...report },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({
      tables: report.tableInventory.length,
      probedTables: report.probedTables.length,
      methods: report.routeInventory.length,
      probedMethods: report.probedRoutes.length,
      uncovered: report.skipped.length,
      uncoveredMethods: report.skipped.filter((value) =>
        value.startsWith("UNPROBED_ROUTE:"),
      ).length,
      pendingHttpSurfaces: report.pendingHttpSurfaces,
      failures: report.failures.length,
    }),
  );
  if (report.skipped.length || report.failures.length) process.exitCode = 1;
}
void main().catch(() => {
  console.error("ISOLATION_AUDIT_FAILED");
  process.exitCode = 1;
});
