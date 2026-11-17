import { expect, it } from "vitest";
import { routeNamespaces } from "./route-namespaces";

it("keeps login and embed startup independent of dashboard translations", () => {
  expect(routeNamespaces("/fr/login")).toEqual([
    "common",
    "auth",
    "onboarding",
  ]);
  expect(routeNamespaces("/embed/key")).toEqual(["common", "widget"]);
});
it("loads detail-route namespaces alongside shared navigation", () => {
  expect(routeNamespaces("/calls/id")).toEqual([
    "common",
    "nav",
    "settings",
    "agent",
    "calls",
  ]);
  expect(routeNamespaces("/analytics")).toContain("dashboard");
  expect(routeNamespaces("/agent/knowledge")).toContain("knowledge");
});

it("loads email workspace translations for the lead list and email settings", () => {
  expect(routeNamespaces("/en/leads")).toContain("lmc");
  expect(routeNamespaces("/fr/settings/email")).toContain("lmc");
});
