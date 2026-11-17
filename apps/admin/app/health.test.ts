import { afterEach, expect, it, vi } from "vitest";
const dependencies = vi.hoisted(() => ({
  database: vi.fn(),
  storage: vi.fn(),
}));
vi.mock("@lobbystack/db", () => ({
  databaseHealthCheck: dependencies.database,
}));
vi.mock("@/lib/api-helpers", () => ({ getAppDatabase: () => ({}) }));
vi.mock("@/lib/storage", () => ({
  getStorageProvider: () => ({ ensureReady: dependencies.storage }),
}));
import { GET as live } from "./healthz/route";
import { GET as ready } from "./readyz/route";
afterEach(() => vi.resetAllMocks());
it("keeps liveness independent of external dependencies", async () => {
  expect(live().status).toBe(200);
  expect(dependencies.database).not.toHaveBeenCalled();
  expect(dependencies.storage).not.toHaveBeenCalled();
});
it("requires both database and storage for readiness", async () => {
  dependencies.database.mockResolvedValue({ ok: true });
  dependencies.storage.mockResolvedValue(undefined);
  expect((await ready()).status).toBe(200);
  dependencies.database.mockResolvedValue({ ok: false });
  expect((await ready()).status).toBe(503);
  dependencies.database.mockResolvedValue({ ok: true });
  dependencies.storage.mockRejectedValue(new Error("private-storage-detail"));
  const failed = await ready();
  expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain("private-storage-detail");
});
it("fails closed without exposing dependency exceptions", async () => {
  dependencies.database.mockRejectedValue(new Error("private-database-detail"));
  dependencies.storage.mockResolvedValue(undefined);
  const response = await ready();
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private-database-detail");
});
