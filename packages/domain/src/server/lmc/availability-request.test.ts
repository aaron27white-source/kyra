import { describe,expect,it } from "vitest";
import { isAlternativeAvailabilityRequest,requestedLocalDate } from "./availability-request";

describe("alternative availability requests",()=>{
  const now=new Date("2026-10-29T15:00:00.000Z");
  it("recognizes the reported rejection and parses an upcoming business-local date",()=>{
    const text="Hmm, none of these work for me, do u guys work on November 2?";
    expect(isAlternativeAvailabilityRequest(text)).toBe(true);
    expect(requestedLocalDate(text,now,"America/New_York")).toBe("2026-11-02");
  });
  it.each([
    ["Could we do Nov. 2?","2026-11-02"],
    ["What about 11/2?","2026-11-02"],
    ["Would Tuesday work?","2026-11-03"],
    ["Can you come tomorrow?","2026-10-30"],
    ["Could you do February 30?",undefined],
  ])("parses local date request %s",(text,date)=>expect(requestedLocalDate(text,now,"America/New_York")).toBe(date));
  it("does not treat arbitrary dates as scheduling requests",()=>expect(isAlternativeAvailabilityRequest("I bought this house on November 2.")).toBe(false));
});
