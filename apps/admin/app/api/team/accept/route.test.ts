import type * as ApiHelpersModule from "@/lib/api-helpers";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acceptInvitation: vi.fn(),
  identityRows: [{ email: "owner@example.com", verified: true }],
  requireApiSession: vi.fn(),
}));

vi.mock("@lobbystack/domain", () => ({
  acceptInvitation: mocks.acceptInvitation,
  previewInvitation: vi.fn(),
}));

vi.mock("@/lib/api-helpers", async (importOriginal) => {
  const original = await importOriginal<typeof ApiHelpersModule>();
  return { ...original, requireApiSession: mocks.requireApiSession };
});

vi.mock("@/lib/domain-context", () => ({ createDomainContext: () => ({ db: {} }) }));
vi.mock("@/lib/auth", () => ({
  getAuthDatabase: () => ({
    db: {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => mocks.identityRows }) }) }),
    },
  }),
}));

import { POST } from "./route";

describe("invitation acceptance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.identityRows.splice(0, mocks.identityRows.length, { email: "owner@example.com", verified: true });
    mocks.requireApiSession.mockResolvedValue({ user: { id: "owner-id" } });
    mocks.acceptInvitation.mockResolvedValue({ businessId: "tenant-id", role: "business_owner" });
  });

  it("requires the signed-in identity to have a verified canonical email", async () => {
    mocks.identityRows[0] = { email: "owner@example.com", verified: false };
    const response = await POST(new Request("http://localhost/api/team/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "secret" }) }));
    expect(response.status).toBe(403);
    expect(mocks.acceptInvitation).not.toHaveBeenCalled();
  });

  it("binds acceptance to the canonical verified email", async () => {
    const response = await POST(new Request("http://localhost/api/team/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "secret" }) }));
    expect(response.status).toBe(200);
    expect(mocks.acceptInvitation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: "owner-id", verifiedEmail: "owner@example.com" }));
  });
});
