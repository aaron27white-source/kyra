import type * as DbModule from "@lobbystack/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { appointments, businesses, businessHours, calendarConnections, calls, closures, contacts, notifications, receptionistProfiles, services, staff, staffServiceAssignments } from "@lobbystack/db";

const mocks = vi.hoisted(() => ({
  withBusinessTransaction: vi.fn(),
  enqueueOutbox: vi.fn(),
}));

vi.mock("@lobbystack/db", async (original) => ({
  ...(await original<typeof DbModule>()),
  withBusinessTransaction: mocks.withBusinessTransaction,
  enqueueOutbox: mocks.enqueueOutbox,
}));

import { bookAppointment } from "./booking";

type TransactionConfig = {
  staffRows?: unknown[];
  assignments?: unknown[];
  assignmentsAfterLock?: unknown[];
  connections?: unknown[];
  hours?: unknown[];
  existingCallBooking?: { appointmentId: string; contactId: string; staffId: string };
  serviceIntakePolicy?: Record<string, unknown>;
  businessIntakePolicy?: Record<string, unknown>;
};

function createRecordingTransaction(config: TransactionConfig = {}) {
  const fromCounts = new Map<unknown, number>();
  const insertCounts = new Map<unknown, number>();
  let selectCount = 0;
  let notificationSeq = 0;
  const executeCalls: unknown[] = [];
  const insertedValues = new Map<unknown, unknown>();

  const rowsFor = (table: unknown): unknown[] => {
    if (table === services) return [{ id: "svc-1", name: "General Checkup", durationMinutes: 30, intakePolicy: config.serviceIntakePolicy }];
    if (table === receptionistProfiles) return config.businessIntakePolicy ? [{ intakePolicy: config.businessIntakePolicy }] : [];
    if (table === calls && config.existingCallBooking) return [{ id: "call-1", conversationId: null, contactId: "original-contact", startedAt: new Date(), transport: "phone" }];
    if (table === appointments && config.existingCallBooking) return [config.existingCallBooking];
    if (table === businesses) return [{ timezone: "UTC" }];
    if (table === staff) return config.staffRows ?? [{ id: "staff-1" }, { id: "staff-2" }, { id: "staff-3" }];
    if (table === staffServiceAssignments) return executeCalls.length && config.assignmentsAfterLock
      ? config.assignmentsAfterLock
      : config.assignments ?? [];
    if (table === calendarConnections) return config.connections ?? [];
    if (table === businessHours) return config.hours ?? [{ dayOfWeek: 1, openMinutes: 0, closeMinutes: 1440 }];
    return [];
  };

  const thenable = (resolve: () => unknown[]) => {
    const node: Record<string, unknown> = {};
    const self = () => node;
    node.from = (table: unknown) => {
      fromCounts.set(table, (fromCounts.get(table) ?? 0) + 1);
      return thenable(() => rowsFor(table));
    };
    for (const method of ["where", "limit", "orderBy", "set", "values", "returning", "onConflictDoNothing", "innerJoin", "leftJoin", "for"]) node[method] = self;
    node.then = (onFulfilled: (value: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) => Promise.resolve().then(resolve).then(onFulfilled, onRejected);
    return node;
  };

  const tx = {
    select: () => { selectCount += 1; return thenable(() => []); },
    insert: (table: unknown) => {
      insertCounts.set(table, (insertCounts.get(table) ?? 0) + 1);
      const query = table === contacts ? thenable(() => [{ id: "contact-1" }]) : table === appointments ? thenable(() => [{ id: "apt-1", revision: 1 }]) : table === notifications ? thenable(() => { notificationSeq += 1; return [{ id: `notif-${notificationSeq}` }]; }) : thenable(() => [{ id: "row-1" }]);
      query.values = (values: unknown) => { insertedValues.set(table, values); return query; };
      return query;
    },
    update: () => thenable(() => [{ id: "row-1" }]),
    delete: () => thenable(() => [{ id: "row-1" }]),
    execute: (query: unknown) => { executeCalls.push(query); return Promise.resolve([{ pg_advisory_xact_lock: null }]); },
  };

  return { tx, fromCounts, insertCounts, selectCount: () => selectCount, executeCalls, insertedValues };
}

const context = { db: {} as never };
const input = {
  businessId: "biz-1",
  serviceId: "svc-1",
  startsAt: "2027-06-07T15:00:00.000Z",
  timezone: "UTC",
  contactPhone: "+14165550100",
  sourceChannel: "voice",
};

function useTransaction(config: TransactionConfig) {
  const recording = createRecordingTransaction(config);
  mocks.withBusinessTransaction.mockImplementation(async (_db: unknown, _scope: unknown, callback: (tx: unknown) => unknown) => callback(recording.tx));
  return recording;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enqueueOutbox.mockResolvedValue(undefined);
});

describe("booking availability reference locking", () => {
  it("reloads reference data while rechecking every candidate under the advisory lock", async () => {
    const recording = useTransaction({ hours: [] });

    await expect(bookAppointment(context, input)).rejects.toThrow("No staff member is available for this service.");

    // The advisory lock is still taken for each candidate that is evaluated.
    expect(recording.executeCalls).toHaveLength(3);
    expect(recording.fromCounts.get(services)).toBe(4);
    expect(recording.fromCounts.get(businesses)).toBe(4);
    expect(recording.fromCounts.get(staff)).toBe(4);
    expect(recording.fromCounts.get(staffServiceAssignments)).toBe(4);
    expect(recording.fromCounts.get(calendarConnections)).toBe(4);
    expect(recording.fromCounts.get(businessHours)).toBe(4);
    expect(recording.fromCounts.get(closures)).toBe(4);
    expect(recording.fromCounts.get(appointments)).toBe(3);
    expect(recording.selectCount()).toBe(35);
  });

  it("rechecks conflicts after the lock and stops at the first available candidate", async () => {
    const recording = useTransaction({});

    const result = await bookAppointment(context, input);

    expect(result).toEqual({ appointmentId: "apt-1", contactId: "contact-1", staffId: "staff-1" });
    expect(recording.executeCalls).toHaveLength(1);
    expect(recording.fromCounts.get(services)).toBe(2);
    expect(recording.fromCounts.get(staff)).toBe(2);
    // One availability read plus the post-lock conflict recheck for the winner.
    expect(recording.fromCounts.get(appointments)).toBe(2);
    expect(recording.fromCounts.get(contacts)).toBe(1);
    expect(recording.insertCounts.get(notifications)).toBe(2);
  });

  it("keeps unassigned services available to every active staff member", async () => {
    const recording = useTransaction({ hours: [], assignments: [] });

    await expect(bookAppointment(context, input)).rejects.toThrow("No staff member is available for this service.");
    expect(recording.executeCalls).toHaveLength(3);
  });

  it("skips the availability read for staff that are not assigned to the service", async () => {
    const recording = useTransaction({ hours: [], assignments: [{ staffId: "staff-2" }] });

    await expect(bookAppointment(context, input)).rejects.toThrow("No staff member is available for this service.");
    // The lock set is unchanged: every active candidate is still locked.
    expect(recording.executeCalls).toHaveLength(3);
    // Only the assigned candidate reaches the staff-specific conflict read.
    expect(recording.fromCounts.get(appointments)).toBe(1);
  });

  it("honors assignment changes committed while waiting for the staff lock", async () => {
    const recording = useTransaction({ assignments: [], assignmentsAfterLock: [{ staffId: "staff-2" }] });

    const result = await bookAppointment(context, input);

    expect(result.staffId).toBe("staff-2");
    expect(recording.executeCalls).toHaveLength(2);
    expect(recording.fromCounts.get(staffServiceAssignments)).toBe(3);
  });

  it("returns the original appointment on a duplicate voice booking invocation", async () => {
    const existingCallBooking = { appointmentId: "apt-existing", contactId: "alternate-contact", staffId: "staff-1" };
    const recording = useTransaction({ existingCallBooking });

    const result = await bookAppointment(context, { ...input, callId: "call-1" });

    expect(result).toEqual({ ...existingCallBooking, idempotent: true });
    expect(recording.executeCalls).toHaveLength(0);
    expect(recording.insertCounts.get(appointments) ?? 0).toBe(0);
    expect(recording.insertCounts.get(notifications) ?? 0).toBe(0);
  });

  it("refuses to confirm an onsite booking until its required address is supplied", async () => {
    const recording = useTransaction({ serviceIntakePolicy: { serviceType: "onsite", fields: { serviceAddress: "required" } } });
    await expect(bookAppointment(context, input)).rejects.toMatchObject({ code: "missing_required_fields", missingFields: ["serviceAddress"] });
    expect(recording.insertCounts.get(appointments) ?? 0).toBe(0);
    expect(recording.insertCounts.get(contacts) ?? 0).toBe(0);
  });

  it("persists normalized service location and complete intake with the booking", async () => {
    const recording = useTransaction({ serviceIntakePolicy: { serviceType: "onsite", fields: { serviceAddress: "required", issueDescription: "required" } } });
    await bookAppointment(context, { ...input, contactName: "Jamie", intake: { serviceLocation: { line1: "123 Main St", unit: "", city: "Miami", region: "FL", postalCode: "33101", country: "us" }, answers: { issueDescription: " AC not cooling " } } });
    expect(recording.insertedValues.get(appointments)).toMatchObject({ serviceLocation: { line1: "123 Main St", city: "Miami", postalCode: "33101", country: "US" }, intakeAnswers: { issueDescription: "AC not cooling" }, intakeCompletionStatus: "complete" });
  });
});
