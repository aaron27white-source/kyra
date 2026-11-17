import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLmcHarness } from "./support/harness";

describe("human access and uncertain delivery recovery",()=>{
  let h:Awaited<ReturnType<typeof createLmcHarness>>;
  beforeEach(async()=>{h=await createLmcHarness({now:"2030-01-09T03:40:00Z"});});
  afterEach(async()=>{await h?.close();});
  it("rejects a nonmember and deduplicates an authorized human reply",async()=>{
    const lead=await h.capture({email:"human@example.invalid",message:"I want to complain"});await h.work();
    await expect(h.humanReplyAs(randomUUID(),lead.id,"I am not authorized")).rejects.toThrow();
    const requestId=randomUUID();
    const [one,two]=await Promise.all([h.humanReplyAs(h.ownerId,lead.id,"I will help you",requestId),h.humanReplyAs(h.ownerId,lead.id,"I will help you",requestId)]);
    expect(one).toEqual(two);
    await h.work();
    expect(h.mail.to("human@example.invalid").filter(mail=>mail.text.includes("I will help you"))).toHaveLength(1);
    await expect(h.humanReplyAs(h.ownerId,lead.id,"Changed message",requestId)).rejects.toThrow("HUMAN_REPLY_IDEMPOTENCY_CONFLICT");
  });
  it("keeps unsubscribe capabilities out of model history",async()=>{
    const lead=await h.capture({email:"private-links@example.invalid",message:"Roof help"});await h.work();
    await h.reply(lead.id,"Roof repair at my home in ZIP 33101");await h.work();
    expect(h.model.calls.length).toBeGreaterThan(1);
    expect(JSON.stringify(h.model.calls.at(-1)?.untrusted.history)).not.toContain("/api/lmc/unsubscribe/");
  });
  it("does not retry an ambiguous customer delivery after the provider idempotency window",async()=>{
    const lead=await h.capture({email:"uncertain@example.invalid",message:"Roof help"});
    const send=h.mail.send.bind(h.mail);let customerAttempts=0;
    h.mail.send=async message=>{
      if(message.to!=="uncertain@example.invalid")return send(message);
      customerAttempts++;await send(message);throw new Error("EMAIL_PROVIDER_UNAVAILABLE");
    };
    await h.work();expect(customerAttempts).toBe(1);
    h.advanceDays(2);await h.work();
    expect(customerAttempts).toBe(1);
    expect(await h.lead(lead.id)).toMatchObject({status:"human_handoff",reason:"delivery_reconciliation_required",aiPaused:true});
    expect(await h.events(lead.id)).toContainEqual(expect.objectContaining({type:"outbound_reconciliation_required"}));
    expect(h.mail.to(h.ownerEmail)).toHaveLength(1);
  });
});
