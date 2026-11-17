import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  list: vi.fn(),
  reply: vi.fn(),
}));
vi.mock("@/lib/api-helpers", () => ({
  requireOperatorBusiness: mocks.auth,
  asApiResponse: () =>
    Response.json({ error: "Request failed" }, { status: 500 }),
}));
vi.mock("@/lib/lmc-runtime", () => ({
  getLmcServices: () => ({
    workspace: { list: mocks.list },
    human: { reply: mocks.reply },
  }),
}));
import { GET } from "../../app/api/leads/route";
import { POST } from "../../app/api/leads/[leadId]/reply/route";
describe("LMC operator HTTP boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({
      session: { user: { id: "authenticated-user" } },
      businessId: "selected-business",
    });
    mocks.list.mockResolvedValue({ items: [] });
    mocks.reply.mockResolvedValue({ id: "message" });
  });
  it("uses the authenticated principal and selected workspace", async () => {
    expect(
      (await GET(new Request("http://localhost/api/leads?limit=25&offset=0")))
        .status,
    ).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(
      { tenantId: "selected-business", userId: "authenticated-user" },
      { limit: 25, offset: 0 },
    );
    const body = {
      requestId: "22be1c6f-b8cb-4c28-9296-df31acc21462",
      text: "I will help personally.",
    };
    expect(
      (
        await POST(
          new Request("http://localhost", {
            method: "POST",
            body: JSON.stringify(body),
          }),
          { params: Promise.resolve({ leadId: "lead" }) },
        )
      ).status,
    ).toBe(200);
    expect(mocks.reply).toHaveBeenCalledWith(
      {
        tenantId: "selected-business",
        userId: "authenticated-user",
        leadId: "lead",
      },
      body,
    );
  });
  it("rejects forged actor fields and oversized input before the domain command", async () => {
    for (const [body, status] of [
      [
        JSON.stringify({
          requestId: "22be1c6f-b8cb-4c28-9296-df31acc21462",
          text: "Hi",
          userId: "another-user",
        }),
        400,
      ],
      ["x".repeat(40_000), 413],
    ] as const) {
      expect(
        (
          await POST(
            new Request("http://localhost", { method: "POST", body }),
            { params: Promise.resolve({ leadId: "lead" }) },
          )
        ).status,
      ).toBe(status);
    }
    expect(mocks.reply).not.toHaveBeenCalled();
  });
  it("does not execute a domain query without a session", async () => {
    mocks.auth.mockRejectedValue(
      Response.json({ error: "Unauthorized" }, { status: 401 }),
    );
    expect((await GET(new Request("http://localhost/api/leads"))).status).toBe(
      401,
    );
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
