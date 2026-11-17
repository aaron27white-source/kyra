import { expect, it } from "vitest";
import { withHttpAudit } from "./support/isolation-http";
import { probePilotPublicContext } from "./support/isolation-pilot-public";

it("binds real capture, opt-out and calendar callbacks to their capabilities despite forged sessions and tenant claims", async () => {
  const report = await withHttpAudit(process.env.LMC_TEST_HTTP_BASE_URL ?? "http://localhost:3000", probePilotPublicContext);
  expect(report.failures, report.failures.join("\n")).toEqual([]);
  expect(report.probed.sort()).toEqual([
    "POST /api/lmc/capture/[token]", "OPTIONS /api/lmc/capture/[token]",
    "GET /api/lmc/unsubscribe/[token]", "POST /api/lmc/unsubscribe/[token]", "OPTIONS /api/lmc/unsubscribe/[token]",
    "GET /api/calendar/google/callback", "OPTIONS /api/calendar/google/callback",
    "OPTIONS /api/webhooks/lmc-email",
  ].sort());
}, 120_000);
