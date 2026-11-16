"use client";

import { subscribeRealtimeQuery } from "@/lib/realtime-query";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { selectActiveBusiness } from "@/lib/active-business";
import { requestJson } from "@/lib/request-json";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { PageSurface } from "./page-surface";
import { Table, TableBody, TableCard, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

type Business = { businessId: string; name: string; slug: string; role: string; active: boolean };
type Appointment = { id: string; startsAt: string; endsAt: string; timezone: string; status: string; sourceChannel: string; calendarSyncState: string; intakeCompletionStatus?: string; serviceLocation: { line1?: string; unit?: string; city?: string; region?: string; postalCode?: string; country?: string; instructions?: string } | null; intakeAnswers: Record<string, string> | null; contactName: string | null; contactPhone: string | null; serviceName: string; staffName: string };

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error("Unable to load appointments.");
  return await response.json() as T;
}

function formatDate(appointment: Appointment, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: appointment.timezone }).format(new Date(appointment.startsAt));
}

export function LiveAppointmentsSurface() {
  const { t, i18n } = useTranslation("common");
  const queryClient = useQueryClient();
  const businesses = useQuery({ queryKey: ["businesses"], queryFn: () => getJson<{ businesses: Business[] }>("/api/businesses") });
  const business = selectActiveBusiness(businesses.data?.businesses);
  const appointments = useQuery({ queryKey: ["appointments", business?.businessId], queryFn: () => getJson<{ appointments: Appointment[] }>(`/api/appointments?businessId=${encodeURIComponent(business!.businessId)}`), enabled: Boolean(business) });

  useEffect(() => {
    if (!business?.businessId) return;
    return subscribeRealtimeQuery(queryClient, business?.businessId, ["appointments", business?.businessId], ["appointment.updated"]);
  }, [business?.businessId, queryClient]);

  const rows = appointments.data?.appointments ?? [];
  const canCorrectLocation = Boolean(business && ["business_owner", "business_admin", "scheduler"].includes(business.role));
  return <PageSurface description={t("appointments.pageDescription")} title={t("appointments.title")}><div className="flex w-full flex-col gap-6">
    <div className="flex items-center justify-between gap-4"><p className="type-section-description">{business ? t("appointments.summary", { name: business.name, count: rows.length }) : t("appointments.chooseWorkspace")}</p><Button disabled={!business || appointments.isFetching} onClick={() => void appointments.refetch()} variant="outline"><RefreshCw className={appointments.isFetching ? "animate-spin" : ""} />{t("appointments.refresh")}</Button></div>
    {businesses.isError ? <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm" role="alert"><p className="text-destructive">{t("appointments.unavailable")}</p><Button className="mt-3" onClick={() => void businesses.refetch()} size="sm" variant="outline">{t("appointments.retry")}</Button></div> : !business && !businesses.isLoading ? <div className="rounded-xl border p-8 text-center text-sm text-muted-foreground">{t("appointments.chooseWorkspace")}</div> : appointments.isError ? <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm" role="alert"><p className="text-destructive">{t("appointments.unavailable")}</p><Button className="mt-3" onClick={() => void appointments.refetch()} size="sm" variant="outline">{t("appointments.retry")}</Button></div> : <div className="overflow-x-auto rounded-xl"><TableCard><Table className="min-w-[72rem] w-full table-fixed"><colgroup><col className="w-[16%]" /><col className="w-[17%]" /><col className="w-[13%]" /><col className="w-[11%]" /><col className="w-[22%]" /><col className="w-[9%]" /><col className="w-[12%]" /></colgroup><TableHeader><TableRow><TableHead>{t("appointments.time")}</TableHead><TableHead>{t("appointments.customer")}</TableHead><TableHead>{t("appointments.service")}</TableHead><TableHead>{t("appointments.staff")}</TableHead><TableHead>{t("appointments.locationIntake")}</TableHead><TableHead>{t("appointments.status")}</TableHead><TableHead>{t("appointments.calendar")}</TableHead></TableRow></TableHeader><TableBody>{businesses.isLoading || appointments.isLoading ? <TableRow><TableCell className="h-24 text-center text-muted-foreground" colSpan={7}>{t("appointments.loading")}</TableCell></TableRow> : rows.length ? rows.map((appointment) => { const address = appointment.serviceLocation; const addressText = address ? [address.line1, address.unit, address.city, address.region, address.postalCode, address.country].filter(Boolean).join(", ") : t("appointments.noAddress"); const answers = Object.entries(appointment.intakeAnswers ?? {}).filter(([key]) => key !== "customerName" && key !== "callbackPhone"); const intakeStatus = appointment.intakeCompletionStatus ?? "not_required"; return <TableRow className="h-12" key={appointment.id}><TableCell className="font-medium">{formatDate(appointment, i18n.language)}</TableCell><TableCell className="ph-mask text-muted-foreground">{appointment.contactName ?? t("appointments.unknownContact")}<div className="text-xs">{appointment.contactPhone}</div></TableCell><TableCell className="text-muted-foreground">{appointment.serviceName}</TableCell><TableCell className="text-muted-foreground">{appointment.staffName}</TableCell><TableCell className="text-muted-foreground"><div>{addressText}</div>{address?.instructions ? <div className="text-xs">{address.instructions}</div> : null}{answers.map(([key, value]) => <div className="text-xs" key={key}>{key.replaceAll(/([A-Z])/g, " $1")}: {value}</div>)}<Badge className="mt-1" variant={intakeStatus === "complete" ? "secondary" : "outline"}>{t(`appointments.intakeStates.${intakeStatus}`, { defaultValue: intakeStatus.replaceAll("_", " ") })}</Badge></TableCell><TableCell><Badge variant="secondary">{t(`appointments.statuses.${appointment.status}`, { defaultValue: appointment.status })}</Badge></TableCell><TableCell className="capitalize text-muted-foreground">{t(`appointments.calendarStates.${appointment.calendarSyncState}`, { defaultValue: appointment.calendarSyncState.replaceAll("_", " ") })}</TableCell></TableRow>; }) : <TableRow><TableCell className="h-24 text-center text-muted-foreground" colSpan={7}>{t("appointments.empty")}</TableCell></TableRow>}</TableBody></Table></TableCard></div>}
    {canCorrectLocation && rows.some((row) => row.serviceLocation || row.intakeCompletionStatus === "pending_follow_up") ? <section className="rounded-xl border p-5"><h2 className="font-semibold">{t("appointments.correctLocations")}</h2><div className="mt-4 flex flex-col gap-3">{rows.filter((row) => row.serviceLocation || row.intakeCompletionStatus === "pending_follow_up").map((row) => <AppointmentLocationEditor key={row.id} appointment={row} businessId={business!.businessId} onSaved={() => void queryClient.invalidateQueries({ queryKey: ["appointments", business!.businessId] })} />)}</div></section> : null}
  </div></PageSurface>;
}

function AppointmentLocationEditor({ appointment, businessId, onSaved }: { appointment: Appointment; businessId: string; onSaved: () => void }) {
  const { t, i18n } = useTranslation("common");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const address = appointment.serviceLocation;
  return <details className="rounded-md border px-4 py-3"><summary className="cursor-pointer text-sm">{appointment.serviceName} · {formatDate(appointment, i18n.language)} · {appointment.contactName ?? t("appointments.unknownContact")}</summary><form className="mt-3 grid gap-3 sm:grid-cols-2" onSubmit={async (event) => {
    event.preventDefault(); setSaving(true); setMessage("");
    const form = new FormData(event.currentTarget);
    const serviceLocation = Object.fromEntries(["line1", "unit", "city", "region", "postalCode", "country", "instructions"].map((key) => [key, String(form.get(key) ?? "").trim()]).filter(([key, value]) => key === "line1" || key === "city" || key === "country" || Boolean(value)));
    try { await requestJson(`/api/appointments/${encodeURIComponent(appointment.id)}?businessId=${encodeURIComponent(businessId)}`, { method: "PATCH", body: JSON.stringify({ serviceLocation }) }); onSaved(); setMessage(t("appointments.locationSaved")); }
    catch { setMessage(t("appointments.locationSaveFailed")); }
    finally { setSaving(false); }
  }}><label className="flex flex-col gap-1 text-sm">{t("appointments.address")}<input className="h-9 rounded-md border bg-background px-3" name="line1" required defaultValue={address?.line1 ?? ""} /></label><label className="flex flex-col gap-1 text-sm">{t("appointments.unit")}<input className="h-9 rounded-md border bg-background px-3" name="unit" defaultValue={address?.unit ?? ""} /></label><label className="flex flex-col gap-1 text-sm">{t("appointments.city")}<input className="h-9 rounded-md border bg-background px-3" name="city" required defaultValue={address?.city ?? ""} /></label><label className="flex flex-col gap-1 text-sm">{t("appointments.region")}<input className="h-9 rounded-md border bg-background px-3" name="region" defaultValue={address?.region ?? ""} /></label><label className="flex flex-col gap-1 text-sm">{t("appointments.postalCode")}<input className="h-9 rounded-md border bg-background px-3" name="postalCode" defaultValue={address?.postalCode ?? ""} /></label><label className="flex flex-col gap-1 text-sm">{t("appointments.country")}<input className="h-9 rounded-md border bg-background px-3" name="country" required maxLength={2} defaultValue={address?.country ?? "US"} /></label><label className="flex flex-col gap-1 text-sm sm:col-span-2">{t("appointments.instructions")}<input className="h-9 rounded-md border bg-background px-3" name="instructions" defaultValue={address?.instructions ?? ""} /></label><div className="sm:col-span-2"><Button disabled={saving} type="submit">{saving ? t("appointments.saving") : t("appointments.saveLocation")}</Button>{message ? <span className="ml-3 text-sm text-muted-foreground" role="status">{message}</span> : null}</div></form></details>;
}
