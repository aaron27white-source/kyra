import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpenAiSipCallbackDialer, createTwilioMediaClient } from "./assistantAdapters";

const SID = "AC0123456789abcdef0123456789abcdef";
const env = { TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: "token" } as NodeJS.ProcessEnv;

afterEach(() => vi.unstubAllGlobals());

describe("Twilio media client", () => {
  it("refuses any URL that isn't this account's Twilio media, before fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = createTwilioMediaClient(env)!;
    await expect(client.download("https://evil.example/2010-04-01/Accounts/x", 10)).rejects.toThrow("media_host_rejected");
    await expect(client.download("https://api.twilio.com/2010-04-01/Accounts/ACsomeoneelse/Messages/MM1/Media/ME1", 10)).rejects.toThrow("media_host_rejected");
    await expect(client.download("http://api.twilio.com/2010-04-01/Accounts/" + SID + "/Messages/MM1/Media/ME1", 10)).rejects.toThrow("media_host_rejected");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops reading past the size cap", async () => {
    const big = new Uint8Array(64);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(big, { status: 200 })));
    const client = createTwilioMediaClient(env)!;
    await expect(client.download(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages/MM1/Media/ME1`, 16)).rejects.toThrow("media_too_large");
  });
});

describe("OpenAI SIP callback dialer", () => {
  it("stays off unless explicitly enabled with an https public URL", () => {
    expect(createOpenAiSipCallbackDialer({ ...env, OPENAI_SIP_PROJECT_ID: "proj_abc", PUBLIC_APP_URL: "https://app.example" })).toBeUndefined();
    expect(createOpenAiSipCallbackDialer({ ...env, CALLBACK_VOICE_PROVIDER: "openai_sip", OPENAI_SIP_PROJECT_ID: "proj_abc", PUBLIC_APP_URL: "http://app.example" })).toBeUndefined();
    expect(() => createOpenAiSipCallbackDialer({ ...env, CALLBACK_VOICE_PROVIDER: "openai_sip", OPENAI_SIP_PROJECT_ID: "proj_x@evil;", PUBLIC_APP_URL: "https://app.example" })).toThrow();
  });

  it("bridges the customer to OpenAI with the opaque token and a signed-status callback", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ sid: "CAabc" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const dialer = createOpenAiSipCallbackDialer({ ...env, CALLBACK_VOICE_PROVIDER: "openai_sip", OPENAI_SIP_PROJECT_ID: "proj_abc123", PUBLIC_APP_URL: "https://app.example/" })!;
    const token = "a".repeat(48);
    await expect(dialer.dial({ businessId: "b", target: { to: "+17135550100", from: "+18325550100", token, businessName: "X", language: "en" } })).resolves.toEqual({ providerCallId: "CAabc" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Calls.json`);
    const form = new URLSearchParams(String(init.body));
    expect(form.get("To")).toBe("+17135550100");
    expect(form.get("Twiml")).toContain(`sip:proj_abc123@sip.api.openai.com;transport=tls?X-Key20-Callback=${token}`);
    expect(form.get("StatusCallback")).toBe(`https://app.example/api/webhooks/twilio/callback-status?token=${token}`);
  });
});
