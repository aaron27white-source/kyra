import { afterEach, expect, it, vi } from "vitest";
import { probeWorkerAttach } from "./support/isolation-worker-attach-audit";

afterEach(() => vi.unstubAllEnvs());

it("requires a successful isolated real-HTTP/PG voice admission proof before recording worker coverage", async () => {
  const report = await probeWorkerAttach();
  expect(report.failures).toEqual([]);
  expect(report.probed).toEqual(
    ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"].map(
      (method) => `worker:${method} /internal/live/attach`,
    ),
  );
}, 50_000);

it("records no worker coverage when the real database proof cannot run", async () => {
  vi.stubEnv("LMC_TEST_DATABASE_URL", "");
  const report = await probeWorkerAttach();
  expect(report.probed).toEqual([]);
  expect(report.failures).toEqual(["WORKER_ATTACH_HTTP_PROBE_FAILED"]);
}, 50_000);
