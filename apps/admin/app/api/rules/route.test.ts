import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), remove: vi.fn(), reorder: vi.fn(), refresh: vi.fn(), denied: false }));
vi.mock("@lobbystack/domain", () => ({ createAgentRule: mocks.create, updateAgentRule: mocks.update, deleteAgentRule: mocks.remove, reorderAgentRules: mocks.reorder, listAgentRules: vi.fn() , refreshBusinessSnapshot: mocks.refresh }));
vi.mock("@/lib/domain-context", () => ({ createDomainContext: () => ({ role: "operator" }), createWorkerDomainContext: () => ({ role: "worker" }) }));
vi.mock("@/lib/api-helpers", () => ({
  readJson: async (request: Request) => await request.json(),
  withOperatorTransaction: async (_request: Request, callback: (input: { session: { user: { id: string } }; businessId: string }) => unknown) => {
    if (mocks.denied) throw Object.assign(new Error("Forbidden"), { status: 403 });
    return await callback({ session: { user: { id: "owner" } }, businessId: "business" });
  },
  asApiResponse: (error: unknown) => new Response("Error", { status: (error as { status?: number }).status ?? 500 }),
}));

import { DELETE, PATCH, POST } from "./route";

const request = (method: string, body: object) => new Request("http://localhost/api/rules", { method, body: JSON.stringify(body) });
const ruleId = "11111111-1111-4111-8111-111111111111";

beforeEach(() => { vi.clearAllMocks(); mocks.denied = false; mocks.create.mockResolvedValue(ruleId); mocks.refresh.mockResolvedValue("version-2"); });

describe("voice rule snapshot publication", () => {
  it("refreshes using the worker role after a successful create", async () => {
    expect((await POST(request("POST", { title: "Rule", content: "Approved fact" }))).status).toBe(201);
    expect(mocks.refresh).toHaveBeenCalledWith({ role: "worker" }, { businessId: "business" });
  });

  it("refreshes after update, reorder, and deletion", async () => {
    expect((await PATCH(request("PATCH", { ruleId, active: false }))).status).toBe(200);
    expect((await PATCH(request("PATCH", { ruleIds: [ruleId] }))).status).toBe(200);
    expect((await DELETE(request("DELETE", { ruleId }))).status).toBe(200);
    expect(mocks.refresh).toHaveBeenCalledTimes(3);
  });

  it("never refreshes for an unauthorized mutation", async () => {
    mocks.denied = true;
    expect((await POST(request("POST", { title: "Rule", content: "Approved fact" }))).status).toBe(403);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("leaves the rule saved for the queued retry if immediate publication fails", async () => {
    mocks.refresh.mockRejectedValueOnce(new Error("unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect((await POST(request("POST", { title: "Rule", content: "Approved fact" }))).status).toBe(201);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("voice.rules.snapshot_refresh_failed"));
    } finally { log.mockRestore(); }
  });
});
