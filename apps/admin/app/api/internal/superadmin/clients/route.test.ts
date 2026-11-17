import type * as SuperAdminModule from "@/lib/superadmin";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSuperAdminSession: vi.fn(),
  listSuperAdminClients: vi.fn(),
}));

vi.mock("@/lib/superadmin", async (importOriginal) => {
  const original = await importOriginal<typeof SuperAdminModule>();
  return { ...original, requireSuperAdminSession: mocks.requireSuperAdminSession, listSuperAdminClients: mocks.listSuperAdminClients };
});

import { SuperAdminAccessError } from "@/lib/superadmin";
import { GET, POST } from "./route";

describe("Super Admin clients API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("denies requests without a privileged session before reading tenants", async () => {
    mocks.requireSuperAdminSession.mockRejectedValue(new SuperAdminAccessError(403, "Platform administrator access is required."));
    const response = await GET(new Request("http://localhost/api/internal/superadmin/clients"));
    expect(response.status).toBe(403);
    expect(mocks.listSuperAdminClients).not.toHaveBeenCalled();
  });

  it("denies client creation without a privileged session", async () => {
    mocks.requireSuperAdminSession.mockRejectedValue(new SuperAdminAccessError(403, "Platform administrator access is required."));
    const response = await POST(new Request("http://localhost/api/internal/superadmin/clients", { method: "POST" }));
    expect(response.status).toBe(403);
  });

  it("requires an idempotency key before accepting a creation payload", async () => {
    mocks.requireSuperAdminSession.mockResolvedValue({ user: { id: "admin" }, session: {} });
    const response = await POST(new Request("http://localhost/api/internal/superadmin/clients", { method: "POST" }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("Idempotency-Key") });
  });

  it("returns bounded, paginated client records", async () => {
    mocks.requireSuperAdminSession.mockResolvedValue({ user: { id: "admin" }, session: {} });
    mocks.listSuperAdminClients.mockResolvedValue({ data: [{ id: "tenant", name: "Acme" }], total: 101, hasNext: true });
    const response = await GET(new Request("http://localhost/api/internal/superadmin/clients?search=Acme&limit=999&offset=25"));
    expect(response.status).toBe(200);
    expect(mocks.listSuperAdminClients).toHaveBeenCalledWith({ userId: "admin", search: "Acme", limit: 100, offset: 25 });
    await expect(response.json()).resolves.toMatchObject({ pagination: { limit: 100, offset: 25, total: 101, hasNext: true } });
  });
});
