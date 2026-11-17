import Link from "next/link";
import { headers } from "next/headers";
import { Activity, AlertTriangle, ArrowRight, Building2, CheckCircle2, FlaskConical, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getSuperAdminOverview, requireSuperAdminSession, SUPERADMIN_LIFECYCLES } from "@/lib/superadmin";

const labels = {
  draft: "Draft",
  needs_connection: "Needs connection",
  ready_for_test: "Ready for test",
  active: "Active",
  paused: "Paused",
  error: "Error",
} as const;

const lifecycleTone = {
  draft: "bg-slate-400",
  needs_connection: "bg-amber-500",
  ready_for_test: "bg-sky-500",
  active: "bg-emerald-500",
  paused: "bg-violet-500",
  error: "bg-red-500",
} as const;

export default async function SuperAdminOverviewPage() {
  const session = await requireSuperAdminSession(new Headers(await headers()));
  const overview = await getSuperAdminOverview(session.user.id);
  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">Internal operations</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Overview</h1>
          <p className="mt-2 text-sm text-muted-foreground">Client readiness and pilot health in one place.</p>
        </div>
        <Link className="inline-flex h-9 items-center justify-center gap-2 self-start rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80 sm:self-auto" href="/internal/clients/new">
          <Building2 className="size-4" aria-hidden="true" /> Create client
        </Link>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard icon={Users} label="Total clients" value={overview.total} tone="text-sky-600 dark:text-sky-400" />
        <MetricCard icon={CheckCircle2} label="Active" value={overview.counts.active} tone="text-emerald-600 dark:text-emerald-400" />
        <MetricCard icon={FlaskConical} label="Ready for test" value={overview.counts.ready_for_test} tone="text-violet-600 dark:text-violet-400" />
        <MetricCard icon={AlertTriangle} label="Needs attention" value={overview.needsAttention} tone="text-amber-600 dark:text-amber-400" />
      </div>
      <Card>
        <CardHeader className="flex-row items-center justify-between border-b border-border pb-5">
          <div><CardTitle>Lifecycle</CardTitle><p className="mt-1 text-sm text-muted-foreground">Current state across every managed client.</p></div>
          <Link className="flex items-center gap-1 text-sm font-medium text-emerald-600 hover:text-emerald-700 dark:text-emerald-400" href="/internal/clients">View clients <ArrowRight className="size-4" /></Link>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {SUPERADMIN_LIFECYCLES.map((state) => <div className="flex items-center justify-between rounded-xl border border-border bg-muted/20 p-3.5" key={state}><span className="flex items-center gap-2.5 text-sm font-medium"><span className={`size-2 rounded-full ${lifecycleTone[state]}`} />{labels[state]}</span><Badge variant="secondary">{overview.counts[state]}</Badge></div>)}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="border-b border-border pb-5"><CardTitle>Recently edited</CardTitle></CardHeader>
        <CardContent className="divide-y divide-border">
          {overview.recent.length === 0 ? <div className="flex flex-col items-center py-10 text-center"><span className="flex size-11 items-center justify-center rounded-full bg-muted"><Activity className="size-5 text-muted-foreground" /></span><p className="mt-3 text-sm font-medium">No clients yet</p><p className="mt-1 text-sm text-muted-foreground">Create your first managed client to get started.</p></div> : overview.recent.map((client) => (
            <div className="flex items-center justify-between gap-4 py-4" key={client.id}>
              <div className="flex min-w-0 items-center gap-3"><span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted"><Building2 className="size-4 text-muted-foreground" /></span><div className="min-w-0"><Link className="block truncate text-sm font-medium hover:underline" href={`/internal/clients/${client.id}`}>{client.name}</Link><p className="truncate text-xs text-muted-foreground">{client.ownerEmail ?? client.slug}</p></div></div>
              <div className="shrink-0 text-right"><Badge variant="outline">{labels[client.lifecycle]}</Badge><p className="mt-1 text-xs text-muted-foreground">{new Date(client.updatedAt).toLocaleDateString("en-CA")}</p></div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function MetricCard({ icon: Icon, label, value, tone }: { icon: typeof Users; label: string; value: number; tone: string }) {
  return <Card className="gap-4 py-5"><CardHeader className="flex-row items-center justify-between"><CardTitle className="text-sm text-muted-foreground">{label}</CardTitle><span className={`flex size-9 items-center justify-center rounded-xl bg-muted ${tone}`}><Icon className="size-4" aria-hidden="true" /></span></CardHeader><CardContent className="text-3xl font-semibold tracking-tight">{value}</CardContent></Card>;
}
