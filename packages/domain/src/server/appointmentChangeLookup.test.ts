import { describe, expect, it } from "vitest";

import { findAppointmentChangeMatches } from "./appointmentChangeLookup";

const booking = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "appointment-1",
  contactId: "contact-1",
  startsAt: new Date("2026-11-18T18:00:00.000Z"),
  timezone: "America/Toronto",
  name: "João",
  phone: "+14165550100",
  serviceName: "AC Repair",
  serviceSlug: "ac-repair",
  localizedNames: {},
  ...overrides,
});

function transaction(rows: Array<ReturnType<typeof booking>>) {
  let queryNumber = 0;
  return {
    select: () => {
      const currentQuery = queryNumber++;
      const query = {
        from() { return query; },
        innerJoin() { return query; },
        where() { return query; },
        orderBy() { return query; },
        limit() {
          return Promise.resolve(currentQuery === 0
            ? [{ id: "service-1", name: "AC Repair", slug: "ac-repair", localizedNames: {} }]
            : rows);
        },
      };
      return query;
    },
  } as never;
}

describe("appointment change lookup", () => {
  it("reproduces the Nov 17 incident with a synthetic row and imperfect spoken name", async () => {
    const result = await findAppointmentChangeMatches(transaction([booking()]), {
      businessId: "synthetic-business",
      callerPhone: "+14165550100",
      callerName: "Juan",
      appointmentStartsAt: "November 18, 2026 at 1:00 PM",
      serviceName: "AC Repair",
      timezone: "America/Toronto",
      now: new Date("2026-11-17T16:00:00Z"),
    });
    expect(result.reason).toBe("matched");
    expect(result.matchingStrategy).toBe("caller_phone_and_facts");
    expect(result.matches.map(({ id }) => id)).toEqual(["appointment-1"]);
  });

  it("finds the candidate with the saved name and facts from an alternate caller number", async () => {
    const result = await findAppointmentChangeMatches(transaction([booking()]), {
      businessId: "synthetic-business",
      callerPhone: "+14165550999",
      callerName: "J-O-A-O",
      appointmentStartsAt: "November 18, 2026",
      serviceName: "AC Repair",
      timezone: "America/Toronto",
      now: new Date("2026-11-17T16:00:00Z"),
    });
    expect(result.reason).toBe("matched");
    expect(result.matchingStrategy).toBe("appointment_facts");
    expect(result.matches).toHaveLength(1);
  });

  it("does not silently choose among bookings with the same phone and facts", async () => {
    const result = await findAppointmentChangeMatches(transaction([booking(), booking({ id: "appointment-2", contactId: "contact-2" })]), {
      businessId: "synthetic-business",
      callerPhone: "+14165550100",
      callerName: "Joao",
      appointmentStartsAt: "November 18, 2026",
      serviceName: "AC Repair",
    });
    expect(result.reason).toBe("ambiguous");
    expect(result.matches).toHaveLength(2);
  });

  it("rejects a wrong date and tolerates a misheard clock only when date and service agree", async () => {
    const wrongDate = await findAppointmentChangeMatches(transaction([booking()]), {
      businessId: "synthetic-business", callerPhone: "+14165550100", callerName: "Joao",
      appointmentStartsAt: "November 19, 2026 at 1:00 PM", serviceName: "AC Repair", timezone: "America/Toronto",
    });
    expect(wrongDate.reason).toBe("no_match");
    const wrongClock = await findAppointmentChangeMatches(transaction([booking()]), {
      businessId: "synthetic-business", callerPhone: "+14165550100", callerName: "Joao",
      appointmentStartsAt: "November 18, 2026 at 3:00 PM", serviceName: "AC Repair", timezone: "America/Toronto",
    });
    expect(wrongClock.reason).toBe("matched");
  });
});
