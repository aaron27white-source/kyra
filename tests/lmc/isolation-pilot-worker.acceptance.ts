import { expect, it } from "vitest";
import { discoverPilotApiRoutes } from "./support/isolation-pilot-inventory";
import { auditRouteId } from "./support/isolation-inventory";
import { probePilotWorker } from "./support/isolation-pilot-worker";

it("probes all pilot worker methods, missing-dependency readiness, forged tenants and blocked private routing", async () => {
  const routes = discoverPilotApiRoutes().filter(route => route.surface === "worker");
  const report = await probePilotWorker(routes);
  expect(report.failures).toEqual([]);
  expect(report.probed.sort()).toEqual(routes.flatMap(route => route.methods.map(method => auditRouteId(route, method))).sort());
  expect(report.probed).toHaveLength(28);
});
