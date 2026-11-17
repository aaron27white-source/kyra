import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { notifications } from "@lobbystack/db";
import { createLmcHarness } from "./support/harness";

describe("email booking uses canonical availability under the staff lock",()=>{
  let h:Awaited<ReturnType<typeof createLmcHarness>>;
  beforeEach(async()=>{h=await createLmcHarness({now:"2030-01-09T03:40:00Z"});});
  afterEach(async()=>{await h?.close();});
  it("cannot book an arbitrary model-requested time that was never offered",async()=>{
    const lead=await h.qualifiedLead("arbitrary@example.invalid");
    expect((await h.lead(lead.id)).offeredSlots.length).toBeGreaterThan(0);
    await h.reply(lead.id,"Book 2030-01-12T14:00:00.000Z, please.");await h.work();
    expect(await h.bookings()).toHaveLength(0);
    expect(h.mail.lastTo("arbitrary@example.invalid").text).not.toMatch(/booked|confirmed/i);
  });
  it("creates one appointment when two qualified leads race for the same staff slot",async()=>{
    const one=await h.qualifiedLead("one@example.invalid"),two=await h.qualifiedLead("two@example.invalid");
    const slot=(await h.lead(one.id)).offeredSlots[0]!;
    expect(slot).toBeTruthy();
    await Promise.all([h.reply(one.id,`Book ${slot}`),h.reply(two.id,`Book ${slot}`)]);
    await Promise.all([h.work(),h.work()]);
    expect(await h.bookings()).toHaveLength(1);
    expect(h.calendar.events).toHaveLength(1);
    expect(h.calendar.unauthorizedCalls).toHaveLength(0);
    expect(await h.scoped(tx=>tx.select().from(notifications))).toHaveLength(0);
  });
  it("rechecks external busy blocks after the lead selects a previously offered slot",async()=>{
    const lead=await h.qualifiedLead("busy@example.invalid"),slot=(await h.lead(lead.id)).offeredSlots[0]!;
    expect(slot).toBeTruthy();
    await h.calendar.upsertEvent({accessToken:"fake-only",calendarId:`calendar-${h.tenantId}`,clientEventId:"external-busy",title:"Other work",startsAt:slot,endsAt:new Date(Date.parse(slot)+3_600_000).toISOString()});
    await h.reply(lead.id,`Book ${slot}`);await h.work();
    expect(await h.bookings()).toHaveLength(0);
    expect(h.mail.lastTo("busy@example.invalid").text).not.toMatch(/booked|confirmed/i);
  });
});
