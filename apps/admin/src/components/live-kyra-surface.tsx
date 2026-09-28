"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { tierAllows, type ServiceTier } from "@lobbystack/shared";

import { SectionBlock } from "@/components/section-block";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Surface } from "@/components/ui/surface";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { selectActiveBusiness } from "@/lib/active-business";
import type { WorkspaceViewModel } from "@/lib/page-view-models";
import { requestJson } from "@/lib/request-json";

type KyraSettings = {
  serviceTier: ServiceTier;
  backOfficeEnabled: boolean;
  missedCallTextEnabled: boolean;
  missedCallGreeting: string | null;
  textBackMessage: string | null;
  textBackMessageEs: string | null;
  smsAiEnabled: boolean;
  photoRequestsEnabled: boolean;
  voiceCallbackEnabled: boolean;
  callbackMode: "ask_first" | "automatic";
  callbackDelaySeconds: number;
  afterHoursMode: "send_now" | "hold";
  contactWindowStartMinutes: number;
  contactWindowEndMinutes: number;
  emergencyPhone: string | null;
  reviewUrl: string | null;
};

type MissedCallRow = { id: string; callerPhone: string; receivedAt: string; afterHours: boolean; status: string; callbackOutcome: string | null };
type Automation = { kind: string; enabled: boolean; messageTemplate: string; available: boolean };

const toTime = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const fromTime = (value: string) => { const [hours, minutes] = value.split(":").map(Number); return (hours ?? 0) * 60 + (minutes ?? 0); };

export function LiveKyraSurface() {
  const { i18n, t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const ids = { text: useId(), ai: useId(), photos: useId(), voice: useId(), mode: useId(), delay: useId(), afterHours: useId(), start: useId(), end: useId(), emergency: useId(), review: useId(), textBack: useId(), textBackEs: useId(), greeting: useId() };
  const businesses = useQuery({ queryKey: ["businesses"], queryFn: () => requestJson<{ businesses: WorkspaceViewModel[] }>("/api/businesses") });
  const business = selectActiveBusiness(businesses.data?.businesses);
  const canManage = business ? ["business_owner", "business_admin"].includes(business.role) : false;
  const scope = business ? `businessId=${encodeURIComponent(business.businessId)}` : "";
  const settings = useQuery({ queryKey: ["kyra-settings", business?.businessId], queryFn: () => requestJson<{ settings: KyraSettings }>(`/api/assistant/settings?${scope}`), enabled: Boolean(business) });
  const missed = useQuery({ queryKey: ["kyra-missed-calls", business?.businessId], queryFn: () => requestJson<{ missedCalls: MissedCallRow[] }>(`/api/assistant/missed-calls?${scope}`), enabled: Boolean(business) });
  const automations = useQuery({ queryKey: ["kyra-automations", business?.businessId], queryFn: () => requestJson<{ automations: Automation[] }>(`/api/assistant/automations?${scope}`), enabled: Boolean(business) });
  const [draft, setDraft] = useState<KyraSettings | null>(null);
  useEffect(() => { if (settings.data) setDraft(settings.data.settings); }, [settings.data]);

  const save = useMutation({
    mutationFn: (patch: Partial<KyraSettings>) => requestJson<{ settings: KyraSettings }>(`/api/assistant/settings?${scope}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: async () => { toast.success(t("kyra.saved")); await queryClient.invalidateQueries({ queryKey: ["kyra-settings", business?.businessId] }); },
    onError: (error) => toast.error(error.message),
  });
  const toggleAutomation = useMutation({
    mutationFn: (input: { kind: string; enabled?: boolean; messageTemplate?: string }) => requestJson(`/api/assistant/automations/${encodeURIComponent(input.kind)}?${scope}`, { method: "PATCH", body: JSON.stringify({ enabled: input.enabled, messageTemplate: input.messageTemplate }) }),
    onSuccess: async () => { toast.success(t("kyra.saved")); await queryClient.invalidateQueries({ queryKey: ["kyra-automations", business?.businessId] }); },
    onError: (error) => toast.error(error.message),
  });

  if (businesses.isLoading || settings.isLoading || !draft) return <Skeleton className="h-64 w-full rounded-xl" />;
  if (settings.isError) return <Alert><AlertTitle>{t("kyra.loadFailed")}</AlertTitle><AlertDescription>{settings.error.message}</AlertDescription></Alert>;

  const set = <K extends keyof KyraSettings>(key: K, value: KyraSettings[K]) => setDraft((current) => current ? { ...current, [key]: value } : current);
  const formatDate = (value: string) => new Intl.DateTimeFormat(i18n.resolvedLanguage ?? i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  // What the business pays for is set by Key 20, so these two fields are never sent from here.
  const { serviceTier: _tier, backOfficeEnabled: _addon, ...editable } = draft;
  const voiceAllowed = tierAllows(draft, "voice_callback");

  return (
    <div className="flex flex-col gap-8">
      <SectionBlock title={t("kyra.plan.title")} description={t("kyra.plan.description")}>
        <Surface className="flex flex-wrap items-center gap-3 p-6">
          <Badge>{t(`kyra.plan.tiers.${draft.serviceTier}`)}</Badge>
          {draft.backOfficeEnabled ? <Badge variant="secondary">{t("kyra.plan.backOffice")}</Badge> : null}
          <p className="type-body-muted">{t("kyra.plan.change")}</p>
        </Surface>
      </SectionBlock>

      <SectionBlock title={t("kyra.missedCalls.title")} description={t("kyra.missedCalls.description")}>
        <Surface className="p-6">
          <form className="flex flex-col gap-6" onSubmit={(event) => { event.preventDefault(); if (canManage) save.mutate(editable); }}>
            <FieldGroup>
              {([["text", "missedCallTextEnabled"], ["ai", "smsAiEnabled"], ["photos", "photoRequestsEnabled"]] as const).map(([id, key]) => (
                <Field key={key} orientation="horizontal">
                  <Switch aria-label={t(`kyra.fields.${key}.label`)} checked={draft[key]} disabled={!canManage} id={ids[id]} onCheckedChange={(value) => set(key, value)} />
                  <FieldContent><FieldLabel htmlFor={ids[id]}>{t(`kyra.fields.${key}.label`)}</FieldLabel><FieldDescription>{t(`kyra.fields.${key}.hint`)}</FieldDescription></FieldContent>
                </Field>
              ))}
              <Field>
                <FieldContent><FieldLabel htmlFor={ids.afterHours}>{t("kyra.fields.afterHoursMode.label")}</FieldLabel><FieldDescription>{t("kyra.fields.afterHoursMode.hint")}</FieldDescription></FieldContent>
                <NativeSelect disabled={!canManage} id={ids.afterHours} onChange={(event) => set("afterHoursMode", event.target.value as KyraSettings["afterHoursMode"])} value={draft.afterHoursMode}>
                  <NativeSelectOption value="send_now">{t("kyra.fields.afterHoursMode.sendNow")}</NativeSelectOption>
                  <NativeSelectOption value="hold">{t("kyra.fields.afterHoursMode.hold")}</NativeSelectOption>
                </NativeSelect>
              </Field>
              <Field orientation="horizontal">
                <Switch aria-label={t("kyra.fields.voiceCallbackEnabled.label")} checked={draft.voiceCallbackEnabled} disabled={!canManage || !voiceAllowed} id={ids.voice} onCheckedChange={(value) => set("voiceCallbackEnabled", value)} />
                <FieldContent><FieldLabel htmlFor={ids.voice}>{t("kyra.fields.voiceCallbackEnabled.label")}</FieldLabel><FieldDescription>{t("kyra.fields.voiceCallbackEnabled.hint")}</FieldDescription></FieldContent>
              </Field>
              {draft.voiceCallbackEnabled ? (
                <>
                  <Field>
                    <FieldContent><FieldLabel htmlFor={ids.mode}>{t("kyra.fields.callbackMode.label")}</FieldLabel><FieldDescription>{t("kyra.fields.callbackMode.hint")}</FieldDescription></FieldContent>
                    <NativeSelect disabled={!canManage} id={ids.mode} onChange={(event) => set("callbackMode", event.target.value as KyraSettings["callbackMode"])} value={draft.callbackMode}>
                      <NativeSelectOption value="ask_first">{t("kyra.fields.callbackMode.askFirst")}</NativeSelectOption>
                      <NativeSelectOption value="automatic">{t("kyra.fields.callbackMode.automatic")}</NativeSelectOption>
                    </NativeSelect>
                  </Field>
                  {draft.callbackMode === "automatic" ? (
                    <Field>
                      <FieldContent><FieldLabel htmlFor={ids.delay}>{t("kyra.fields.callbackDelaySeconds.label")}</FieldLabel><FieldDescription>{t("kyra.fields.callbackDelaySeconds.hint")}</FieldDescription></FieldContent>
                      <Input disabled={!canManage} id={ids.delay} inputMode="numeric" max={900} min={0} onChange={(event) => set("callbackDelaySeconds", Number(event.target.value))} type="number" value={draft.callbackDelaySeconds} />
                    </Field>
                  ) : null}
                </>
              ) : null}
              <div className="grid gap-6 sm:grid-cols-2">
                <Field>
                  <FieldContent><FieldLabel htmlFor={ids.start}>{t("kyra.fields.contactWindow.start")}</FieldLabel><FieldDescription>{t("kyra.fields.contactWindow.hint")}</FieldDescription></FieldContent>
                  <Input disabled={!canManage} id={ids.start} onChange={(event) => set("contactWindowStartMinutes", fromTime(event.target.value))} type="time" value={toTime(draft.contactWindowStartMinutes)} />
                </Field>
                <Field>
                  <FieldContent><FieldLabel htmlFor={ids.end}>{t("kyra.fields.contactWindow.end")}</FieldLabel></FieldContent>
                  <Input disabled={!canManage} id={ids.end} onChange={(event) => set("contactWindowEndMinutes", Math.max(1, fromTime(event.target.value)))} type="time" value={toTime(draft.contactWindowEndMinutes)} />
                </Field>
              </div>
              <Field>
                <FieldContent><FieldLabel htmlFor={ids.emergency}>{t("kyra.fields.emergencyPhone.label")}</FieldLabel><FieldDescription>{t("kyra.fields.emergencyPhone.hint")}</FieldDescription></FieldContent>
                <Input disabled={!canManage} id={ids.emergency} onChange={(event) => set("emergencyPhone", event.target.value || null)} placeholder="+17135550123" value={draft.emergencyPhone ?? ""} />
              </Field>
              <Field>
                <FieldContent><FieldLabel htmlFor={ids.textBack}>{t("kyra.fields.textBackMessage.label")}</FieldLabel><FieldDescription>{t("kyra.fields.textBackMessage.hint")}</FieldDescription></FieldContent>
                <Textarea disabled={!canManage} id={ids.textBack} maxLength={300} onChange={(event) => set("textBackMessage", event.target.value || null)} placeholder={t("kyra.fields.textBackMessage.placeholder")} value={draft.textBackMessage ?? ""} />
              </Field>
              <Field>
                <FieldContent><FieldLabel htmlFor={ids.textBackEs}>{t("kyra.fields.textBackMessageEs.label")}</FieldLabel></FieldContent>
                <Textarea disabled={!canManage} id={ids.textBackEs} maxLength={300} onChange={(event) => set("textBackMessageEs", event.target.value || null)} value={draft.textBackMessageEs ?? ""} />
              </Field>
              <Field>
                <FieldContent><FieldLabel htmlFor={ids.greeting}>{t("kyra.fields.missedCallGreeting.label")}</FieldLabel><FieldDescription>{t("kyra.fields.missedCallGreeting.hint")}</FieldDescription></FieldContent>
                <Textarea disabled={!canManage} id={ids.greeting} maxLength={400} onChange={(event) => set("missedCallGreeting", event.target.value || null)} value={draft.missedCallGreeting ?? ""} />
              </Field>
              <Field>
                <FieldContent><FieldLabel htmlFor={ids.review}>{t("kyra.fields.reviewUrl.label")}</FieldLabel><FieldDescription>{t("kyra.fields.reviewUrl.hint")}</FieldDescription></FieldContent>
                <Input disabled={!canManage} id={ids.review} onChange={(event) => set("reviewUrl", event.target.value || null)} placeholder="https://g.page/r/..." value={draft.reviewUrl ?? ""} />
              </Field>
            </FieldGroup>
            {canManage ? <Button className="self-start" disabled={save.isPending} type="submit">{save.isPending ? t("kyra.saving") : t("kyra.save")}</Button> : <p className="type-body-muted">{t("kyra.readOnly")}</p>}
          </form>
        </Surface>
      </SectionBlock>

      <SectionBlock title={t("kyra.recent.title")} description={t("kyra.recent.description")}>
        <Surface>
          {missed.isLoading ? <div className="p-6"><Skeleton className="h-24 w-full rounded-xl" /></div> : (missed.data?.missedCalls ?? []).length === 0 ? (
            <p className="type-body-muted p-6 text-center">{t("kyra.recent.empty")}</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader><TableRow><TableHead className="px-6">{t("kyra.recent.columns.caller")}</TableHead><TableHead>{t("kyra.recent.columns.when")}</TableHead><TableHead>{t("kyra.recent.columns.status")}</TableHead></TableRow></TableHeader>
                <TableBody>
                  {missed.data!.missedCalls.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="px-6 font-medium">{row.callerPhone}</TableCell>
                      <TableCell className="text-muted-foreground">{formatDate(row.receivedAt)}{row.afterHours ? ` · ${t("kyra.recent.afterHours")}` : ""}</TableCell>
                      <TableCell><Badge variant="secondary">{t(`kyra.recent.status.${row.status}`, { defaultValue: row.status })}</Badge></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Surface>
      </SectionBlock>

      <SectionBlock title={t("kyra.automations.title")} description={t("kyra.automations.description")}>
        <Surface className="divide-y">
          {(automations.data?.automations ?? []).map((automation) => (
            <AutomationRow automation={automation} canManage={canManage} key={automation.kind} onSave={(input) => toggleAutomation.mutate({ kind: automation.kind, ...input })} />
          ))}
        </Surface>
      </SectionBlock>
    </div>
  );
}

function AutomationRow({ automation, canManage, onSave }: { automation: Automation; canManage: boolean; onSave: (input: { enabled?: boolean; messageTemplate?: string }) => void }) {
  const { t } = useTranslation("settings");
  const id = useId();
  const [template, setTemplate] = useState(automation.messageTemplate);
  const editable = automation.kind !== "owner_brief";
  return (
    <div className="flex flex-col gap-3 p-6">
      <div className="flex items-start gap-3">
        <Switch aria-label={t(`kyra.automations.kinds.${automation.kind}.label`)} checked={automation.enabled} disabled={!canManage || !automation.available} id={id} onCheckedChange={(enabled) => onSave({ enabled })} />
        <div className="flex flex-col gap-1">
          <label className="font-medium" htmlFor={id}>{t(`kyra.automations.kinds.${automation.kind}.label`)}</label>
          <p className="type-body-muted">{t(`kyra.automations.kinds.${automation.kind}.hint`)}</p>
          {!automation.available ? <Badge className="self-start" variant="outline">{t(automation.kind === "payment_reminder" ? "kyra.automations.needsBackOffice" : "kyra.automations.needsTier3")}</Badge> : null}
        </div>
      </div>
      {editable && automation.available ? (
        <div className="flex flex-col gap-2 pl-12">
          <Textarea aria-label={t("kyra.automations.message")} disabled={!canManage} maxLength={320} onChange={(event) => setTemplate(event.target.value)} value={template} />
          {canManage && template !== automation.messageTemplate ? <Button className="self-start" onClick={() => onSave({ messageTemplate: template })} size="sm" variant="outline">{t("kyra.save")}</Button> : null}
        </div>
      ) : null}
    </div>
  );
}
