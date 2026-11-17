import { expect, it } from "vitest";

import { withHttpAudit } from "./support/isolation-http";
import { probePilotDashboardContext } from "./support/isolation-pilot-dashboard";

it("enforces tenant dashboard capabilities on canonical configuration APIs", async () => {
  const result = await withHttpAudit(
    process.env.LMC_TEST_HTTP_BASE_URL ?? "http://localhost:3000",
    probePilotDashboardContext,
  );

  expect(result.failures).toEqual([]);
  expect(result.probed.length).toBeGreaterThanOrEqual(39);
}, 120_000);
