import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Building2, LayoutDashboard, ShieldCheck } from "lucide-react";

import { PATHNAME_HEADER } from "@/lib/locale-request";
import { requireSuperAdminEnrollmentSession, requireSuperAdminSession, SuperAdminAccessError } from "@/lib/superadmin";

export const dynamic = "force-dynamic";

export default async function InternalLayout({ children }: { children: React.ReactNode }) {
  const requestHeaders = await headers();
  const pathname = requestHeaders.get(PATHNAME_HEADER) ?? "/internal";
  if (pathname.startsWith("/internal/mfa")) return children;

  try {
    await requireSuperAdminSession(new Headers(requestHeaders));
  } catch (error) {
    if (error instanceof SuperAdminAccessError && error.status === 401) {
      redirect(`/en/login?returnTo=${encodeURIComponent(pathname)}`);
    }
    try {
      await requireSuperAdminEnrollmentSession(new Headers(requestHeaders));
      redirect("/internal/mfa/setup");
    } catch {
      notFound();
    }
  }

  const navigation = [
    { href: "/internal", label: "Overview", icon: LayoutDashboard, active: pathname === "/internal" },
    { href: "/internal/clients", label: "Clients", icon: Building2, active: pathname.startsWith("/internal/clients") },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <Link href="/internal" className="flex items-center gap-3 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span className="flex size-9 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <ShieldCheck className="size-5" aria-hidden="true" />
            </span>
            <span>
              <span className="block text-sm font-semibold leading-tight">Kyra</span>
              <span className="block text-xs text-muted-foreground">Super Admin</span>
            </span>
          </Link>
          <nav className="flex items-center gap-1 rounded-full border border-border bg-muted/40 p-1 text-sm" aria-label="Internal navigation">
            {navigation.map((item) => (
              <Link
                aria-current={item.active ? "page" : undefined}
                className={`flex items-center gap-2 rounded-full px-3 py-1.5 font-medium transition-colors ${item.active ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:bg-card/70 hover:text-foreground"}`}
                href={item.href}
                key={item.href}
              >
                <item.icon className="size-4" aria-hidden="true" /> {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:py-10">{children}</main>
    </div>
  );
}
