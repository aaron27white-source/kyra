import { expect, it } from "vitest";
import { withHttpAudit } from "./support/isolation-http";
import { probePilotWebhookContext } from "./support/isolation-pilot-webhook";

it("routes valid signed webhook events by their registered capability and persists no forged or duplicate tenant writes", async () => {
  const report = await withHttpAudit(process.env.LMC_TEST_HTTP_BASE_URL ?? "http://localhost:3000", probePilotWebhookContext);
  expect(report.failures).toEqual([]);
  expect(report.probed).toEqual(["POST /api/webhooks/lmc-email"]);
}, 120_000);
