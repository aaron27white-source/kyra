"use client";

import Link from "next/link";
import posthog from "posthog-js";
import { createBrowserTelemetry } from "@lobbystack/telemetry/browser";
import type { PilotDashboardCapability } from "@lobbystack/shared";
import { requestJson } from "@/lib/request-json";
import { selectActiveBusiness } from "@/lib/active-business";
import { usePathname, useRouter } from "next/navigation";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
} from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { BookTextIcon } from "@/components/ui/book-text";
import { BlocksIcon } from "@/components/ui/blocks";
import { ChartColumnIncreasingIcon } from "@/components/ui/chart-column-increasing";
import { AudioLines, CalendarDaysIcon } from "lucide-react";
import { ClipboardCheckIcon } from "@/components/ui/clipboard-check";
import { HomeIcon, type HomeIconHandle } from "@/components/ui/home";
import { MessageSquareMoreIcon } from "@/components/ui/message-square-more";
import { PhoneAnimatedIcon } from "@/components/ui/phone-animated";
import { SettingsIcon } from "@/components/ui/settings";
import { UsersIcon } from "@/components/ui/users";
import { WorkflowIcon } from "@/components/ui/workflow";
import { WorkspaceSwitcher } from "@/components/layout/workspace-switcher";
import { Main } from "@/components/layout/main";
import { SiteHeader } from "@/components/site-header";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { LiveUpgradePlanProvider } from "./live-upgrade-plan-provider";
import { BillingPastDueBanner, type BillingPermissions } from "./billing-past-due-banner";
import { DashboardUtilityBar } from "./dashboard-utility-bar";
import { DashboardSetupGuideCard } from "./dashboard-setup-guide-card";
import { NavUser } from "./nav-user";
import { UpgradePlanDialogProvider, useOpenUpgradePlanDialog } from "./upgrade-plan-dialog-context";
import { resolveLocale } from "@/lib/locale";
import { localizePublicPath } from "@/lib/locale-path";

type Business = {
  businessId: string;
  name: string;
  active: boolean;
};

type DashboardShellProps = {
  pilotMode?: boolean;
  pilotCapabilities?: readonly PilotDashboardCapability[];
  children: React.ReactNode;
  user: {
    email: string;
    name: string;
  };
};

type NavigationItem = {
  href: string;
  label: string;
  icon: typeof HomeIcon;
};

const AppointmentsIcon = forwardRef<
  HomeIconHandle,
  HTMLAttributes<HTMLDivElement> & { size?: number }
>(({ className, size = 16, ...props }, ref) => {
  useImperativeHandle(
    ref,
    () => ({ startAnimation: () => undefined, stopAnimation: () => undefined }),
    [],
  );
  return (
    <div className={className} {...props}>
      <CalendarDaysIcon size={size} />
    </div>
  );
});
AppointmentsIcon.displayName = "AppointmentsIcon";

async function getBusinesses(): Promise<{ businesses: Business[] }> {
  const response = await fetch("/api/businesses", { credentials: "include" });
  if (!response.ok) throw new Error("Unable to load workspaces.");
  return await response.json() as { businesses: Business[] };
}

function getSidebarDefaultOpen(): boolean {
  if (typeof document === "undefined") return true;
  const value = document.cookie.split("; ").find((entry) => entry.startsWith("sidebar_state="));
  return value?.split("=")[1] !== "false";
}

export function DashboardShell({ children, user, pilotMode = false, pilotCapabilities = [] }: DashboardShellProps) {
  const { t } = useTranslation("common");
  const pathname = usePathname();
  const contentScrollRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const contentScroll = contentScrollRef.current;
    if (!contentScroll) return;
    contentScroll.scrollTop = 0;
    contentScroll.scrollLeft = 0;
  }, [pathname]);

  const shell = (
    <div className="flex h-svh w-full flex-col overflow-hidden bg-background">
      <a href="#dashboard-main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-xl focus:bg-background focus:p-4">{t("accessibility.skipToContent")}</a>
      {!pilotMode && <BillingBanner />}
      <SidebarProvider
        className="relative min-h-0 flex-1 overflow-hidden"
        defaultOpen={getSidebarDefaultOpen()}
        style={{ "--sidebar-width": "16rem" } as React.CSSProperties}
      >
        <ReplacementSidebar user={user} pilotMode={pilotMode} pilotCapabilities={pilotCapabilities} />
        <SidebarInset
          ref={contentScrollRef}
          className="@container/content min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain has-data-[layout=fixed]:h-full peer-data-[variant=inset]:has-data-[layout=fixed]:h-[calc(100%-(var(--spacing)*4))]"
        >
          <SiteHeader fixed scrollContainerRef={contentScrollRef} />
          <div className="hidden h-16 shrink-0 border-b md:block" />
          {!pilotMode && <DashboardUtilityBar />}
          <Main id="dashboard-main-content" tabIndex={-1} className="flex flex-1 flex-col" fixed={pathname === "/messages"}>
            {children}
          </Main>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
  return pilotMode
    ? <UpgradePlanDialogProvider onOpen={() => undefined}>{shell}</UpgradePlanDialogProvider>
    : <LiveUpgradePlanProvider>{shell}</LiveUpgradePlanProvider>;
}

function BillingBanner() {
  const businesses = useQuery({ queryKey: ["businesses"], queryFn: getBusinesses });
  const business = businesses.data?.businesses.find((item) => item.active) ?? businesses.data?.businesses[0];
  const billing = useQuery({ queryKey: ["billing", business?.businessId], queryFn: async () => {
    const response = await fetch(`/api/billing?businessId=${encodeURIComponent(business!.businessId)}`, { credentials: "include" });
    if (!response.ok) throw new Error("Billing unavailable");
    return await response.json() as { account: { plan: string | null; subscriptionState: string | null } | null; permissions: BillingPermissions };
  }, enabled: Boolean(business?.businessId) });
  if (!business || !billing.data?.account || !billing.data.permissions) return null;
  return <BillingPastDueBanner businessId={business.businessId} plan={billing.data.account.plan} subscriptionState={billing.data.account.subscriptionState} permissions={billing.data.permissions} />;
}

function ReplacementSidebar({ user, pilotMode = false, pilotCapabilities = [] }: Pick<DashboardShellProps, "user" | "pilotMode" | "pilotCapabilities">) {
  const { t } = useTranslation(["nav", "settings", "agent", "common"]);
  const pilotHas = (capability: PilotDashboardCapability) => pilotCapabilities.includes(capability);
  const general: NavigationItem[] = pilotMode ? [
    ...(pilotHas("leads") ? [{ label: t("nav:items.leads"), href: "/leads", icon: UsersIcon }] : []),
    ...(pilotHas("voice") ? [{ label: t("nav:items.calls"), href: "/calls", icon: PhoneAnimatedIcon }] : []),
    ...(pilotHas("voice") ? [{ label: t("nav:items.appointments"), href: "/appointments", icon: AppointmentsIcon }] : []),
    ...(pilotHas("contacts") ? [{ label: t("nav:items.contacts"), href: "/contacts", icon: UsersIcon }] : []),
  ] : [
    { label: t("nav:items.home"), href: "/", icon: HomeIcon },
    { label: t("nav:items.leads"), href: "/leads", icon: UsersIcon },
    { label: t("nav:items.calls"), href: "/calls", icon: PhoneAnimatedIcon },
    { label: t("nav:items.appointments"), href: "/appointments", icon: AppointmentsIcon },
    { label: t("nav:items.messages"), href: "/messages", icon: MessageSquareMoreIcon },
    { label: t("nav:items.contacts"), href: "/contacts", icon: UsersIcon },
  ];
  const receptionist: NavigationItem[] = pilotMode ? [
    ...(pilotHas("voice") ? [{ label: t("agent:sections.basicSettings.title"), href: "/agent", icon: ClipboardCheckIcon }] : []),
    ...(pilotHas("voice") ? [{ label: t("agent:sections.rules.title"), href: "/agent/rules", icon: WorkflowIcon }] : []),
    ...(pilotHas("knowledge") ? [{ label: t("agent:sections.knowledge.title"), href: "/agent/knowledge", icon: BookTextIcon }] : []),
    ...(pilotHas("services") ? [{ label: t("agent:sections.services.title"), href: "/agent/services", icon: BlocksIcon }] : []),
  ] : [
    { label: t("agent:sections.basicSettings.title"), href: "/agent", icon: ClipboardCheckIcon },
    { label: t("agent:sections.knowledge.title"), href: "/agent/knowledge", icon: BookTextIcon },
    { label: t("agent:sections.services.title"), href: "/agent/services", icon: BlocksIcon },
    { label: t("agent:sections.rules.title"), href: "/agent/rules", icon: WorkflowIcon },
  ];
  const other: NavigationItem[] = pilotMode ? [
    ...(pilotHas("business_profile") ? [{ label: t("settings:sections.businessProfile"), href: "/settings/business", icon: SettingsIcon }] : []),
    ...(pilotHas("integrations") ? [{ label: t("settings:sections.integrations"), href: "/integrations", icon: BlocksIcon }] : []),
    ...(pilotHas("email_settings") ? [{ label: t("nav:items.emailSettings"), href: "/settings/email", icon: SettingsIcon }] : []),
  ] : [
    { label: t("nav:items.analytics"), href: "/analytics", icon: ChartColumnIncreasingIcon },
    { label: t("settings:sections.integrations"), href: "/integrations", icon: BlocksIcon },
    { label: t("nav:items.settings"), href: "/settings/usage", icon: SettingsIcon },
  ];

  return (
    <Sidebar className="absolute inset-y-0 h-full" collapsible="icon" variant="sidebar">
      <SidebarHeader>
        <div className="flex h-11 items-center gap-2.5 px-2">
          <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"><AudioLines className="size-[18px]" /></span>
          <span className="truncate text-sm font-semibold tracking-tight text-sidebar-foreground group-data-[collapsible=icon]:hidden">{t("common:appName")}</span>
        </div>
        <WorkspaceSwitcher allowCreate={!pilotMode} />
      </SidebarHeader>
      <SidebarContent>
        <NavigationGroup items={general} pathname={pathname} title={t("nav:sidebar.general")} />
        {receptionist.length > 0 && <NavigationGroup items={receptionist} pathname={pathname} title={t("nav:sidebar.agent")} />}
        <NavigationGroup items={other} pathname={pathname} title={t("nav:sidebar.other")} />
      </SidebarContent>
      <SidebarFooter>
        {!pilotMode && <DashboardSetupGuideCard />}
        <UserMenu user={user} pilotMode={pilotMode} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function AnimatedNavigationIcon({ icon: Icon, hovered }: { icon: typeof HomeIcon; hovered: boolean }) {
  const iconRef = useRef<{ startAnimation: () => void; stopAnimation: () => void } | null>(null);
  useEffect(() => {
    if (hovered) iconRef.current?.startAnimation();
    else iconRef.current?.stopAnimation();
  }, [hovered]);
  return <Icon ref={iconRef} className="size-4 shrink-0 [&_svg]:size-4" size={16} />;
}

function NavigationGroup({ items, pathname, title }: { items: NavigationItem[]; pathname: string; title: string }) {
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const [hoveredItem, setHoveredItem] = useState<string | null>(null);
  const activeHref = items
    .filter((item) => item.href !== "/" && (
      pathname === item.href
      || pathname.startsWith(`${item.href}/`)
      || (item.href === "/settings/usage" && pathname.startsWith("/settings/"))
    ))
    .sort((left, right) => right.href.length - left.href.length)[0]?.href
    ?? (pathname === "/" && items.some((item) => item.href === "/") ? "/" : null);
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{title}</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => {
          const active = activeHref === item.href;
          return (
            <SidebarMenuItem key={item.href}>
              <SidebarMenuButton
                onMouseEnter={() => setHoveredItem(item.href)}
                onMouseLeave={() => setHoveredItem(null)}
                onFocus={() => setHoveredItem(item.href)}
                onBlur={() => setHoveredItem(null)}
                isActive={active}
                {...(!isMobile ? { render: <Link href={item.href} /> } : {})}
                tooltip={item.label}
                onClick={() => { if (isMobile) { router.push(item.href); setOpenMobile(false); } }}
              >
                <AnimatedNavigationIcon icon={item.icon} hovered={hoveredItem === item.href} />
                <span>{item.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}


function UserMenu({ user, pilotMode = false }: Pick<DashboardShellProps, "user" | "pilotMode">) {
  const router = useRouter();
  const { i18n } = useTranslation();
  const openUpgradePlanDialog = useOpenUpgradePlanDialog();
  const [signingOut, setSigningOut] = useState(false);
  const businesses = useQuery({ queryKey: ["businesses"], queryFn: () => requestJson<{ businesses: Business[] }>("/api/businesses") });
  const business = selectActiveBusiness(businesses.data?.businesses);
  const billing = useQuery({ queryKey: ["billing", business?.businessId], enabled: !pilotMode && Boolean(business?.businessId), queryFn: () => requestJson<{ account: { plan: string | null } | null; permissions: BillingPermissions; availableCheckoutPlans: Array<"starter" | "pro">; availableCheckoutIntervals: Record<"starter" | "pro", string[]> }>(`/api/billing?businessId=${encodeURIComponent(business!.businessId)}`) });
  const showUpgradeToPro = !pilotMode && billing.data?.permissions.hasCheckoutAccess === true && (billing.data.account?.plan ?? "free_cloud") === "free_cloud" && (billing.data.availableCheckoutPlans ?? []).some(plan => billing.data?.availableCheckoutIntervals[plan].length);
  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      const response = await fetch("/api/auth/sign-out", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: "{}" });
      if (!response.ok) return;
      // Remove the prior operator and workspace association before the next
      // person uses this browser session. This is deliberately best-effort.
      try {
        if (posthog.__loaded) {
          const telemetry = createBrowserTelemetry(posthog, { optedOut: false });
          telemetry.reset();
          telemetry.setOptOut(true);
        }
      } catch {
        // Analytics must never block sign-out.
      }
      router.replace(localizePublicPath("/login", resolveLocale(i18n.resolvedLanguage, i18n.language)));
      router.refresh();
    } finally { setSigningOut(false); }
  }
  return <NavUser showAccount={!pilotMode} user={{ ...user, avatar: "" }} onSignOut={() => void signOut()} onUpgradeToPro={openUpgradePlanDialog} showUpgradeToPro={showUpgradeToPro} />;
}
