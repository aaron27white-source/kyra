import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { notifications } from "@lobbystack/db";
import { createLmcHarness } from "./support/harness";

describe("verified email appointment changes",()=>{
  let h:Awaited<ReturnType<typeof createLmcHarness>>;
  beforeEach(async()=>{h=await createLmcHarness({now:"2030-01-09T03:40:00Z"});});
  afterEach(async()=>{await h?.close();});
  async function booked(){
    const lead=await h.qualifiedLead("change@example.invalid"),slots=(await h.lead(lead.id)).offeredSlots;
    expect(slots.length).toBeGreaterThan(1);
    await h.reply(lead.id,`Book ${slots[0]}`);await h.work();expect(await h.bookings()).toHaveLength(1);
    return {lead,slots};
  }
  it("reschedules a verified contact to an offered available time and updates the same calendar event",async()=>{
    const {lead,slots}=await booked();
    await h.reply(lead.id,`Please reschedule to ${slots[1]}`);await h.work();
    expect(await h.bookings()).toMatchObject([{startsAt:slots[1],contactEmail:"change@example.invalid"}]);
    expect(h.calendar.events).toHaveLength(1);
    expect(h.calendar.events[0]?.startsAt).toBe(slots[1]);
    expect(await h.scoped(tx=>tx.select().from(notifications))).toHaveLength(0);
  });
  it("cancels a verified contact's visit and removes the event without any follow-up",async()=>{
    const {lead}=await booked();await h.reply(lead.id,"Please cancel my appointment");await h.work();
    expect(await h.bookings()).toHaveLength(0);
    expect(h.calendar.events).toHaveLength(0);
    expect(h.mail.lastTo("change@example.invalid").text).toMatch(/cancelled|canceled/i);
    const count=h.mail.records.length;h.advanceDays(5);await h.work();expect(h.mail.records).toHaveLength(count);
  });
  it("does not ignore another event that overlaps the replacement time",async()=>{
    const {lead,slots}=await booked();
    await h.calendar.upsertEvent({accessToken:"fake-only",calendarId:`calendar-${h.tenantId}`,clientEventId:"other-visit",title:"Other visit",startsAt:slots[1]!,endsAt:new Date(Date.parse(slots[1]!)+3_600_000).toISOString()});
    await h.reply(lead.id,`Please reschedule to ${slots[1]}`);await h.work();
    expect(await h.bookings()).toMatchObject([{startsAt:slots[0]}]);
    expect(h.mail.lastTo("change@example.invalid").text).toMatch(/no longer available/i);
  });
  it("cannot cancel a booking using the conversation token with a different sender",async()=>{
    const {lead}=await booked(),event=await h.replyEvent(lead.id,"Cancel my appointment");
    if(event.kind!=="message")throw new Error("INVALID_TEST_EVENT");
    event.email.from="intruder@example.invalid";await h.deliver(event);await h.work();
    expect(await h.bookings()).toHaveLength(1);
    expect(h.calendar.events).toHaveLength(1);
  });
});
