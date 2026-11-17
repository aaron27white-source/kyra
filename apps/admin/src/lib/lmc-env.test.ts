import { describe, expect, it } from "vitest";
import { getLmcEnvironment } from "./lmc-env";
describe("LMC email environment", () => {
  it("defaults local development to fake even when provider keys exist", () => {
    expect(
      getLmcEnvironment({
        NODE_ENV: "development",
        RESEND_API_KEY: "re_unused",
      }),
    ).toMatchObject({ mode: "fake", senderEmail: "team@example.invalid" });
  });
  it("rejects implicit production mode and placeholder signing configuration", () => {
    expect(() => getLmcEnvironment({ NODE_ENV: "production" })).toThrow();
    expect(() =>
      getLmcEnvironment({
        NODE_ENV: "production",
        LMC_PROVIDER_MODE: "real",
        LMC_SIGNING_SECRET: "CHANGE-ME-THIS-IS-AN-EXAMPLE-SECRET",
      }),
    ).toThrow();
  });
  it("rejects real-mode HTTP origins and invalid sending identities", () => {
    const input = {
      NODE_ENV: "production",
      LMC_PROVIDER_MODE: "real",
      LMC_SIGNING_SECRET: "0123456789abcdef".repeat(4),
      LMC_EMAIL_FROM: "team@leadmycompany.com",
      LMC_RECEIVING_DOMAIN: "inbound.leadmycompany.com",
      LMC_PUBLIC_BASE_URL: "https://leadmycompany.com",
    };
    expect(getLmcEnvironment(input).mode).toBe("real");
    expect(() =>
      getLmcEnvironment({
        ...input,
        LMC_PUBLIC_BASE_URL: "http://leadmycompany.com",
      }),
    ).toThrow();
    expect(() =>
      getLmcEnvironment({ ...input, LMC_EMAIL_FROM: "fake@example.invalid" }),
    ).toThrow();
  });
});

it("allows an empty optional signing variable only in local fake mode",()=>{expect(getLmcEnvironment({NODE_ENV:"development",LMC_SIGNING_SECRET:""}).mode).toBe("fake");});
