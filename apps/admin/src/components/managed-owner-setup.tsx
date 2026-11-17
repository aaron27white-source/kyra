"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarCheck, CheckCircle2, LoaderCircle, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

type Setup = {
  tenantId: string;
  connection: {
    id: string;
    externalAccountId: string;
    selectedCalendarId: string | null;
    status: string;
    lastSyncedAt: string | null;
  } | null;
  calendars: Array<{ id: string; summary: string; accessRole?: string; selected: boolean }>;
  discoveryError: string | null;
};

export function ManagedOwnerSetup() {
  const router = useRouter();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [calendarId, setCalendarId] = useState("");
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (showPending = true) => {
    if (showPending) setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/lmc/setup/calendar", { cache: "no-store", credentials: "include" });
      if (response.status === 404) {
        router.replace("/leads");
        router.refresh();
        return;
      }
      const body = await response.json().catch(() => null) as Setup | { error?: string } | null;
      if (!response.ok || !body || !("tenantId" in body)) {
        setError(body && "error" in body ? body.error ?? "Setup is unavailable." : "Setup is unavailable.");
      } else {
        setSetup(body);
        const storedCalendarId = body.connection?.selectedCalendarId ?? body.calendars.find((item) => item.selected)?.id ?? "";
        setCalendarId((current) => showPending || !current ? storedCalendarId : current);
      }
    } catch {
      setError("Setup is temporarily unavailable. Please try again.");
    } finally {
      if (showPending) setPending(false);
    }
  }, [router]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(false), 10_000);
    return () => window.clearInterval(interval);
  }, [load]);

  async function connect() {
    if (!setup) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/calendar/google/start?businessId=${encodeURIComponent(setup.tenantId)}`);
      const body = await response.json().catch(() => null) as { url?: string; error?: string } | null;
      if (!response.ok || !body?.url) {
        setError(body?.error ?? "Google authorization could not be started.");
        setPending(false);
        return;
      }
      window.location.assign(body.url);
    } catch {
      setError("Google authorization could not be started.");
      setPending(false);
    }
  }

  async function select() {
    if (!setup?.connection || !calendarId) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/lmc/setup/calendar", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId: setup.connection.id, calendarId }),
      });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) {
        setError(body?.error ?? "Calendar could not be selected.");
        setPending(false);
        return;
      }
      await load();
    } catch {
      setError("Calendar could not be selected.");
      setPending(false);
    }
  }

  if (!setup && pending) {
    return <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" /> Loading calendar setup…</div>;
  }

  const selectedCalendarId = setup?.connection?.selectedCalendarId ?? null;
  const calendarComplete = Boolean(
    selectedCalendarId
      && setup?.connection?.status === "connected"
      && setup.connection.lastSyncedAt,
  );
  const calendarSyncing = Boolean(selectedCalendarId && !calendarComplete);
  const unchangedSelection = Boolean(selectedCalendarId && calendarId === selectedCalendarId);

  return (
    <div className="mt-6 space-y-4 border-t border-border pt-6">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"><CalendarCheck className="size-5" /></span>
        <div>
          <h2 className="font-semibold">Connect your calendar</h2>
          <p className="mt-1 text-sm text-muted-foreground">Only you can authorize the Google account used for bookings. Kyra never shows its tokens to the pilot administrator.</p>
        </div>
      </div>

      {calendarComplete && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4" role="status">
          <p className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="size-4" /> Calendar setup complete</p>
          <p className="mt-2 text-sm text-muted-foreground">You are done. Your pilot administrator is finishing email setup and activation. This page checks automatically and will open your leads when the workspace is activated.</p>
        </div>
      )}

      {calendarSyncing && (
        <div className="rounded-xl border border-border bg-muted/30 p-4" role="status">
          <p className="flex items-center gap-2 font-medium"><LoaderCircle className="size-4 animate-spin" /> Calendar saved and syncing</p>
          <p className="mt-2 text-sm text-muted-foreground">No further action is needed. This page will update when the first synchronization finishes.</p>
        </div>
      )}

      {setup?.connection ? (
        <div className="space-y-3">
          <p className="flex items-center gap-2 text-sm"><CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" /> Connected as {setup.connection.externalAccountId}</p>
          {setup.calendars.length ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <NativeSelect aria-label="Booking calendar" onChange={(event) => setCalendarId(event.target.value)} value={calendarId}>
                <NativeSelectOption value="">Select a writable calendar</NativeSelectOption>
                {setup.calendars.filter((item) => ["owner", "writer"].includes(item.accessRole ?? "")).map((item) => <NativeSelectOption key={item.id} value={item.id}>{item.summary}</NativeSelectOption>)}
              </NativeSelect>
              <Button disabled={pending || !calendarId || unchangedSelection} onClick={() => void select()} type="button">{unchangedSelection ? "Calendar saved" : "Save calendar"}</Button>
            </div>
          ) : <p className="text-sm text-muted-foreground">{setup.discoveryError ?? "No writable calendars were found."}</p>}
          <Button disabled={pending} onClick={() => void connect()} type="button" variant="outline">Reconnect Google</Button>
        </div>
      ) : <Button disabled={pending || !setup} onClick={() => void connect()} type="button">Authorize Google Calendar</Button>}

      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      <Button disabled={pending} onClick={() => void load()} size="sm" type="button" variant="ghost"><RefreshCw className="size-4" /> Check activation</Button>
    </div>
  );
}
