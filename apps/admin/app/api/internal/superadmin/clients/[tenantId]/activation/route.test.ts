import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  pause: vi.fn(),
  readiness: vi.fn(),
  session: vi.fn(),
}));

vi.mock("@lobbystack/domain", () => ({
  activateManagedLmcClient: mocks.activate,
  pauseManagedLmcClient: mocks.pause,
  readManagedClientReadiness: mocks.readiness,
}));
vi.mock("@/lib/superadmin", () => ({ requireSuperAdminSession: mocks.session }));
vi.mock("@/lib/superadmin-activation", () => ({ getManagedActivationEnvironment: () => ({ senderEmail: "team@example.invalid", emailProviderReady: true }) }));
vi.mock("@/lib/api-helpers", () => ({
  getAppDatabase: () => ({ db: {} }),
  readJson: (request: Request) => request.json(),
  asApiResponse: (error: unknown) => NextResponse.json({ error: error instanceof Error ? error.message : "failed" }, { status: typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 500 }),
}));

import { GET, POST } from "./route";

const tenantId = "11111111-1111-4111-8111-111111111111";
const context = { params: Promise.resolve({ tenantId }) };

describe("managed client activation API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.session.mockResolvedValue({ user: { id: "admin" } });
    mocks.readiness.mockResolvedValue({ tenantId, canActivate: false });
    mocks.activate.mockResolvedValue({ tenantId, activated: true });
    mocks.pause.mockResolvedValue({ tenantId, paused: true });
  });

  it("authorizes before reading readiness", async () => {
    mocks.session.mockRejectedValue(Object.assign(new Error("forbidden"), { status: 403 }));
    expect((await GET(new Request(`http://localhost/api/internal/superadmin/clients/${tenantId}/activation`), context)).status).toBe(403);
    expect(mocks.readiness).not.toHaveBeenCalled();
  });

  it("requires idempotency for activation", async () => {
    const response = await POST(new Request(`http://localhost/api/internal/superadmin/clients/${tenantId}/activation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "activate" }) }), context);
    expect(response.status).toBe(400);
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("passes only the authenticated actor and validated tenant to activation", async () => {
    const response = await POST(new Request(`http://localhost/api/internal/superadmin/clients/${tenantId}/activation`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "activate-once" }, body: JSON.stringify({ action: "activate" }) }), context);
    expect(response.status).toBe(200);
    expect(mocks.activate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ actorUserId: "admin", tenantId, idempotencyKey: "activate-once" }));
  });

  it("requires idempotency for pause", async () => {
    const response = await POST(new Request(`http://localhost/api/internal/superadmin/clients/${tenantId}/activation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "pause" }) }), context);
    expect(response.status).toBe(400);
    expect(mocks.pause).not.toHaveBeenCalled();
  });

  it("pauses without accepting a caller-supplied tenant body", async () => {
    const response = await POST(new Request(`http://localhost/api/internal/superadmin/clients/${tenantId}/activation`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "pause-once" }, body: JSON.stringify({ action: "pause" }) }), context);
    expect(response.status).toBe(200);
    expect(mocks.pause).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ actorUserId: "admin", tenantId, idempotencyKey: "pause-once" }));
  });
});
