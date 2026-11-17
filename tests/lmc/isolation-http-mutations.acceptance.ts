import { expect, it } from "vitest";
import { probeEmailMutationRoutes } from "./support/isolation-http";

it("proves real tenant writes succeed and foreign, viewer and CSRF attempts cannot persist changes", async () => {
  const report = await probeEmailMutationRoutes(
    process.env.LMC_TEST_HTTP_BASE_URL ?? "http://localhost:3000",
  );
  expect(report.failures).toEqual([]);
  expect(report.probed.sort()).toEqual(
    [
      "POST /api/leads/[leadId]/reply",
      "OPTIONS /api/leads/[leadId]/reply",
      "PATCH /api/leads/[leadId]/automation",
      "OPTIONS /api/leads/[leadId]/automation",
      "GET /api/lmc/settings",
      "HEAD /api/lmc/settings",
      "PUT /api/lmc/settings",
      "OPTIONS /api/lmc/settings",
      "POST /api/lmc/settings/capture-token",
      "OPTIONS /api/lmc/settings/capture-token",
    ].sort(),
  );
}, 90_000);
