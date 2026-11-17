import { describe, expect, it } from "vitest";
import { runTenantIsolationAudit } from "./support/isolation-audit";

describe("LMC exhaustive tenant-isolation acceptance", () => {
  it("m: probes every application table and every allowlisted pilot API method against tenant A and tenant B", async () => {
    // Inventory comes independently from pg_catalog and filesystem route discovery.
    // A skipped probe, an unclassified route or an unseeded table is a failure.
    const report = await runTenantIsolationAudit();
    expect(report.auditScope).toBe("pilot");
    expect(report.tableInventory.length).toBeGreaterThanOrEqual(88);
    expect(report.routeInventory.length).toBeGreaterThanOrEqual(238);
    expect([...report.probedTables].sort()).toEqual([...report.tableInventory].sort());
    const unprobedRoutes = report.routeInventory.filter((route) => !report.probedRoutes.includes(route));
    for (const route of unprobedRoutes) {
      const safeRouteId = route.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").toUpperCase();
      expect(false, `PILOT_UNPROBED_${safeRouteId}`).toBe(true);
    }
    expect([...report.probedRoutes].sort(), `Unprobed pilot API methods: ${unprobedRoutes.join(", ")}`).toEqual([...report.routeInventory].sort());
    expect(report.skipped).toEqual([]);
    expect(report.failures, report.failures.join("\n")).toEqual([]);
    expect(report.runtimeRoles.every((role) => !role.superuser && !role.bypassRls)).toBe(true);
  // This deliberately executes the complete table and route inventory. Keep
  // the assertions exhaustive, but allow slower containerized CI runners to
  // finish instead of failing a few milliseconds beyond the old 120s limit.
  }, 180_000);
});
