import { expect, it } from "vitest";
import { PILOT_ADMIN_ROUTES } from "@lobbystack/shared";
import { withHttpAudit } from "./support/isolation-http";
import { discoverPilotApiRoutes } from "./support/isolation-pilot-inventory";
import { probePilotMethodGuards } from "./support/isolation-pilot-guards";

it("probes every unsupported method with real A/B sessions and proves no scoped table changed", async () => {
  const routes = discoverPilotApiRoutes();
  const expected = routes.filter(route => route.surface === "admin").flatMap(route => {
    const policy = PILOT_ADMIN_ROUTES.find(policy => policy.pattern === route.path)!;
    return route.methods.filter(method => !policy.methods.includes(method)).map(method => `${method} ${route.path}`);
  });
  const report = await withHttpAudit(process.env.LMC_TEST_HTTP_BASE_URL ?? "http://localhost:3000", context => probePilotMethodGuards(context, routes));
  expect(report.failures).toEqual([]);
  expect(report.probed.sort()).toEqual(expected.sort());
  expect(report.probed.length).toBeGreaterThanOrEqual(145);
}, 120_000);
