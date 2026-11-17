"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";

import { NestedPageSurfaceProvider } from "@/components/page-surface";
import { PageHeader } from "@/components/page-header";
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@/components/ui/native-select";
import { Surface } from "@/components/ui/surface";
import { cn } from "@/lib/utils";

type SettingsItem = { id: string; href: string };
type SettingsGroup = { id: string; items: SettingsItem[] };

const settingsGroups: SettingsGroup[] = [
  { id: "workspace", items: [
    { id: "businessProfile", href: "/settings/business" },
    { id: "business", href: "/settings/team" },
    { id: "phoneNumber", href: "/settings/phone-number" },
  ] },
  { id: "agent", items: [
    { id: "kyra", href: "/settings/kyra" },
    { id: "backOffice", href: "/settings/kyra/back-office" },
    { id: "email", href: "/settings/email" },
  ] },
  { id: "channels", items: [
    { id: "widget", href: "/settings/widget" },
    { id: "connectedApps", href: "/settings/connected-apps" },
    { id: "apiKeys", href: "/settings/api-keys" },
  ] },
  { id: "account", items: [
    { id: "usage", href: "/settings/usage" },
    { id: "billing", href: "/settings/plan" },
    { id: "appearance", href: "/settings/appearance" },
    { id: "notifications", href: "/settings/notifications" },
  ] },
];

export function SettingsShell({ children, pilotMode = false }: { children: React.ReactNode; pilotMode?: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useTranslation("settings");
  const groups = settingsGroups.map((group) => ({
    ...group,
    items: group.items.filter((item) => !pilotMode || ["email", "businessProfile"].includes(item.id)),
  })).filter((group) => group.items.length > 0);
  const allItems = groups.flatMap((group) => group.items);
  const activeItem = [...allItems].sort((a, b) => b.href.length - a.href.length)
    .find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`)) ?? allItems[0]!;

  return (
    <section className="flex flex-1 flex-col gap-6">
      <PageHeader
        description={t(`navigation.descriptions.${activeItem.id}`)}
        eyebrow={t("header.title")}
        title={t(`sections.${activeItem.id}`)}
      />
      <div className="grid min-w-0 gap-4 lg:grid-cols-[14rem_minmax(0,1fr)] lg:items-start lg:gap-6">
        <Surface className="hidden rounded-2xl shadow-sm lg:sticky lg:top-24 lg:block">
          <nav aria-label={t("header.title")} className="p-3">
            {groups.map((group) => (
              <div className="mt-5 first:mt-0" key={group.id}>
                <h2 className="px-3 pb-2 text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {t(`navigation.groups.${group.id}`)}
                </h2>
                <div className="space-y-1">
                  {group.items.map((item) => {
                    const active = item.id === activeItem.id;
                    return (
                      <Link
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex min-h-10 items-center rounded-xl px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                        )}
                        href={item.href}
                        key={item.id}
                      >
                        {t(`sections.${item.id}`)}
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>
        </Surface>
        <label className="lg:hidden">
          <span className="sr-only">{t("navigation.selectSection")}</span>
          <NativeSelect
            aria-label={t("navigation.selectSection")}
            className="w-full"
            onChange={(event) => router.push(event.target.value)}
            value={activeItem.href}
          >
            {groups.map((group) => (
              <NativeSelectOptGroup key={group.id} label={t(`navigation.groups.${group.id}`)}>
                {group.items.map((item) => <NativeSelectOption key={item.id} value={item.href}>{t(`sections.${item.id}`)}</NativeSelectOption>)}
              </NativeSelectOptGroup>
            ))}
          </NativeSelect>
        </label>
        <div className="min-w-0">
          <NestedPageSurfaceProvider>{children}</NestedPageSurfaceProvider>
        </div>
      </div>
    </section>
  );
}
