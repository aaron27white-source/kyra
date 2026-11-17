"use client";

import { getCoreRowModel, getPaginationRowModel, useReactTable, type PaginationState } from "@tanstack/react-table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Plus, Search } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useSetupAction } from "@/lib/use-setup-action";
import { selectActiveBusiness } from "@/lib/active-business";
import { formatDateTime } from "@/lib/locale";
import { requestJson } from "@/lib/request-json";
import { DataTablePagination } from "./data-table/pagination";
import { TableCardSkeleton } from "./loading-skeletons";
import { PageSurface } from "./page-surface";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { Table, TableBody, TableCard, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Textarea } from "./ui/textarea";

type Business = { businessId: string; name: string; active: boolean; role: string };
type IntakeRequirement = "required" | "optional" | "disabled";
type ServiceType = "onsite" | "remote" | "in_office" | "unspecified";
type Service = { id: string; name: string; slug: string; durationMinutes: number; description: string | null; active: boolean; createdAt: string; intakePolicy?: { serviceType: ServiceType; fields: { serviceAddress?: IntakeRequirement; postalCode?: IntakeRequirement; issueDescription?: IntakeRequirement; urgency?: IntakeRequirement; equipmentDetails?: IntakeRequirement; propertyType?: IntakeRequirement; workScope?: IntakeRequirement; customerName?: IntakeRequirement }; serviceArea?: { allowedCities?: string[]; allowedPostalCodes?: string[] } } | null };
type Catalog = { services: Service[]; receptionistProfile?: { intakePolicy?: { serviceType: ServiceType; fields: Record<string, IntakeRequirement> } | null } | null };
type ServiceValues = { name: string; description: string; durationMinutes: string; active: boolean; serviceType: ServiceType; customerName: IntakeRequirement; serviceAddress: IntakeRequirement; postalCode: IntakeRequirement; issueDescription: IntakeRequirement; equipmentDetails: IntakeRequirement; allowedCities: string; allowedPostalCodes: string };

const emptyValues: ServiceValues = { name: "", description: "", durationMinutes: "30", active: true, serviceType: "unspecified", customerName: "optional", serviceAddress: "disabled", postalCode: "disabled", issueDescription: "optional", equipmentDetails: "optional", allowedCities: "", allowedPostalCodes: "" };

function serviceSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "service";
}

function summarize(value: string, length = 72): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > length ? `${normalized.slice(0, length - 3).trimEnd()}...` : normalized;
}

export function LiveServicesSurface() {
  const { i18n, t } = useTranslation("agent");
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 10 });
  const [editingService, setEditingService] = useState<Service | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [businessIntake, setBusinessIntake] = useState<{ serviceType: ServiceType; serviceAddress: IntakeRequirement; postalCode: IntakeRequirement; issueDescription: IntakeRequirement; equipmentDetails: IntakeRequirement }>({ serviceType: "unspecified", serviceAddress: "disabled", postalCode: "disabled", issueDescription: "optional", equipmentDetails: "optional" });
  const businesses = useQuery({ queryKey: ["businesses"], queryFn: () => requestJson<{ businesses: Business[] }>("/api/businesses") });
  const business = selectActiveBusiness(businesses.data?.businesses);
  const canManage = business ? ["business_owner", "business_admin"].includes(business.role) : false;
  useSetupAction(canManage, useCallback((action: string) => { if (action !== "service") return false; setEditingService(null); setEditorOpen(true); return true; }, []));
  const catalog = useQuery({ queryKey: ["catalog", business?.businessId], enabled: Boolean(business), queryFn: () => requestJson<Catalog>(`/api/catalog?businessId=${encodeURIComponent(business!.businessId)}&limit=100`) });
  const invalidate = async () => { await queryClient.invalidateQueries({ queryKey: ["catalog", business?.businessId] }); };
  useEffect(() => { const policy = catalog.data?.receptionistProfile?.intakePolicy; if (policy) setBusinessIntake({ serviceType: policy.serviceType, serviceAddress: policy.fields.serviceAddress ?? "disabled", postalCode: policy.fields.postalCode ?? "disabled", issueDescription: policy.fields.issueDescription ?? "optional", equipmentDetails: policy.fields.equipmentDetails ?? "optional" }); }, [catalog.data]);
  const saveBusinessIntake = useMutation({ mutationFn: () => requestJson("/api/catalog?businessId=" + encodeURIComponent(business!.businessId), { method: "PATCH", body: JSON.stringify({ intakePolicy: { serviceType: businessIntake.serviceType, fields: { serviceAddress: businessIntake.serviceAddress, postalCode: businessIntake.postalCode, issueDescription: businessIntake.issueDescription, equipmentDetails: businessIntake.equipmentDetails } } }) }), onSuccess: invalidate });
  const saveService = useMutation({
    mutationFn: ({ service, values }: { service: Service | null; values: ServiceValues }) => {
      const allowedCities = values.allowedCities.split(",").map((value) => value.trim()).filter(Boolean);
      const allowedPostalCodes = values.allowedPostalCodes.split(",").map((value) => value.trim()).filter(Boolean);
      const payload = { name: values.name.trim(), slug: service?.slug ?? serviceSlug(values.name), durationMinutes: Number(values.durationMinutes), description: values.description.trim() || null, active: values.active, intakePolicy: { serviceType: values.serviceType, fields: { customerName: values.customerName, serviceAddress: values.serviceAddress, postalCode: values.postalCode, issueDescription: values.issueDescription, equipmentDetails: values.equipmentDetails }, ...(allowedCities.length || allowedPostalCodes.length ? { serviceArea: { ...(allowedCities.length ? { allowedCities } : {}), ...(allowedPostalCodes.length ? { allowedPostalCodes } : {}) } } : {}) } };
      return service
        ? requestJson(`/api/catalog/${encodeURIComponent(service.id)}?businessId=${encodeURIComponent(business!.businessId)}`, { method: "PATCH", body: JSON.stringify(payload) })
        : requestJson("/api/catalog", { method: "POST", body: JSON.stringify({ businessId: business!.businessId, ...payload }) });
    },
    onSuccess: invalidate,
  });
  const toggleService = useMutation({ mutationFn: (service: Service) => requestJson(`/api/catalog/${encodeURIComponent(service.id)}?businessId=${encodeURIComponent(business!.businessId)}`, { method: "PATCH", body: JSON.stringify({ active: !service.active }) }), onSuccess: invalidate });
  const services = useMemo(() => {
    const query = search.trim().toLowerCase();
    const rows = catalog.data?.services ?? [];
    return query ? rows.filter((service) => `${service.name} ${service.description ?? ""} ${service.durationMinutes}`.toLowerCase().includes(query)) : rows;
  }, [catalog.data, search]);
  const table = useReactTable({ data: services, columns: [], getCoreRowModel: getCoreRowModel(), getPaginationRowModel: getPaginationRowModel(), onPaginationChange: setPagination, state: { pagination } });
  const pageRows = table.getRowModel().rows.map((row) => row.original);

  useEffect(() => { setPagination((current) => ({ ...current, pageIndex: 0 })); }, [search]);

  if (businesses.isLoading) return <TableCardSkeleton columns={5} />;
  if (businesses.isError || catalog.isError) return <p className="text-sm text-destructive">{t("sections.services.unavailable")}</p>;
  if (!business) return <PageSurface description="" title=""><p className="text-sm text-muted-foreground">{t("empty.description")}</p></PageSurface>;

  return <PageSurface description="" title=""><div className="flex w-full flex-col gap-6">
    {canManage ? <section className="rounded-xl border p-5"><h2 className="font-semibold">Business default voice intake</h2><p className="mb-4 mt-1 text-sm text-muted-foreground">Applies to services without an override. Existing businesses remain unspecified until you save this policy.</p><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><label className="flex flex-col gap-1 text-sm">Default service type<select className="h-10 rounded-md border bg-background px-3" onChange={(event) => setBusinessIntake((value) => ({ ...value, serviceType: event.target.value as ServiceType }))} value={businessIntake.serviceType}><option value="unspecified">Unspecified</option><option value="onsite">On-site</option><option value="remote">Remote</option><option value="in_office">In office</option></select></label>{([ ["serviceAddress", "Service address"], ["postalCode", "Postal / ZIP code"], ["issueDescription", "Work description"], ["equipmentDetails", "Equipment details"] ] as const).map(([key, label]) => <label className="flex flex-col gap-1 text-sm" key={key}>{label}<select className="h-10 rounded-md border bg-background px-3" onChange={(event) => setBusinessIntake((value) => ({ ...value, [key]: event.target.value as IntakeRequirement }))} value={businessIntake[key]}><option value="required">Required</option><option value="optional">Optional</option><option value="disabled">Disabled</option></select></label>)}</div><Button className="mt-4" disabled={saveBusinessIntake.isPending || catalog.isLoading} onClick={() => saveBusinessIntake.mutate()}>{saveBusinessIntake.isPending ? "Saving…" : "Save business defaults"}</Button></section> : null}
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div className="relative max-w-sm flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input className="pl-10" onChange={(event) => setSearch(event.target.value)} placeholder={t("table.searchPlaceholder")} value={search} /></div>{canManage ? <div className="flex shrink-0 flex-wrap items-center gap-2"><Button onClick={() => { setEditingService(null); setEditorOpen(true); }}><Plus data-icon="inline-start" />{t("sections.services.addKnowledge")}</Button></div> : null}</div>
    {catalog.isLoading ? <TableCardSkeleton columns={5} /> : <><TableCard><Table className="min-w-[60rem] w-full table-fixed"><colgroup><col className="w-[18%]" /><col className="w-[42%]" /><col className="w-[14%]" /><col className="w-[18%]" /><col className="w-12" /></colgroup><TableHeader><TableRow><TableHead>{t("table.title")}</TableHead><TableHead>{t("table.preview")}</TableHead><TableHead>{t("table.status")}</TableHead><TableHead className="text-right">{t("table.added")}</TableHead><TableHead /></TableRow></TableHeader><TableBody>{pageRows.length ? pageRows.map((service) => <TableRow className={canManage ? "h-12 cursor-pointer" : "h-12"} key={service.id} onClick={() => { if (canManage) { setEditingService(service); setEditorOpen(true); } }}><TableCell className="max-w-0 overflow-hidden"><span className="block truncate font-medium" title={service.name}>{summarize(service.name, 32)}</span></TableCell><TableCell className="max-w-0 overflow-hidden"><span className="block truncate text-sm text-muted-foreground" title={service.description ?? t("sections.services.durationValue", { count: service.durationMinutes })}>{summarize(service.description ?? t("sections.services.durationValue", { count: service.durationMinutes }))}</span></TableCell><TableCell>{service.active ? <Badge variant="secondary">{t("sections.services.status.indexed")}</Badge> : <Badge variant="outline">{t("table.disabled")}</Badge>}</TableCell><TableCell className="text-right text-sm text-muted-foreground">{formatDateTime(service.createdAt, i18n.resolvedLanguage ?? i18n.language, { dateStyle: "medium", timeStyle: "short" })}</TableCell><TableCell onClick={(event) => event.stopPropagation()}>{canManage ? <DropdownMenu><DropdownMenuTrigger render={<Button aria-label={t("actions.moreOptions")} size="icon-sm" variant="ghost"><MoreHorizontal /></Button>} /><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => { setEditingService(service); setEditorOpen(true); }}>{t("sections.services.editKnowledge")}</DropdownMenuItem><DropdownMenuItem onClick={() => toggleService.mutate(service)}>{service.active ? t("actions.disable") : t("actions.enable")}</DropdownMenuItem></DropdownMenuContent></DropdownMenu> : null}</TableCell></TableRow>) : <TableRow><TableCell className="h-24 text-center text-muted-foreground" colSpan={5}>{search ? t("table.empty") : t("sections.services.emptyState")}</TableCell></TableRow>}</TableBody></Table></TableCard>
    <DataTablePagination labels={{ rowsPerPage: t("pagination.rowsPerPage"), pageOf: (page, total) => t("pagination.pageOf", { page, total }), firstPage: t("pagination.firstPage"), previousPage: t("pagination.previousPage"), nextPage: t("pagination.nextPage"), lastPage: t("pagination.lastPage"), goToPage: (page) => t("pagination.goToPage", { page }) }} table={table} /></>}
    <ServiceEditor editing={editingService} onOpenChange={(open) => { setEditorOpen(open); if (!open) setEditingService(null); }} open={editorOpen} pending={saveService.isPending} save={async (values) => { await saveService.mutateAsync({ service: editingService, values }); setEditorOpen(false); setEditingService(null); }} />
  </div></PageSurface>;
}

function ServiceEditor({ editing, onOpenChange, open, pending, save }: { editing: Service | null; onOpenChange: (open: boolean) => void; open: boolean; pending: boolean; save: (values: ServiceValues) => Promise<void> }) {
  const { t } = useTranslation("agent");
  const titleId = useId(); const durationId = useId(); const descriptionId = useId(); const activeId = useId();
  const [values, setValues] = useState<ServiceValues>(emptyValues);
  useEffect(() => {
    if (!open) return;
    setValues(editing ? {
      ...emptyValues, name: editing.name, description: editing.description ?? "", durationMinutes: String(editing.durationMinutes), active: editing.active,
      serviceType: editing.intakePolicy?.serviceType ?? "unspecified", customerName: editing.intakePolicy?.fields.customerName ?? "optional",
      serviceAddress: editing.intakePolicy?.fields.serviceAddress ?? "disabled", postalCode: editing.intakePolicy?.fields.postalCode ?? "disabled",
      issueDescription: editing.intakePolicy?.fields.issueDescription ?? "optional", equipmentDetails: editing.intakePolicy?.fields.equipmentDetails ?? "optional",
      allowedCities: editing.intakePolicy?.serviceArea?.allowedCities?.join(", ") ?? "", allowedPostalCodes: editing.intakePolicy?.serviceArea?.allowedPostalCodes?.join(", ") ?? "",
    } : emptyValues);
  }, [editing, open]);
  const intakeSelect = (label: string, value: IntakeRequirement, key: "customerName" | "serviceAddress" | "postalCode" | "issueDescription" | "equipmentDetails") => <Field key={key}><FieldContent><FieldLabel>{label}</FieldLabel></FieldContent><select className="h-10 rounded-md border bg-background px-3 text-sm" onChange={(event) => setValues((current) => ({ ...current, [key]: event.target.value as IntakeRequirement }))} value={value}><option value="required">Required</option><option value="optional">Optional</option><option value="disabled">Disabled</option></select></Field>;
  return <Dialog onOpenChange={onOpenChange} open={open}>
    <DialogContent className="sm:max-w-xl"><DialogHeader><DialogTitle>{t(editing ? "sections.services.editKnowledge" : "sections.services.addKnowledge")}</DialogTitle><DialogDescription>{t(editing ? "sections.services.editKnowledgeDescription" : "sections.services.addKnowledgeDescription")}</DialogDescription></DialogHeader>
      <form className="flex flex-col gap-6" onSubmit={(event) => { event.preventDefault(); if (!pending && values.name.trim() && Number.isInteger(Number(values.durationMinutes)) && Number(values.durationMinutes) > 0) void save(values); }}>
        <FieldGroup>
          <Field><FieldContent><FieldLabel htmlFor={titleId}>{t("sections.services.fields.title.label")}</FieldLabel><FieldDescription>{t("sections.services.fields.title.hint")}</FieldDescription></FieldContent><Input id={titleId} onChange={(event) => setValues((current) => ({ ...current, name: event.target.value }))} placeholder={t("sections.services.fields.title.placeholder")} value={values.name} /></Field>
          <Field><FieldContent><FieldLabel htmlFor={durationId}>{t("sections.services.fields.duration.label")}</FieldLabel><FieldDescription>{t("sections.services.fields.duration.hint")}</FieldDescription></FieldContent><Input id={durationId} inputMode="numeric" min="1" step="1" onChange={(event) => setValues((current) => ({ ...current, durationMinutes: event.target.value }))} placeholder={t("sections.services.fields.duration.placeholder")} type="number" value={values.durationMinutes} /></Field>
          <Field><FieldContent><FieldLabel htmlFor={descriptionId}>{t("sections.services.fields.content.label")}</FieldLabel><FieldDescription>{t("sections.services.fields.content.hint")}</FieldDescription></FieldContent><Textarea className="min-h-24" id={descriptionId} onChange={(event) => setValues((current) => ({ ...current, description: event.target.value }))} placeholder={t("sections.services.fields.content.placeholder")} value={values.description} /></Field>
          <Field><FieldContent><FieldLabel>Service type</FieldLabel><FieldDescription>On-site services default to requiring a service address. Existing services stay unspecified until configured.</FieldDescription></FieldContent><select className="h-10 rounded-md border bg-background px-3 text-sm" onChange={(event) => { const serviceType = event.target.value as ServiceType; setValues((current) => ({ ...current, serviceType, serviceAddress: serviceType === "onsite" && current.serviceAddress === "disabled" ? "required" : current.serviceAddress })); }} value={values.serviceType}><option value="unspecified">Unspecified (legacy)</option><option value="onsite">On-site</option><option value="remote">Remote</option><option value="in_office">In office</option></select></Field>
          {intakeSelect("Customer name", values.customerName, "customerName")}{intakeSelect("Service address", values.serviceAddress, "serviceAddress")}{intakeSelect("Postal / ZIP code", values.postalCode, "postalCode")}{intakeSelect("Work description", values.issueDescription, "issueDescription")}{intakeSelect("Equipment details", values.equipmentDetails, "equipmentDetails")}
          <Field><FieldContent><FieldLabel>Allowed service cities</FieldLabel><FieldDescription>Optional exact city allowlist, separated by commas. Leave blank to allow any city.</FieldDescription></FieldContent><Input onChange={(event) => setValues((current) => ({ ...current, allowedCities: event.target.value }))} placeholder="Miami, Fort Lauderdale" value={values.allowedCities} /></Field>
          <Field><FieldContent><FieldLabel>Allowed postal / ZIP codes</FieldLabel><FieldDescription>Optional exact postal-code allowlist, separated by commas. Leave blank to allow any postal code.</FieldDescription></FieldContent><Input onChange={(event) => setValues((current) => ({ ...current, allowedPostalCodes: event.target.value }))} placeholder="33101, 33301" value={values.allowedPostalCodes} /></Field>
          <Field orientation="horizontal"><Switch aria-label={t("sections.services.fields.active.label")} checked={values.active} id={activeId} onCheckedChange={(active) => setValues((current) => ({ ...current, active }))} /><FieldContent><FieldLabel htmlFor={activeId}>{t("sections.services.fields.active.label")}</FieldLabel><FieldDescription>{t("sections.services.fields.active.hint")}</FieldDescription></FieldContent></Field>
        </FieldGroup>
        <DialogFooter><Button className="w-full" disabled={pending} type="submit">{pending ? t("actions.saving") : t(editing ? "actions.saveChanges" : "actions.save")}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
