import { expect,it } from "vitest";
import { emailVisitLocalDate,formatEmailVisitDate,formatEmailVisitTime } from "./scheduling";

it("formats appointment instants as natural English in the business timezone",()=>{
  expect(formatEmailVisitTime("2026-11-02T14:00:00.000Z","America/New_York")).toBe("Monday, November 2 at 9:00 AM Eastern Standard Time");
  expect(formatEmailVisitDate("2026-11-02","America/New_York")).toBe("November 2");
  expect(emailVisitLocalDate("2026-11-02T04:30:00.000Z","America/New_York")).toBe("2026-11-01");
});
