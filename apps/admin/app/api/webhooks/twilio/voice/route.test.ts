import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ valid: vi.fn(), execute: vi.fn(), record: vi.fn() }));
vi.mock("@lobbystack/db", () => ({}));
vi.mock("@lobbystack/domain", () => ({ recordMissedCall: mocks.record }));
vi.mock("@lobbystack/shared", () => ({ normalizeTwilioFormFields: (params: URLSearchParams) => Object.fromEntries(params), resolveTwilioWebhookUrl: (url: string) => url, validateTwilioSignature: mocks.valid }));
vi.mock("@/lib/api-helpers", () => ({ getAppDatabase: () => ({ db: { execute: mocks.execute } }) }));
vi.mock("@/lib/domain-context", () => ({ createWorkerDomainContext: () => ({}) }));
import { POST } from "./route";

const CALL_SID = `CA${"0".repeat(32)}`;
const request = (fields: Record<string, string> = {}) => new Request("https://admin.example.invalid/api/webhooks/twilio/voice", { method: "POST", body: new URLSearchParams({ CallSid: CALL_SID, From: "+17135550100", To: "+18325550100", ...fields }) });
beforeEach(() => { vi.clearAllMocks(); mocks.valid.mockResolvedValue(true); mocks.execute.mockResolvedValue({ rows: [{ business_id: "business" }] }); mocks.record.mockResolvedValue({ greeting: "Thanks for calling <Bayou> & Co.", missedCallId: "m1", action: "texting" }); });

it("rejects unsigned requests before touching any data", async () => {
  mocks.valid.mockResolvedValue(false);
  expect((await POST(request())).status).toBe(401);
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(mocks.record).not.toHaveBeenCalled();
});

it("records the missed call for the dialled business and speaks an escaped greeting", async () => {
  const response = await POST(request());
  expect(response.headers.get("content-type")).toBe("text/xml");
  const xml = await response.text();
  expect(xml).toContain("Thanks for calling &lt;Bayou&gt; &amp; Co.");
  expect(xml).toContain("<Hangup/>");
  expect(mocks.record).toHaveBeenCalledWith({}, { businessId: "business", providerCallId: CALL_SID, from: "+17135550100", to: "+18325550100" });
});

it("never leaves a caller in silence, even for an unknown number or a failure", async () => {
  mocks.execute.mockResolvedValue({ rows: [] });
  expect(await (await POST(request())).text()).toContain("<Say");
  mocks.execute.mockResolvedValue({ rows: [{ business_id: "business" }] });
  mocks.record.mockRejectedValue(new Error("private db error"));
  const xml = await (await POST(request())).text();
  expect(xml).toContain("<Say");
  expect(xml).not.toContain("private db error");
  expect(await (await POST(request({ CallSid: "not-a-sid" }))).text()).toContain("<Say");
});
