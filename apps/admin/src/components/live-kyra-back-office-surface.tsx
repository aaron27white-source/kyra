"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { SectionBlock } from "@/components/section-block";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldContent, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Surface } from "@/components/ui/surface";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { selectActiveBusiness } from "@/lib/active-business";
import type { WorkspaceViewModel } from "@/lib/page-view-models";
import { requestJson } from "@/lib/request-json";

type Kind = "quotes" | "invoices";
type LineItem = { description: string; quantity: number; unitCents: number };
type Doc = { id: string; contactId: string; title?: string; number?: string; status: string; amountCents?: number; totalCents?: number; currency: string; dueAt?: string | null; createdAt: string };
type Contact = { id: string; name: string | null; phone: string | null };

const NEXT: Record<Kind, Record<string, string[]>> = {
  quotes: { draft: ["sent"], sent: ["accepted", "declined"] },
  invoices: { draft: ["sent", "void"], sent: ["paid", "void"] },
};

export function LiveKyraBackOfficeSurface() {
  const { t } = useTranslation("settings");
  const businesses = useQuery({ queryKey: ["businesses"], queryFn: () => requestJson<{ businesses: WorkspaceViewModel[] }>("/api/businesses") });
  const business = selectActiveBusiness(businesses.data?.businesses);
  if (businesses.isLoading) return <Skeleton className="h-64 w-full rounded-xl" />;
  if (!business) return null;
  return (
    <div className="flex flex-col gap-8">
      <DocumentSection businessId={business.businessId} kind="quotes" canWrite={["business_owner", "business_admin", "scheduler"].includes(business.role)} />
      <DocumentSection businessId={business.businessId} kind="invoices" canWrite={["business_owner", "business_admin"].includes(business.role)} />
      <p className="type-body-muted">{t("kyra.backOffice.deferred")}</p>
    </div>
  );
}

function DocumentSection({ businessId, kind, canWrite }: { businessId: string; kind: Kind; canWrite: boolean }) {
  const { i18n, t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const scope = `businessId=${encodeURIComponent(businessId)}`;
  const docs = useQuery({ queryKey: ["kyra", kind, businessId], queryFn: () => requestJson<Record<Kind, Doc[]>>(`/api/assistant/${kind}?${scope}`), retry: false });
  const move = useMutation({
    mutationFn: (input: { id: string; status: string; textCustomer: boolean }) => requestJson(`/api/assistant/${kind}/${encodeURIComponent(input.id)}?${scope}`, { method: "PATCH", body: JSON.stringify({ status: input.status, textCustomer: input.textCustomer }) }),
    onSuccess: async () => { toast.success(t("kyra.saved")); await queryClient.invalidateQueries({ queryKey: ["kyra", kind, businessId] }); },
    onError: (error) => toast.error(error.message),
  });
  const money = (cents: number, currency: string) => new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language, { style: "currency", currency }).format(cents / 100);

  if (docs.isError) {
    return <SectionBlock title={t(`kyra.backOffice.${kind}.title`)}><Alert><AlertTitle>{t("kyra.backOffice.unavailable")}</AlertTitle><AlertDescription>{docs.error.message}</AlertDescription></Alert></SectionBlock>;
  }
  const rows = docs.data?.[kind] ?? [];
  return (
    <SectionBlock action={canWrite ? <Button onClick={() => setOpen(true)} size="sm"><Plus data-icon="inline-start" />{t(`kyra.backOffice.${kind}.create`)}</Button> : undefined} description={t(`kyra.backOffice.${kind}.description`)} title={t(`kyra.backOffice.${kind}.title`)}>
      <Surface>
        {docs.isLoading ? <div className="p-6"><Skeleton className="h-24 w-full rounded-xl" /></div> : rows.length === 0 ? <p className="type-body-muted p-6 text-center">{t("kyra.backOffice.empty")}</p> : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow><TableHead className="px-6">{t("kyra.backOffice.columns.name")}</TableHead><TableHead>{t("kyra.backOffice.columns.amount")}</TableHead><TableHead>{t("kyra.backOffice.columns.status")}</TableHead><TableHead className="px-6 text-right"><span className="sr-only">{t("kyra.backOffice.columns.actions")}</span></TableHead></TableRow></TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="px-6 font-medium">{row.title ?? row.number}</TableCell>
                    <TableCell className="tabular-nums">{money(row.amountCents ?? row.totalCents ?? 0, row.currency)}</TableCell>
                    <TableCell><Badge variant="secondary">{t(`kyra.backOffice.status.${row.status}`)}</Badge></TableCell>
                    <TableCell className="px-6 text-right">
                      <div className="flex justify-end gap-2">
                        {canWrite ? (NEXT[kind][row.status] ?? []).map((status) => (
                          <Button disabled={move.isPending} key={status} onClick={() => move.mutate({ id: row.id, status, textCustomer: status === "sent" })} size="sm" variant={status === "void" || status === "declined" ? "ghost" : "outline"}>{t(`kyra.backOffice.actions.${status}`)}</Button>
                        )) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Surface>
      <CreateDialog businessId={businessId} kind={kind} onOpenChange={setOpen} open={open} />
    </SectionBlock>
  );
}

function CreateDialog({ businessId, kind, open, onOpenChange }: { businessId: string; kind: Kind; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const ids = { search: useId(), contact: useId(), title: useId(), due: useId(), payment: useId() };
  const [search, setSearch] = useState("");
  const [contactId, setContactId] = useState("");
  const [title, setTitle] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [paymentUrl, setPaymentUrl] = useState("");
  const [items, setItems] = useState<Array<{ description: string; quantity: string; price: string }>>([{ description: "", quantity: "1", price: "" }]);
  const scope = `businessId=${encodeURIComponent(businessId)}`;
  const contacts = useQuery({ queryKey: ["kyra-contacts", businessId, search], queryFn: () => requestJson<{ contacts: Contact[] }>(`/api/contacts?${scope}&limit=20${search ? `&search=${encodeURIComponent(search)}` : ""}`), enabled: open });
  const lineItems: LineItem[] = items.map((item) => ({ description: item.description.trim(), quantity: Number(item.quantity), unitCents: Math.round(Number(item.price) * 100) }));
  const create = useMutation({
    mutationFn: () => requestJson(`/api/assistant/${kind}?${scope}`, { method: "POST", body: JSON.stringify(kind === "quotes" ? { contactId, title, lineItems } : { contactId, lineItems, ...(dueAt ? { dueAt: new Date(`${dueAt}T12:00:00`).toISOString() } : {}), ...(paymentUrl ? { paymentUrl } : {}) }) }),
    onSuccess: async () => { toast.success(t("kyra.saved")); onOpenChange(false); await queryClient.invalidateQueries({ queryKey: ["kyra", kind, businessId] }); },
    onError: (error) => toast.error(error.message),
  });
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>{t(`kyra.backOffice.${kind}.create`)}</DialogTitle><DialogDescription>{t(`kyra.backOffice.${kind}.description`)}</DialogDescription></DialogHeader>
        <form className="flex flex-col gap-6" onSubmit={(event) => { event.preventDefault(); if (contactId) create.mutate(); }}>
          <FieldGroup>
            <Field>
              <FieldContent><FieldLabel htmlFor={ids.search}>{t("kyra.backOffice.fields.customer")}</FieldLabel></FieldContent>
              <Input id={ids.search} onChange={(event) => setSearch(event.target.value)} placeholder={t("kyra.backOffice.fields.search")} value={search} />
              <NativeSelect aria-label={t("kyra.backOffice.fields.customer")} className="w-full" id={ids.contact} onChange={(event) => setContactId(event.target.value)} value={contactId}>
                <NativeSelectOption value="">{t("kyra.backOffice.fields.choose")}</NativeSelectOption>
                {(contacts.data?.contacts ?? []).map((contact) => <NativeSelectOption key={contact.id} value={contact.id}>{[contact.name, contact.phone].filter(Boolean).join(" · ")}</NativeSelectOption>)}
              </NativeSelect>
            </Field>
            {kind === "quotes" ? (
              <Field><FieldContent><FieldLabel htmlFor={ids.title}>{t("kyra.backOffice.fields.title")}</FieldLabel></FieldContent><Input id={ids.title} maxLength={200} onChange={(event) => setTitle(event.target.value)} value={title} /></Field>
            ) : (
              <>
                <Field><FieldContent><FieldLabel htmlFor={ids.due}>{t("kyra.backOffice.fields.dueAt")}</FieldLabel></FieldContent><Input id={ids.due} onChange={(event) => setDueAt(event.target.value)} type="date" value={dueAt} /></Field>
                <Field><FieldContent><FieldLabel htmlFor={ids.payment}>{t("kyra.backOffice.fields.paymentUrl")}</FieldLabel></FieldContent><Input id={ids.payment} onChange={(event) => setPaymentUrl(event.target.value)} placeholder="https://" value={paymentUrl} /></Field>
              </>
            )}
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">{t("kyra.backOffice.fields.lineItems")}</span>
              {items.map((item, index) => (
                <div className="flex gap-2" key={index}>
                  <Input aria-label={t("kyra.backOffice.fields.description")} onChange={(event) => setItems((current) => current.map((row, at) => at === index ? { ...row, description: event.target.value } : row))} placeholder={t("kyra.backOffice.fields.description")} value={item.description} />
                  <Input aria-label={t("kyra.backOffice.fields.quantity")} className="w-20" inputMode="decimal" onChange={(event) => setItems((current) => current.map((row, at) => at === index ? { ...row, quantity: event.target.value } : row))} value={item.quantity} />
                  <Input aria-label={t("kyra.backOffice.fields.price")} className="w-28" inputMode="decimal" onChange={(event) => setItems((current) => current.map((row, at) => at === index ? { ...row, price: event.target.value } : row))} placeholder="0.00" value={item.price} />
                  <Button aria-label={t("kyra.backOffice.fields.remove")} disabled={items.length === 1} onClick={() => setItems((current) => current.filter((_, at) => at !== index))} size="icon" type="button" variant="ghost"><Trash2 /></Button>
                </div>
              ))}
              <Button className="self-start" onClick={() => setItems((current) => [...current, { description: "", quantity: "1", price: "" }])} size="sm" type="button" variant="outline"><Plus data-icon="inline-start" />{t("kyra.backOffice.fields.addLine")}</Button>
            </div>
          </FieldGroup>
          <DialogFooter><Button className="w-full" disabled={!contactId || create.isPending || (kind === "quotes" && !title.trim())} type="submit">{create.isPending ? t("kyra.saving") : t("kyra.save")}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
