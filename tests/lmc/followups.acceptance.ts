import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLmcHarness } from "./support/harness";

describe("follow-up consent and tenant caps",()=>{
  let h:Awaited<ReturnType<typeof createLmcHarness>>;
  beforeEach(async()=>{h=await createLmcHarness({now:"2030-01-09T03:40:00Z"});});
  afterEach(async()=>{await h?.close();});
  it("sends no follow-up without explicit consent",async()=>{
    await h.capture({email:"no-consent@example.invalid",message:"Roof help"});await h.work();
    for(let day=0;day<5;day++){h.advanceDays(1);await h.work();}
    expect(h.mail.to("no-consent@example.invalid").filter(mail=>mail.kind==="followup")).toHaveLength(0);
  });
  it("does not burst delayed touches when the worker returns after an outage",async()=>{
    await h.capture({email:"outage@example.invalid",message:"Roof help",consentToFollowUp:true});await h.work();
    h.advanceDays(10);await h.work();
    expect(h.mail.to("outage@example.invalid").filter(mail=>mail.kind==="followup")).toHaveLength(1);
    await h.work();
    expect(h.mail.to("outage@example.invalid").filter(mail=>mail.kind==="followup")).toHaveLength(1);
  });
  it("defers excess touches when the tenant daily cap is exhausted",async()=>{
    await h.setDailyCap(1);
    for(const email of ["one@example.invalid","two@example.invalid"])await h.capture({email,message:"Roof help",consentToFollowUp:true});
    await h.work();h.advanceDays(1);await Promise.all([h.work(),h.work()]);
    expect(h.mail.records.filter(mail=>mail.kind==="followup")).toHaveLength(1);
    await h.work();
    expect(h.mail.records.filter(mail=>mail.kind==="followup")).toHaveLength(1);
    h.advanceDays(1);await h.work();
    expect(h.mail.records.filter(mail=>mail.kind==="followup")).toHaveLength(2);
  });
});
