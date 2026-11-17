import { expect, it } from "vitest";
import { probeWorkerHealth } from "./support/isolation-worker-health";

it("probes the real worker health server over HTTP with readiness and forged tenant contexts", async () => {
  const report = await probeWorkerHealth();
  expect(report.failures).toEqual([]);
  expect(report.probed.sort()).toEqual(
    ["/health/live", "/health/ready", "/healthz", "/readyz"]
      .flatMap((path) =>
        ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"].map(
          (method) => `worker:${method} ${path}`,
        ),
      )
      .sort(),
  );
});
