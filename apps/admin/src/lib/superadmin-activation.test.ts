import { describe, expect, it } from "vitest";
import { getManagedActivationEnvironment } from "./superadmin-activation";

const base = { NODE_ENV: "production", LMC_PROVIDER_MODE: "real", LMC_PUBLIC_BASE_URL: "https://app.example.com", LMC_EMAIL_FROM: "team@example.com", LMC_RECEIVING_DOMAIN: "inbound.example.com", LMC_SIGNING_SECRET: "test-only-value-that-is-not-a-secret", LMC_EMAIL_WORKER_ENABLED: "true" };

describe("managed activation provider readiness", () => {
  it("requires Resend HTTPS credentials in production", () => {
    expect(getManagedActivationEnvironment(base)).toEqual({ senderEmail: "team@example.com", emailProviderReady: false });
    expect(getManagedActivationEnvironment({ ...base, RESEND_API_KEY: "re_12345678", RESEND_WEBHOOK_SECRET: `whsec_${Buffer.alloc(16, 1).toString("base64")}` })).toEqual({ senderEmail: "team@example.com", emailProviderReady: true });
  });

  it("fails closed with sanitized state when the LMC environment is invalid", () => {
    expect(getManagedActivationEnvironment({ NODE_ENV: "production", LMC_EMAIL_FROM: "Team@Example.com" })).toEqual({ senderEmail: "team@example.com", emailProviderReady: false });
  });
});
