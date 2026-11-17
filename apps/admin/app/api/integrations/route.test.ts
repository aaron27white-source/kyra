import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enqueue: vi.fn(), update: vi.fn(), authorized: true, current: false, options: vi.fn() }));
vi.mock("@lobbystack/db", async (original) => ({ ...(await original()), enqueueOutbox: mocks.enqueue }));
vi.mock("@lobbystack/domain", () => ({ assignCalendarStaff: vi.fn(), discoverCalendars: vi.fn(), disconnectCalendar: vi.fn(), listCalendarConnections: vi.fn(), listCalendarStaff: vi.fn(), refreshCalendar: vi.fn(), resolveCalendarAccessToken: vi.fn(), selectCalendar: vi.fn() }));
vi.mock("@lobbystack/providers", () => ({ GoogleCalendarProvider: vi.fn(), SecretBox: vi.fn() }));
vi.mock("@/lib/domain-context", () => ({ createDomainContext: vi.fn(), createWorkerDomainContext: vi.fn() }));
vi.mock("@/lib/api-helpers", () => ({
  requireApiSession: async () => ({ user: { id: "owner" } }),
  businessIdFromRequest: () => "business",
  readJson: async (request: Request) => await request.json(),
  withOperatorTransaction: async (_request: Request, callback: (value: unknown) => unknown, options: unknown) => {
    mocks.options(options);
    if (!mocks.authorized) throw Object.assign(new Error("Forbidden"), { status: 403 });
    const rows = [[{ enabled: mocks.current }], [{ id: "appointment-1" }]];
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => rows.shift() ?? [], then: (resolve: (value: unknown) => void) => resolve(rows.shift() ?? []) }) }) }),
      update: () => ({ set: (value: unknown) => { mocks.update(value); return { where: async () => undefined }; } }),
    };
    return await callback({ businessId: "business", tx });
  },
  asApiResponse: (error: unknown) => new Response("Error", { status: (error as { status?: number }).status ?? 500 }),
}));

import { PATCH } from "./route";
const patch = (body: object) => PATCH(new Request("http://localhost/api/integrations?businessId=business", { method: "PATCH", body: JSON.stringify(body) }));

beforeEach(() => { vi.clearAllMocks(); mocks.authorized = true; mocks.current = false; });

describe("calendar service-address consent", () => {
  it("requires business admin and queues future event resync when enabled", async () => {
    expect((await patch({ shareServiceAddress: true })).status).toBe(200);
    expect(mocks.options).toHaveBeenCalledWith({ minimumRole: "business_admin", pilotCapability: "integrations" });
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ calendarShareServiceAddress: true }));
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ topic: "calendar.syncAppointment", businessId: "business", aggregateId: "appointment-1" }));
  });

  it("does not enqueue duplicate work when the setting is unchanged", async () => {
    mocks.current = true;
    expect((await patch({ shareServiceAddress: true })).status).toBe(200);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("rejects mixed calendar-selection and sharing writes", async () => {
    expect((await patch({ shareServiceAddress: true, connectionId: "other" })).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("does not change another business without authorization", async () => {
    mocks.authorized = false;
    expect((await patch({ shareServiceAddress: true })).status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
