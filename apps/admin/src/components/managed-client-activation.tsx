"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Circle, PauseCircle, RefreshCw, ShieldAlert } from "lucide-react";

import type { ManagedClientReadiness } from "@lobbystack/domain";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Surface } from "@/components/ui/surface";

const labels: Record<keyof ManagedClientReadiness["checks"], string> = {
  draft: "Business draft is valid",
  verifiedOwner: "Owner accepted the invite and verified email",
  calendarAuthorized: "Owner authorized Google Calendar",
  calendarSelected: "A writable calendar is selected",
  calendarFresh: "Calendar completed a recent sync",
  senderConfigured: "Resend and the approved sender are configured",
};

export function ManagedClientActivation({ initial }: { initial: ManagedClientReadiness }) {
  const router = useRouter();
  const activationKey = useRef(crypto.randomUUID());
  const pauseKey = useRef(crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [captureToken, setCaptureToken] = useState<string | null>(null);
  const [voiceEnabled, setVoiceEnabled] = useState(initial.voiceEnabled);
  async function act(action: "activate" | "pause") {
    setPending(true); setError(null);
    const response = await fetch(`/api/internal/superadmin/clients/${initial.tenantId}/activation`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": action === "activate" ? activationKey.current : pauseKey.current }, body: JSON.stringify({ action }) });
    const result = await response.json().catch(() => null) as { error?: string; captureToken?: string } | null;
    if (!response.ok) { setError(result?.error ?? "The operation could not be completed."); setPending(false); return; }
    setCaptureToken(result?.captureToken ?? null); setPending(false); router.refresh();
  }
  async function setVoice(enabled: boolean) {
    setPending(true); setError(null);
    const response = await fetch(`/api/internal/superadmin/clients/${initial.tenantId}/voice`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) });
    const result = await response.json().catch(() => null) as { error?: string } | null;
    if (!response.ok) setError(result?.error ?? "Voice setting could not be saved.");
    else setVoiceEnabled(enabled);
    setPending(false);
  }
  const active = initial.status === "active";
  const calendarReady = initial.checks.calendarAuthorized && initial.checks.calendarSelected && initial.checks.calendarFresh;
  return <Surface className="p-5 sm:p-6"><div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><div className="flex items-center gap-2"><h2 className="text-lg font-semibold">Activation</h2><Badge variant={active ? "secondary" : "outline"}>{initial.status.replaceAll("_", " ")}</Badge></div><p className="mt-1 text-sm text-muted-foreground">Activation stays locked until every owner and provider prerequisite is verified.</p></div><Button disabled={pending} onClick={() => router.refresh()} type="button" variant="outline"><RefreshCw className="size-4" /> Refresh</Button></div><div className="mt-5 grid gap-2 sm:grid-cols-2">{Object.entries(initial.checks).map(([keyName, ready]) => <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/20 p-3 text-sm" key={keyName}>{ready ? <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" /> : <Circle className="size-4 shrink-0 text-muted-foreground" />}<span>{labels[keyName as keyof typeof labels]}</span></div>)}</div><div className="mt-5 rounded-lg border border-border p-4"><div className="flex items-center justify-between gap-4"><div><p className="font-medium">Inbound AI voice</p><p className="text-sm text-muted-foreground">Enabling this tenant only accepts calls on its active, voice-enabled number.</p></div><Button disabled={pending} onClick={() => void setVoice(!voiceEnabled)} type="button" variant={voiceEnabled ? "default" : "outline"}>{voiceEnabled ? "Enabled" : "Enable voice"}</Button></div></div>{!initial.checks.senderConfigured && <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm"><p className="font-medium text-amber-950 dark:text-amber-100">{calendarReady ? "Calendar setup is complete. Email delivery is the remaining admin step." : "Email delivery must be configured before activation."}</p><p className="mt-2 text-amber-900/80 dark:text-amber-200/80">In the production deployment, set <code>LMC_PROVIDER_MODE=real</code> and <code>LMC_EMAIL_WORKER_ENABLED=true</code>, provide valid <code>RESEND_API_KEY</code> and <code>RESEND_WEBHOOK_SECRET</code> secrets, and make <code>LMC_EMAIL_FROM</code> exactly match this client&apos;s approved sender. Redeploy, then refresh this checklist.</p></div>}{initial.calendar?.error && <p className="mt-4 flex items-center gap-2 text-sm text-destructive"><ShieldAlert className="size-4" />{initial.calendar.error}</p>}{error && <p className="mt-4 text-sm text-destructive" role="alert">{error}</p>}{captureToken && <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-500/30 dark:bg-amber-500/10"><p className="text-sm font-medium text-amber-950 dark:text-amber-100">Capture token — shown once</p><code className="mt-2 block break-all text-xs text-amber-900 dark:text-amber-200">{captureToken}</code></div>}<div className="mt-5 flex flex-wrap gap-3">{active ? <Button disabled={pending} onClick={() => void act("pause")} type="button" variant="outline"><PauseCircle className="size-4" /> Pause client</Button> : <Button disabled={pending || !initial.canActivate} onClick={() => void act("activate")} type="button">Activate client</Button>}</div></Surface>;
}
