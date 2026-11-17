import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enqueue: vi.fn(), appointmentStatus: "confirmed" }));
vi.mock("@lobbystack/db", async (original) => ({ ...(await original()), enqueueOutbox: mocks.enqueue }));
vi.mock("@lobbystack/domain", () => ({ effectiveServiceIntakePolicy: () => ({ serviceType: "onsite", fields: { serviceAddress: "required" } }), validateServiceIntake: (_policy: unknown, input: { serviceLocation: unknown }) => ({ ok: true, serviceLocation: input.serviceLocation, required: true }) }));
vi.mock("@/lib/api-helpers", () => ({
  readJson: async (request: Request) => await request.json(),
  jsonError: (message: string, status = 400) => Object.assign(new Error(message), { status }),
  asApiResponse: (error: unknown) => new Response("Error", { status: (error as { status?: number }).status ?? 500 }),
  withOperatorTransaction: async (_request: Request, callback: (input: unknown) => unknown) => {
    const batches = [[{ serviceId: "service", status: mocks.appointmentStatus, endsAt: new Date("2030-01-01T00:00:00Z"), intakeAnswers: null, contactName: null, contactPhone: null }], [{ intakePolicy: null }], [{ intakePolicy: null }]];
    const tx = {
      select: () => ({ from: () => ({ leftJoin: () => ({ where: () => ({ limit: async () => batches.shift() ?? [] }) }), where: () => ({ limit: async () => batches.shift() ?? [] }) }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ revision: 4 }] }) }) }),
    };
    return await callback({ businessId: "business", tx });
  },
}));

import { PATCH } from "./route";
const params = { params: Promise.resolve({ appointmentId: "appointment" }) };
const patch = () => PATCH(new Request("http://localhost/api/appointments/appointment", { method: "PATCH", body: JSON.stringify({ serviceLocation: { line1: "123 Main Street", city: "Miami", country: "US" } }) }), params);

beforeEach(() => { vi.clearAllMocks(); mocks.appointmentStatus = "confirmed"; });

describe("corrected service-location calendar synchronization", () => {
  it("queues a sync of the existing appointment after a future address correction", async () => {
    expect((await patch()).status).toBe(200);
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ topic: "calendar.syncAppointment", aggregateId: "appointment", payload: { appointmentId: "appointment", action: "location_corrected" } }));
  });

  it("does not sync a canceled appointment after an address correction", async () => {
    mocks.appointmentStatus = "canceled";
    expect((await patch()).status).toBe(200);
    expect(mocks.enqueue).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ topic: "calendar.syncAppointment" }));
  });
});
