import { describe, expect, it, vi } from "vitest";
import { ResendTransactionalEmailProvider } from "./smtp";

const apiKey = "re_test_only_not_a_real_credential";
const original = { apiKey, from: "Kyra <verify@example.test>" };

describe("Resend transactional email transport", () => {
  it("sends verification HTML and reuses the same idempotency key", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: "msg-123" }));
    const provider = new ResendTransactionalEmailProvider({ ...original, fetch: fetcher });
    const message = {
      template: "verify_email" as const, to: "recipient@example.test",
      subject: "Your verification code", variables: { code: "123456" },
      idempotencyKey: "verify:stable",
    };
    expect(await provider.sendTemplate(message)).toEqual({ messageId: "msg-123" });
    expect(await provider.sendTemplate(message)).toEqual({ messageId: "msg-123" });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      from: original.from, to: ["recipient@example.test"], subject: message.subject,
      text: expect.stringContaining("123456"),
      html: expect.stringContaining("Verify your email address"),
    });
    expect((fetcher.mock.calls[0]![1]!.headers as Record<string,string>)["Idempotency-Key"])
      .toBe((fetcher.mock.calls[1]![1]!.headers as Record<string,string>)["Idempotency-Key"]);
    expect(String(init?.body)).not.toContain(apiKey);
  });

  it("honors explicit from/reply-to and preserves sender override semantics", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: "msg-456" }));
    const provider = new ResendTransactionalEmailProvider({ ...original, replyTo: "default@example.test", fetch: fetcher });
    await provider.sendTemplate({template:"onboarding_followup",to:"recipient@example.test",subject:"Check-in",
      variables:{businessName:"Example HVAC"},from:"Founder <founder@example.test>",replyTo:"owner@example.test"});
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({
      from:"Founder <founder@example.test>",reply_to:"owner@example.test",
    });
  });

  it("fails closed without exposing provider error details", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({message:"secret provider details"},{status:403}));
    const provider = new ResendTransactionalEmailProvider({ ...original, fetch: fetcher });
    await expect(provider.sendTemplate({template:"verify_email",to:"recipient@example.test",
      subject:"Verify",variables:{code:"123456"}})).rejects.toThrow("EMAIL_PROVIDER_UNAVAILABLE");
  });

  it("rejects missing or invalid provider configuration", () => {
    expect(() => new ResendTransactionalEmailProvider({ ...original, apiKey: "" })).toThrow("RESEND_CONFIGURATION_REQUIRED");
  });
});
