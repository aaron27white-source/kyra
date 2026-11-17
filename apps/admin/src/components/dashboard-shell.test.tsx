// @vitest-environment jsdom
import type { ReactNode } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PilotDashboardCapability } from "@lobbystack/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardShell } from "./dashboard-shell";
import { UpgradePlanDialogProvider } from "./upgrade-plan-dialog-context";
const route = vi.hoisted(() => ({ pathname: "/", router: { push: vi.fn(), refresh: vi.fn(), replace: vi.fn() } }));
vi.mock("@/components/product-analytics", () => ({ useTelemetry: () => ({ track: vi.fn(), identify: vi.fn(), reset: vi.fn(), setOptOut: vi.fn(), setSensitiveRoute: vi.fn() }) }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname, useRouter: () => route.router }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: "en" }, t: (key: string) => key }) }));
vi.mock("./live-upgrade-plan-provider", () => ({ LiveUpgradePlanProvider: ({ children }: { children: ReactNode }) => <UpgradePlanDialogProvider onOpen={vi.fn()}>{children}</UpgradePlanDialogProvider> }));
vi.mock("./dashboard-utility-bar", () => ({ DashboardUtilityBar: () => null }));
vi.mock("./nav-user", () => ({ NavUser: () => null }));
const clients: QueryClient[] = [];
beforeEach(() => {
  route.pathname = "/"; window.innerWidth = 1440;
  vi.stubGlobal("matchMedia", vi.fn(query => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => { cleanup(); clients.forEach(client => client.clear()); clients.length = 0; vi.unstubAllGlobals(); vi.clearAllMocks(); });
function setup(role = "business_owner", pilotMode = false, pilotCapabilities: readonly PilotDashboardCapability[] = ["leads", "email_settings", "business_profile", "services", "knowledge", "contacts", "integrations"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }); clients.push(client);
  client.setQueryData(["businesses"], { businesses: [{ businessId: "business", name: "Tenant name", active: true, role }] });
  client.setQueryData(["billing", "business"], { account: null, permissions: { hasCheckoutAccess: false }, availableCheckoutPlans: [], availableCheckoutIntervals: { starter: [], pro: [] } });
  client.setQueryData(["phone-numbers", "business"], { phoneNumbers: [] });
  client.setQueryData(["setup", "business"], { steps: [] });
  const content = () => <QueryClientProvider client={client}><DashboardShell pilotMode={pilotMode} pilotCapabilities={pilotMode ? pilotCapabilities : []} user={{ email: "operator@example.invalid", name: "Operator" }}><p>Page content</p></DashboardShell></QueryClientProvider>;
  const view = render(content());
  return { ...view, client, navigate(pathname: string) { route.pathname = pathname; view.rerender(content()); } };
}
describe("original shared navigation", () => {
  it("keeps the original group ordering and integrations link", () => {
    setup();
    // The branded workspace header remains text-first and does not use an image logo.
    expect(screen.queryByRole("img", { name: "Lead My Company" })).toBeNull();
    expect(screen.getAllByRole("link").map(link => link.getAttribute("href"))).toEqual(["#dashboard-main-content", "/", "/leads", "/calls", "/appointments", "/messages", "/contacts", "/agent", "/agent/knowledge", "/agent/services", "/agent/rules", "/analytics", "/integrations", "/settings/usage"]);
    expect(document.getElementById("dashboard-main-content")?.tabIndex).toBe(-1);
  });
  it("keeps integrations visible for viewers", () => {
    setup("viewer"); expect(screen.getByRole("link", { name: "settings:sections.integrations" })).toBeTruthy();
  });
  it("shows calendar integrations in the pilot navigation only when enabled for the tenant", () => {
    setup("business_owner", true);
    expect(screen.getByRole("link", { name: "settings:sections.integrations" }).getAttribute("href")).toBe("/integrations");
  });
  it("shows appointments only when voice is enabled for the pilot tenant", () => {
    setup("business_owner", true);
    expect(screen.queryByRole("link", { name: "nav:items.appointments" })).toBeNull();
    setup("business_owner", true, ["voice"]);
    expect(screen.getByRole("link", { name: "nav:items.appointments" }).getAttribute("href")).toBe("/appointments");
  });
  it("resets the content scroll position after navigation", () => {
    const view = setup(); const main = view.container.querySelector('[data-slot="sidebar-inset"]') as HTMLElement;
    main.scrollTop = 240; main.scrollLeft = 30; view.navigate("/calls");
    expect(main.scrollTop).toBe(0); expect(main.scrollLeft).toBe(0);
  });
  it("supports repeated mobile navigation across every original group", async () => {
    window.innerWidth = 390;
    const view = setup();
    for (const [label, href] of [["nav:items.calls", "/calls"], ["agent:sections.knowledge.title", "/agent/knowledge"], ["settings:sections.integrations", "/integrations"]]) {
      await userEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));
      const dialog = await screen.findByRole("dialog");
      await userEvent.click(within(dialog).getByRole("button", { name: label! }));
      expect(route.router.push).toHaveBeenLastCalledWith(href);
      view.navigate(href!);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
  });
});

describe("pilot navigation boundary",()=>{
  it("renders only capability-approved links and leaves billing queries disabled",()=>{
    const {client}=setup("business_owner",true);
    expect(screen.getAllByRole("link").map(link=>link.getAttribute("href"))).toEqual(["#dashboard-main-content","/leads","/contacts","/agent/knowledge","/agent/services","/settings/business","/integrations","/settings/email"]);
    expect(client.getQueryCache().find({queryKey:["billing","business"],exact:true})?.isActive()??false).toBe(false);
  });
  it("does not offer the inherited create-workspace onboarding route",async()=>{
    setup("business_owner",true);
    await userEvent.click(screen.getByRole("button",{name:/Tenant name/}));
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem",{name:"sidebar.createBusiness"})).toBeNull();
  });
});
