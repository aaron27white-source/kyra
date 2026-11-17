import { headers } from "next/headers";
import Link from "next/link";
import { Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { listSuperAdminClients, requireSuperAdminSession } from "@/lib/superadmin";

const labels: Record<string, string> = { draft: "Draft", needs_connection: "Needs connection", ready_for_test: "Ready for test", active: "Active", paused: "Paused", error: "Error" };

export default async function SuperAdminClientsPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const session = await requireSuperAdminSession(new Headers(await headers()));
  const params = await searchParams;
  const search = (params.q ?? "").trim().slice(0, 160);
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);
  const limit = 25;
  const result = await listSuperAdminClients({ userId: session.user.id, search, limit, offset: (page - 1) * limit });
  const href = (nextPage: number) => `/internal/clients?${new URLSearchParams({ ...(search ? { q: search } : {}), page: String(nextPage) })}`;
  return (
    <div className="space-y-7">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">Client operations</p><h1 className="mt-1 text-3xl font-semibold tracking-tight">Clients</h1><p className="mt-2 text-sm text-muted-foreground">Search tenants, continue a draft, or onboard a new client.</p></div><Link className={buttonVariants()} href="/internal/clients/new">Create client</Link></div>
      <form className="flex max-w-xl gap-2" method="get"><div className="relative flex-1"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input className="pl-9" defaultValue={search} maxLength={160} name="q" placeholder="Search name, slug, or owner email" /></div><Button type="submit">Search</Button></form>
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="min-w-[44rem] w-full text-left text-sm"><thead className="border-b border-border bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="px-5 py-3.5 font-medium">Client</th><th className="px-5 py-3.5 font-medium">Owner</th><th className="px-5 py-3.5 font-medium">Lifecycle</th><th className="px-5 py-3.5 font-medium">Updated</th></tr></thead><tbody className="divide-y divide-border">
          {result.data.map((client) => <tr className="transition-colors hover:bg-muted/30" key={client.id}><td className="px-5 py-4"><Link className="font-medium hover:underline" href={`/internal/clients/${client.id}`}>{client.name}</Link><p className="mt-0.5 text-xs text-muted-foreground">{client.slug}</p></td><td className="px-5 py-4 text-muted-foreground">{client.ownerEmail ?? "—"}</td><td className="px-5 py-4"><Badge variant="outline">{labels[client.lifecycle]}</Badge></td><td className="px-5 py-4 text-muted-foreground">{new Date(client.updatedAt).toLocaleDateString("en-CA")}</td></tr>)}
          {result.data.length === 0 && <tr><td className="px-5 py-12 text-center text-muted-foreground" colSpan={4}>No clients found.</td></tr>}
        </tbody></table>
      </div>
      <div className="flex items-center justify-between text-sm text-muted-foreground"><span>{result.total} clients</span><div className="flex gap-2">{page > 1 && <Link className={buttonVariants({ variant: "outline" })} href={href(page - 1)}>Previous</Link>}{result.hasNext && <Link className={buttonVariants({ variant: "outline" })} href={href(page + 1)}>Next</Link>}</div></div>
    </div>
  );
}
