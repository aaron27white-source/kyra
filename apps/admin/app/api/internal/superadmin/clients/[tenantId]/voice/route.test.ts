import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ setVoice: vi.fn(), session: vi.fn() }));
vi.mock("@lobbystack/domain", () => ({ setManagedLmcVoiceEnabled: mocks.setVoice }));
vi.mock("@/lib/superadmin", () => ({ requireSuperAdminSession: mocks.session }));
vi.mock("@/lib/api-helpers", () => ({
  getAppDatabase: () => ({ db: {} }),
  readJson: (request: Request) => request.json(),
  asApiResponse: (error: unknown) => NextResponse.json({ error: error instanceof Error ? error.message : "failed" }, { status: typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 500 }),
}));

import { PATCH } from "./route";

const tenantId = "11111111-1111-4111-8111-111111111111";
const context = { params: Promise.resolve({ tenantId }) };

describe("managed client inbound voice gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.session.mockResolvedValue({ user: { id: "platform-admin" } });
    mocks.setVoice.mockImplementation(async (_context, input) => ({ tenantId: input.tenantId, voiceEnabled: input.enabled }));
  });

  it("requires the platform admin session before changing tenant voice state", async () => {
    mocks.session.mockRejectedValue(Object.assign(new Error("forbidden"), { status: 403 }));
    const response = await PATCH(new Request(`http://localhost/api/internal/superadmin/clients/${tenantId}/voice`, { method: "PATCH", body: JSON.stringify({ enabled: true }) }), context);
    expect(response.status).toBe(403);
    expect(mocks.setVoice).not.toHaveBeenCalled();
  });

  it("validates the feature state and writes only the selected tenant", async () => {
    const response = await PATCH(new Request(`http://localhost/api/internal/superadmin/clients/${tenantId}/voice`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, tenantId: "other" }) }), context);
    expect(response.status).toBe(400);
    expect(mocks.setVoice).not.toHaveBeenCalled();

    const enabled = await PATCH(new Request(`http://localhost/api/internal/superadmin/clients/${tenantId}/voice`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) }), context);
    expect(enabled.status).toBe(200);
    expect(mocks.setVoice).toHaveBeenCalledWith({ db: {} }, expect.objectContaining({ tenantId, enabled: true, actorUserId: "platform-admin" }));
  });
});
