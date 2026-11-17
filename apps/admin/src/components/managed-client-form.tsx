"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { SuperAdminClientDraft } from "@lobbystack/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Surface } from "@/components/ui/surface";
import { Textarea } from "@/components/ui/textarea";

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const emptyDraft: SuperAdminClientDraft = {
  name: "", slug: "", timezone: "America/New_York", businessType: "HVAC", ownerEmail: "", hours: [],
  settings: { ownerEmail: "", fromEmail: "", physicalAddress: "", serviceAreaZips: [], serviceAreaCities: [], services: [], emergencyKeywords: [], emergencyText: "", priceInformation: "", tone: "professional", confidenceThreshold: 0.8, tools: ["availability", "book", "handoff"], followups: { enabled: false, maxTouches: 0, delaysHours: [], dailyCap: 0 } },
};
const lines = (value: string) => value.split("\n").map((item) => item.trim()).filter(Boolean);
const csv = (value: string) => value.split(",").map((item) => item.trim()).filter(Boolean);

export function ManagedClientForm({ initial, tenantId, revision }: { initial?: SuperAdminClientDraft; tenantId?: string; revision?: number }) {
  const router = useRouter();
  const [draft, setDraft] = useState(initial ?? emptyDraft);
  const [services, setServices] = useState((initial?.settings.services ?? []).map((s) => `${s.name} | ${s.slug} | ${s.durationMinutes} | ${s.aliases.join(", ")}`).join("\n"));
  const [faqs, setFaqs] = useState((initial?.settings.faqs ?? []).map((f) => `${f.question} | ${f.answer}`).join("\n"));
  const [hours, setHours] = useState((initial?.hours ?? []).map((h) => `${h.dayOfWeek} | ${String(Math.floor(h.openMinutes / 60)).padStart(2,"0")}:${String(h.openMinutes%60).padStart(2,"0")} | ${String(Math.floor(h.closeMinutes/60)).padStart(2,"0")}:${String(h.closeMinutes%60).padStart(2,"0")}`).join("\n"));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const key = useRef(crypto.randomUUID());
  const inviteKey = useRef(crypto.randomUUID());
  const field = (name: keyof SuperAdminClientDraft) => (event: React.ChangeEvent<HTMLInputElement>) => setDraft((current) => ({ ...current, [name]: event.target.value }));
  const setting = (name: keyof SuperAdminClientDraft["settings"]) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft((current) => ({ ...current, settings: { ...current.settings, [name]: event.target.value } }));
  function completeDraft(): SuperAdminClientDraft {
    const time = (value: string) => { const [hour, minute] = value.split(":").map(Number); return hour! * 60 + minute!; };
    return { ...draft, ownerEmail: draft.ownerEmail.toLowerCase(), hours: lines(hours).map((row) => { const [day, open, close] = row.split("|").map((v) => v.trim()); return { dayOfWeek: Number(day), openMinutes: time(open!), closeMinutes: time(close!) }; }), settings: { ...draft.settings, ownerEmail: draft.ownerEmail.toLowerCase(), serviceAreaZips: csv(String(draft.settings.serviceAreaZips)), serviceAreaCities: csv(String(draft.settings.serviceAreaCities)), emergencyKeywords: csv(String(draft.settings.emergencyKeywords)), services: lines(services).map((row) => { const [name, slug, duration, aliases = ""] = row.split("|").map((v) => v.trim()); return { name: name!, slug: slug!, durationMinutes: Number(duration), aliases: csv(aliases) }; }), faqs: lines(faqs).map((row) => { const [question, ...answer] = row.split("|").map((v) => v.trim()); return { question: question!, answer: answer.join(" | ") }; }) } };
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(null);
    try {
      const payload = completeDraft();
      const url = tenantId ? `/api/internal/superadmin/clients/${tenantId}/draft` : "/api/internal/superadmin/clients";
      const response = await fetch(url, { method: tenantId ? "PUT" : "POST", headers: { "content-type": "application/json", ...(tenantId ? {} : { "idempotency-key": key.current }) }, body: JSON.stringify(tenantId ? { draft: payload, expectedRevision: revision } : { draft: payload }) });
      const result = await response.json().catch(() => null) as { tenantId?: string; error?: string } | null;
      if (!response.ok || !result?.tenantId) throw new Error(result?.error ?? "Could not save the client draft.");
      router.push(`/internal/clients/${result.tenantId}`); router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save the client draft."); setSaving(false); }
  }
  async function invite() {
    if (!tenantId) return; setSaving(true); setError(null);
    const response = await fetch(`/api/internal/superadmin/clients/${tenantId}/invite`, { method: "POST", headers: { "idempotency-key": inviteKey.current } });
    if (!response.ok) { setError("Could not queue the verified owner invitation."); setSaving(false); return; }
    setError("Invitation queued for the verified owner email."); setSaving(false);
  }
  return <form className="space-y-6" onSubmit={submit}>
    {error && <p className="rounded-xl border border-border bg-muted/50 p-3 text-sm" role="status">{error}</p>}
    <Section title="Business and owner"><Grid><L label="Business name"><Input required value={draft.name} onChange={field("name")} /></L><L label="Slug"><Input required pattern="[a-z][a-z0-9-]+" value={draft.slug} onChange={field("slug")} /></L><L label="IANA timezone"><Input required value={draft.timezone} onChange={field("timezone")} /></L><L label="Category"><Input required value={draft.businessType} onChange={field("businessType")} /></L><L label="Verified owner email"><Input required type="email" value={draft.ownerEmail} onChange={field("ownerEmail")} /></L><L label="Physical address"><Input required value={draft.settings.physicalAddress} onChange={setting("physicalAddress")} /></L><L label="Approved sender email"><Input required type="email" value={draft.settings.fromEmail} onChange={setting("fromEmail")} /></L><L label="Service ZIPs (comma separated)"><Input required value={String(draft.settings.serviceAreaZips)} onChange={setting("serviceAreaZips")} /></L><L label="Service cities (comma separated)"><Input value={String(draft.settings.serviceAreaCities)} onChange={setting("serviceAreaCities")} /></L></Grid></Section>
    <Section title="Services and hours"><L label="Services — name | slug | duration minutes | aliases"><Textarea required rows={5} value={services} onChange={(e) => setServices(e.target.value)} /></L><L label={`Hours — weekday number (0=${weekdays[0]}) | opens HH:MM | closes HH:MM`}><Textarea required rows={5} value={hours} onChange={(e) => setHours(e.target.value)} /></L></Section>
    <Section title="Policies and answers"><L label="FAQs — question | approved answer"><Textarea rows={5} value={faqs} onChange={(e) => setFaqs(e.target.value)} /></L><L label="Price information"><Textarea maxLength={2000} value={draft.settings.priceInformation} onChange={setting("priceInformation")} /></L><L label="Emergency keywords (comma separated)"><Input required value={String(draft.settings.emergencyKeywords)} onChange={setting("emergencyKeywords")} /></L><L label="Emergency response"><Textarea required minLength={20} value={draft.settings.emergencyText} onChange={setting("emergencyText")} /></L><L label="Escalation keywords (comma separated)"><Input value={draft.settings.escalation?.keywords.join(", ") ?? ""} onChange={(e) => setDraft((c) => ({ ...c, settings: { ...c.settings, escalation: e.target.value ? { keywords: csv(e.target.value), replyText: c.settings.escalation?.replyText ?? "A member of our team will follow up with you shortly." } : undefined } }))} /></L><L label="Escalation reply"><Textarea minLength={20} value={draft.settings.escalation?.replyText ?? ""} onChange={(e) => setDraft((c) => ({ ...c, settings: { ...c.settings, escalation: { keywords: c.settings.escalation?.keywords ?? [], replyText: e.target.value } } }))} /></L></Section>
    <div className="sticky bottom-4 flex flex-wrap gap-3 rounded-2xl border border-border bg-background/90 p-3 shadow-lg backdrop-blur"><Button disabled={saving} type="submit">{saving ? "Saving…" : tenantId ? "Save draft" : "Create draft client"}</Button>{tenantId && <Button disabled={saving} onClick={invite} type="button" variant="outline">Invite verified owner</Button>}</div>
  </form>;
}
function Section({ title, children }: { title: string; children: React.ReactNode }) { return <section><Surface className="space-y-5 p-5 sm:p-6"><div className="border-b border-border pb-4"><h2 className="text-lg font-semibold">{title}</h2></div>{children}</Surface></section>; }
function Grid({ children }: { children: React.ReactNode }) { return <div className="grid gap-4 md:grid-cols-2">{children}</div>; }
function L({ label, children }: { label: string; children: React.ReactNode }) { return <label className="space-y-2 text-sm font-medium"><span>{label}</span>{children}</label>; }
