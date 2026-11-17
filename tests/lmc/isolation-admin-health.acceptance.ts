import { expect, it } from "vitest";
import { withHttpAudit } from "./support/isolation-http";
import { probeAdminHealthContext } from "./support/isolation-admin-health";
it("probes actual Next health routes with anonymous, A/B and forged tenant contexts", async () => {
  const report = await withHttpAudit(
    process.env.LMC_TEST_HTTP_BASE_URL ?? "http://localhost:3000",
    probeAdminHealthContext,
  );
  expect(report.failures).toEqual([]);
  expect(report.probed.sort()).toEqual(
    ["/api/health/live", "/api/health/ready", "/healthz", "/readyz"]
      .flatMap((path) =>
        ["GET", "HEAD", "OPTIONS"].map((method) => `${method} ${path}`),
      )
      .sort(),
  );
}, 120_000);
