import { createHash, randomUUID } from "node:crypto";
import { lmcEmailAddressSchema, type LmcEmailDecision, type LmcEmailModel, type LmcModelPrompt, type LmcOutboundEmail } from "@lobbystack/contracts";

export function lmcProviderMode(env: Record<string,string | undefined> = process.env): "fake" | "real" {
  const mode = env.LMC_PROVIDER_MODE;
  if (mode !== undefined && mode !== "fake" && mode !== "real") throw new Error("INVALID_LMC_PROVIDER_MODE");
  if (env.NODE_ENV === "production" && mode !== "real") throw new Error("PRODUCTION_REQUIRES_EXPLICIT_REAL_PROVIDERS");
  return mode ?? "fake";
}

const permittedHeaders = new Set(["message-id", "in-reply-to", "references", "list-unsubscribe", "list-unsubscribe-post", "auto-submitted"]);
/** Used by fake and real transports before a message reaches an external API. */
export function validateLmcOutboundEmail(input: LmcOutboundEmail): void {
  if (!lmcEmailAddressSchema.safeParse(input.from).success || !lmcEmailAddressSchema.safeParse(input.to).success || !lmcEmailAddressSchema.safeParse(input.replyTo).success
    || /[\r\n\0]/.test(input.subject) || input.subject.length > 998 || Buffer.byteLength(input.text, "utf8") > 65_536
    || !/^[A-Za-z0-9_-]{1,160}$/.test(input.tenantId) || !/^[\x21-\x7E]{1,255}$/.test(input.idempotencyKey)
    || Object.entries(input.headers).some(([key,value]) => !permittedHeaders.has(key.toLowerCase()) || /[\r\n\0]/.test(value) || value.length > 4_096)
    || !Object.entries(input.headers).some(([key,value]) => key.toLowerCase() === "message-id" && /^<[^<>\s@]+@[^<>\s@]+>$/.test(value))) {
    throw new Error("INVALID_OUTBOUND_EMAIL");
  }
}

export class FakeLmcEmailProvider {
  readonly records: Array<LmcOutboundEmail & { providerMessageId: string }> = [];
  private readonly sent = new Map<string,{ fingerprint: string; providerMessageId: string }>();
  async send(input: LmcOutboundEmail): Promise<{ providerMessageId: string }> {
    validateLmcOutboundEmail(input);
    const key = `${input.tenantId}\0${input.idempotencyKey}`;
    const fingerprint = createHash("sha256").update(JSON.stringify({ tenantId: input.tenantId, leadId: input.leadId, from: input.from, to: input.to, replyTo: input.replyTo, subject: input.subject, text: input.text, kind: input.kind, headers: Object.entries(input.headers).sort(([a],[b]) => a.localeCompare(b)) })).digest("hex");
    const prior = this.sent.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error("IDEMPOTENCY_CONFLICT");
      return { providerMessageId: prior.providerMessageId };
    }
    const providerMessageId = `fake-email-${randomUUID()}`;
    this.sent.set(key, { fingerprint, providerMessageId });
    this.records.push({ ...structuredClone(input), providerMessageId });
    return { providerMessageId };
  }
  to(email: string) { return this.records.filter(message => message.to === email).map(message => structuredClone(message)); }
  lastTo(email: string) {
    const message = this.to(email).at(-1);
    if (!message) throw new Error("NO_FAKE_DELIVERY");
    return message;
  }
}

export class FakeLmcSmsProvider {
  readonly records: Array<{ businessId: string; to: string; from: string; body: string }> = [];
  async sendMessage(input: { businessId: string; to: string; from: string; body: string }): Promise<{ providerMessageId: string }> {
    this.records.push(structuredClone(input));
    return { providerMessageId: `fake-sms-${randomUUID()}` };
  }
}

export class FakeLmcVoiceProvider {
  readonly records: Array<{ tenantId: string; to: string; idempotencyKey: string }> = [];
  private readonly calls = new Map<string,string>();
  async startCall(input: { tenantId: string; to: string; idempotencyKey: string }): Promise<{ providerCallId: string }> {
    const key = JSON.stringify([input.tenantId,input.idempotencyKey]);
    const prior = this.calls.get(key);
    if (prior) return { providerCallId: prior };
    const providerCallId = `fake-call-${randomUUID()}`;
    this.calls.set(key,providerCallId);this.records.push(structuredClone(input));
    return { providerCallId };
  }
}

type FakeCalendarEvent = { id: string; calendarId: string; title: string; startsAt: string; endsAt: string; description?: string };
export class FakeLmcCalendarProvider {
  readonly events: FakeCalendarEvent[] = [];
  readonly unauthorizedCalls: Array<{ calendarId: string }> = [];
  private readonly calendars = new Set<string>();
  authorizeCalendar(calendarId: string) { this.calendars.add(calendarId); }
  private assertCalendar(calendarId: string) {
    if (!this.calendars.has(calendarId)) { this.unauthorizedCalls.push({ calendarId }); throw new Error("FAKE_CALENDAR_NOT_CONFIGURED"); }
  }
  async getBusyBlocks(input: { accessToken: string; calendarId: string; startsAt: string; endsAt: string }): Promise<Array<{ startsAt: string; endsAt: string; externalEventId?: string }>> {
    this.assertCalendar(input.calendarId);
    return this.events.filter(event => event.calendarId === input.calendarId && Date.parse(event.startsAt) < Date.parse(input.endsAt) && Date.parse(event.endsAt) > Date.parse(input.startsAt)).map(event => ({ startsAt: event.startsAt, endsAt: event.endsAt, externalEventId:event.id }));
  }
  async upsertEvent(input: { accessToken: string; calendarId: string; eventId?: string; clientEventId?: string; title: string; startsAt: string; endsAt: string; description?: string }): Promise<{ externalEventId: string }> {
    this.assertCalendar(input.calendarId);
    const id = input.eventId ?? input.clientEventId;
    if (!id) throw new Error("CALENDAR_IDEMPOTENCY_KEY_REQUIRED");
    const event: FakeCalendarEvent = { id, calendarId: input.calendarId, title: input.title, startsAt: input.startsAt, endsAt: input.endsAt, ...(input.description !== undefined ? { description: input.description } : {}) };
    const index = this.events.findIndex(prior => prior.id === id && prior.calendarId === input.calendarId);
    if (index >= 0) this.events[index] = event; else this.events.push(event);
    return { externalEventId: id };
  }
  async refreshAccessToken(_input:{refreshToken:string}):Promise<{accessToken:string;expiresIn:number}>{return{accessToken:"fake-calendar-access-token",expiresIn:3600};}
  async deleteEvent(input: { accessToken: string; calendarId: string; eventId: string }): Promise<void> {
    this.assertCalendar(input.calendarId);
    const index = this.events.findIndex(event => event.calendarId === input.calendarId && event.id === input.eventId);
    if (index >= 0) this.events.splice(index,1);
  }
}

/** Deterministic external-model substitute; business permission checks remain in the application. */
export class FakeLmcEmailModel implements LmcEmailModel {
  readonly calls: LmcModelPrompt[] = [];
  readonly responses: unknown[] = [];
  async analyze(prompt: LmcModelPrompt): Promise<unknown> {
    this.calls.push(structuredClone(prompt));
    if (this.responses.length) return this.responses.shift();
    const text = `${prompt.untrusted.message.subject}\n${prompt.untrusted.message.text}`;
    const lower = text.toLowerCase();
    const qualification: LmcEmailDecision["qualification"] = {};
    const zip = text.match(/\b\d{5}(?:-\d{4})?\b/)?.[0]?.slice(0,5);
    if (zip) qualification.zip = zip;
    const service = prompt.business.services.find(candidate => [candidate.name,...candidate.aliases].some(name => lower.includes(name.toLowerCase())));
    if (service) qualification.serviceType = service.name;
    else if (/pool/.test(lower)) qualification.serviceType = "pool cleaning";
    else if (lower.includes("roof") && lower.includes("replac")) qualification.serviceType = "roof replacement";
    else if (lower.includes("roof") && lower.includes("repair")) qualification.serviceType = "roof repair";
    if (/residential|homeowner|my home|my house/.test(lower)) qualification.propertyType = "residential";
    else if (/commercial|warehouse/.test(lower)) qualification.propertyType = "commercial";
    if (/urgent/.test(lower)) qualification.urgency = "urgent";
    let intent: LmcEmailDecision["intent"] = "qualification";
    if (/complain|human|person|manager/.test(lower)) intent = "complaint";
    else if (/cancel/.test(lower)) intent = "cancel";
    else if (/reschedul|move (?:my|the) appointment/.test(lower)) intent = "reschedule";
    else if (/\bbook\b|confirm (?:the|that) (?:slot|time)/.test(lower)) intent = "book";
    else if (/price|how much|cost|quote/.test(lower)) intent = "price";
    else if (/when|availab|what time/.test(lower)) intent = "availability";
    else if (/\bhours?\b|\bopen\b|parking|payment|do you (?:offer|provide|serve)/.test(lower)) intent = "question";
    else if (/please wait|contact your office|thank you/.test(lower)) intent = "wait";
    const requested = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})/)?.[0];
    return { intent, confidence: 0.95, qualification, ...(requested && Number.isFinite(Date.parse(requested)) ? { requestedSlot: new Date(requested).toISOString() } : {}) };
  }
}

export function createFakeLmcProviders() {
  return { email: new FakeLmcEmailProvider(), sms: new FakeLmcSmsProvider(), voice: new FakeLmcVoiceProvider(), calendar: new FakeLmcCalendarProvider(), model: new FakeLmcEmailModel() };
}
