"use client";

import { useEffect, useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { SectionBlock } from "@/components/section-block";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Surface } from "@/components/ui/surface";
import { Switch } from "@/components/ui/switch";
import { selectActiveBusiness } from "@/lib/active-business";
import { requestJson } from "@/lib/request-json";

type Business = {
  businessId: string;
  name: string;
  timezone?: string;
  businessType?: string;
  websiteUrl?: string | null;
  active: boolean;
  role: string;
};

export type BusinessHoursWindow = {
  dayOfWeek: number;
  openMinutes: number;
  closeMinutes: number;
};

type HoursDraft = { enabled: boolean; opens: string; closes: string };

const defaultHours: HoursDraft[] = Array.from({ length: 7 }, () => ({ enabled: false, opens: "09:00", closes: "17:00" }));

function toTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function fromTime(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

export function hoursDraftFromWindows(windows: BusinessHoursWindow[]): HoursDraft[] {
  return defaultHours.map((fallback, dayOfWeek) => {
    const window = windows.find((row) => row.dayOfWeek === dayOfWeek);
    return window ? { enabled: true, opens: toTime(window.openMinutes), closes: toTime(window.closeMinutes) } : { ...fallback };
  });
}

export function hoursWindowsFromDraft(draft: HoursDraft[]): BusinessHoursWindow[] {
  return draft.flatMap((row, dayOfWeek) => row.enabled ? [{ dayOfWeek, openMinutes: fromTime(row.opens), closeMinutes: fromTime(row.closes) }] : []);
}

export function LiveBusinessSettingsSurface() {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const nameId = useId();
  const timezoneId = useId();
  const typeId = useId();
  const websiteId = useId();
  const businesses = useQuery({
    queryKey: ["businesses"],
    queryFn: () => requestJson<{ businesses: Business[] }>("/api/businesses"),
  });
  const business = selectActiveBusiness(businesses.data?.businesses);
  const canManage = Boolean(business && ["business_owner", "business_admin"].includes(business.role));
  const hours = useQuery({
    queryKey: ["business-hours", business?.businessId],
    enabled: Boolean(business),
    queryFn: () => requestJson<{ hours: BusinessHoursWindow[] }>(`/api/business-hours?businessId=${encodeURIComponent(business!.businessId)}`),
  });
  const [profile, setProfile] = useState({ name: "", timezone: "", businessType: "", websiteUrl: "" });
  const [hoursDraft, setHoursDraft] = useState<HoursDraft[]>(defaultHours.map((row) => ({ ...row })));

  useEffect(() => {
    if (!business) return;
    setProfile({
      name: business.name,
      timezone: business.timezone ?? "UTC",
      businessType: business.businessType ?? "service_company",
      websiteUrl: business.websiteUrl ?? "",
    });
  }, [business]);

  useEffect(() => {
    if (hours.data) setHoursDraft(hoursDraftFromWindows(hours.data.hours));
  }, [hours.data]);

  const saveProfile = useMutation({
    mutationFn: () => requestJson(`/api/businesses?businessId=${encodeURIComponent(business!.businessId)}`, {
      method: "PATCH",
      body: JSON.stringify({ ...profile, websiteUrl: profile.websiteUrl.trim() || null }),
    }),
    onSuccess: async () => {
      toast.success(t("businessProfile.saved"));
      await queryClient.invalidateQueries({ queryKey: ["businesses"] });
    },
    onError: (error) => toast.error(error.message),
  });
  const saveHours = useMutation({
    mutationFn: () => requestJson(`/api/business-hours?businessId=${encodeURIComponent(business!.businessId)}`, {
      method: "PUT",
      body: JSON.stringify({ hours: hoursWindowsFromDraft(hoursDraft) }),
    }),
    onSuccess: async () => {
      toast.success(t("businessHours.saved"));
      await queryClient.invalidateQueries({ queryKey: ["business-hours", business?.businessId] });
    },
    onError: (error) => toast.error(error.message),
  });

  if (businesses.isLoading || (business && hours.isLoading)) return <Skeleton className="h-96 w-full rounded-xl" />;
  if (!business) return <p className="text-sm text-muted-foreground">{t("businessProfile.unavailable")}</p>;

  const updateHours = (dayOfWeek: number, patch: Partial<HoursDraft>) => {
    setHoursDraft((current) => current.map((row, index) => index === dayOfWeek ? { ...row, ...patch } : row));
  };

  return <div className="flex flex-col gap-8">
    <SectionBlock title={t("businessProfile.title")} description={t("businessProfile.description")}>
      <Surface className="p-6">
        <form className="flex flex-col gap-6" onSubmit={(event) => { event.preventDefault(); if (canManage) saveProfile.mutate(); }}>
          <FieldGroup className="grid gap-6 md:grid-cols-2">
            <Field><FieldLabel htmlFor={nameId}>{t("businessProfile.fields.name")}</FieldLabel><Input id={nameId} disabled={!canManage} required value={profile.name} onChange={(event) => setProfile((current) => ({ ...current, name: event.target.value }))} /></Field>
            <Field><FieldLabel htmlFor={timezoneId}>{t("businessProfile.fields.timezone")}</FieldLabel><Input id={timezoneId} disabled={!canManage} required value={profile.timezone} onChange={(event) => setProfile((current) => ({ ...current, timezone: event.target.value }))} /></Field>
            <Field><FieldLabel htmlFor={typeId}>{t("businessProfile.fields.type")}</FieldLabel><Input id={typeId} disabled={!canManage} required value={profile.businessType} onChange={(event) => setProfile((current) => ({ ...current, businessType: event.target.value }))} /></Field>
            <Field><FieldLabel htmlFor={websiteId}>{t("businessProfile.fields.website")}</FieldLabel><Input id={websiteId} disabled={!canManage} type="url" value={profile.websiteUrl} onChange={(event) => setProfile((current) => ({ ...current, websiteUrl: event.target.value }))} /></Field>
          </FieldGroup>
          {canManage ? <Button className="self-start" disabled={saveProfile.isPending} type="submit">{saveProfile.isPending ? t("businessProfile.saving") : t("businessProfile.save")}</Button> : <p className="text-sm text-muted-foreground">{t("businessProfile.readOnly")}</p>}
        </form>
      </Surface>
    </SectionBlock>

    <SectionBlock title={t("businessHours.title")} description={t("businessHours.description")}>
      <Surface className="divide-y">
        {hoursDraft.map((row, dayOfWeek) => <Field className="p-5" key={dayOfWeek} orientation="horizontal">
          <Switch aria-label={t("businessHours.enabled", { day: t(`businessHours.days.${dayOfWeek}`) })} checked={row.enabled} disabled={!canManage} onCheckedChange={(enabled) => updateHours(dayOfWeek, { enabled })} />
          <FieldContent>
            <FieldLabel>{t(`businessHours.days.${dayOfWeek}`)}</FieldLabel>
            <FieldDescription>{row.enabled ? t("businessHours.open") : t("businessHours.closed")}</FieldDescription>
          </FieldContent>
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
            <Input aria-label={t("businessHours.opens", { day: t(`businessHours.days.${dayOfWeek}`) })} disabled={!canManage || !row.enabled} type="time" value={row.opens} onChange={(event) => updateHours(dayOfWeek, { opens: event.target.value })} />
            <span className="text-sm text-muted-foreground">{t("businessHours.to")}</span>
            <Input aria-label={t("businessHours.closes", { day: t(`businessHours.days.${dayOfWeek}`) })} disabled={!canManage || !row.enabled} type="time" value={row.closes} onChange={(event) => updateHours(dayOfWeek, { closes: event.target.value })} />
          </div>
        </Field>)}
        {canManage ? <div className="p-5"><Button disabled={saveHours.isPending} onClick={() => saveHours.mutate()} type="button">{saveHours.isPending ? t("businessHours.saving") : t("businessHours.save")}</Button></div> : null}
      </Surface>
    </SectionBlock>
  </div>;
}
