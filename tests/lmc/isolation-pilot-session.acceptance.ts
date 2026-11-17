import { expect, it } from "vitest";
import { withHttpAudit } from "./support/isolation-http";
import { probePilotSessionContext } from "./support/isolation-pilot-session";

it("keeps session identity and workspace writes bound to the authenticated user", async () => {
  const report = await withHttpAudit(process.env.LMC_TEST_HTTP_BASE_URL ?? "http://localhost:3000", probePilotSessionContext);
  expect(report.failures).toEqual([]);
  expect(report.probed.sort()).toEqual([
    "POST /api/auth/sign-in/email", "GET /api/auth/get-session",
    "GET /api/account", "HEAD /api/account", "OPTIONS /api/account",
    "GET /api/businesses", "HEAD /api/businesses", "OPTIONS /api/businesses",
    "POST /api/businesses/switch", "OPTIONS /api/businesses/switch",
  ].sort());
}, 120_000);
