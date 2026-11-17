import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { z } from "zod";
import { readManagedClientReadiness, readManagedLmcDraft } from "@lobbystack/domain";
import { ManagedClientActivation } from "@/components/managed-client-activation";
import { ManagedClientForm } from "@/components/managed-client-form";
import { getAppDatabase } from "@/lib/api-helpers";
import { getManagedActivationEnvironment } from "@/lib/superadmin-activation";
import { requireSuperAdminSession } from "@/lib/superadmin";

export default async function ManagedClientPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const parsed = z.string().uuid().safeParse((await params).tenantId);
  if (!parsed.success) notFound();
  const session = await requireSuperAdminSession(new Headers(await headers()));
  let record;
  let readiness;
  try {
    [record, readiness] = await Promise.all([
      readManagedLmcDraft({ db: getAppDatabase().db }, { actorUserId: session.user.id, tenantId: parsed.data }),
      readManagedClientReadiness({ db: getAppDatabase().db }, { actorUserId: session.user.id, tenantId: parsed.data, environment: getManagedActivationEnvironment() }),
    ]);
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 404) notFound();
    throw error;
  }
  return <div className="space-y-7"><div><p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">Managed onboarding</p><h1 className="mt-1 text-3xl font-semibold tracking-tight">{record.draft.name}</h1><p className="mt-2 text-sm text-muted-foreground">Draft revision {record.revision}. Saving changes does not activate providers.</p></div><ManagedClientActivation initial={readiness} /><ManagedClientForm initial={record.draft} revision={record.revision} tenantId={record.tenantId} /></div>;
}
