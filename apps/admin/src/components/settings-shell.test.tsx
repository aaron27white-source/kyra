// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsShell } from "./settings-shell";
import SettingsPage from "../../app/(dashboard)/settings/page";
const route = vi.hoisted(() => ({ pathname: "/settings/usage", redirect: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname, useRouter: () => ({ push: route.push }), redirect: route.redirect }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe("original settings route shell", () => {
  it("redirects the settings index to usage", () => { SettingsPage(); expect(route.redirect).toHaveBeenCalledWith("/settings/usage"); });
  it("renders the current section in grouped route-backed settings navigation", () => {
    route.pathname = "/settings/usage";
    render(<SettingsShell><p>Settings content</p></SettingsShell>);
    expect(screen.getByRole("heading", { name: "sections.usage" })).toBeTruthy();
    const paths = ["business", "team", "phone-number", "kyra", "kyra/back-office", "email", "widget", "connected-apps", "api-keys", "usage", "plan", "appearance", "notifications"];
    expect(screen.getAllByRole("link").map(link => link.getAttribute("href"))).toEqual(paths.map(path => `/settings/${path}`));
    expect(screen.getByRole("link", { name: "sections.usage" }).className).toContain("bg-primary/10");
  });
  it("keeps website widget settings discoverable from every settings page", () => {
    route.pathname = "/settings/usage";
    render(<SettingsShell><p>Widget content</p></SettingsShell>);
    expect(screen.getByRole("link", { name: "sections.widget" }).getAttribute("href")).toBe("/settings/widget");
  });
});

it("shows only capability-reviewed settings in pilot mode",()=>{
  route.pathname="/settings/email";
  render(<SettingsShell pilotMode><p>Email settings content</p></SettingsShell>);
  expect(screen.getAllByRole("link").map(link=>link.getAttribute("href"))).toEqual(["/settings/business","/settings/email"]);
  expect(screen.getByText("Email settings content")).toBeTruthy();
});
