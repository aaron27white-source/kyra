import { expect, it } from "vitest";
import { probeEmailReadRoutes } from "./support/isolation-http";

it("uses real authenticated HTTP sessions for tenant A/B lead list and detail routes", async () => {
  const report = await probeEmailReadRoutes(
    process.env.LMC_TEST_HTTP_BASE_URL ?? "http://localhost:3000",
  );
  expect(report.failures).toEqual([]);
  expect(report.probed.sort()).toEqual(
    [
      "GET /api/leads",
      "HEAD /api/leads",
      "OPTIONS /api/leads",
      "GET /api/leads/[leadId]",
      "HEAD /api/leads/[leadId]",
      "OPTIONS /api/leads/[leadId]",
    ].sort(),
  );
}, 120_000);
