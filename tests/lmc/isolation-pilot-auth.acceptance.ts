import { expect, it } from "vitest";
import { withHttpAudit } from "./support/isolation-http";
import { probePilotAuthContext } from "./support/isolation-pilot-auth";

it("proves real signup, email verification, MFA, both recovery flows and session revocation without touching another tenant", async () => {
  const report = await withHttpAudit(process.env.LMC_TEST_HTTP_BASE_URL ?? "http://localhost:3000", probePilotAuthContext);
  expect(report.failures).toEqual([]);
  expect(report.probed.sort()).toEqual([
    "POST /api/auth/sign-up/email", "POST /api/auth/sign-out",
    "POST /api/auth/email-otp/send-verification-otp", "POST /api/auth/email-otp/verify-email",
    "POST /api/auth/email-otp/request-password-reset", "POST /api/auth/email-otp/reset-password",
    "POST /api/auth/request-password-reset", "POST /api/auth/reset-password", "GET /api/auth/reset-password/[token]",
    "POST /api/auth/send-verification-email", "GET /api/auth/verify-email",
    "POST /api/auth/two-factor/enable", "POST /api/auth/two-factor/verify-totp",
    "POST /api/auth/two-factor/verify-backup-code",
  ].sort());
}, 120_000);
