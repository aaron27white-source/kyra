import {
  bookForCaller,
  cancelForCaller,
  findOpenings,
  issueAppointmentChangeOtp,
  lookupCallerAppointments,
  rescheduleForCaller,
  searchKnowledgeEvidence,
  takeMessageForStaff,
  verifyAppointmentChangeOtp,
  verifyCallerForChange,
  type DomainContext,
} from "@lobbystack/domain";
import { isTransferPermitted, normalizeAppointmentChangePolicy, normalizeBookingMode, type BusinessContextSnapshot, type ServiceAddress } from "@lobbystack/shared";
import { tool, type ToolSet } from "ai";
import { DateTime } from "luxon";
import { z } from "zod";

/** Where the conversation happens. Phone calls know the caller's number. */
export type AgentChannel = "voice" | "web_voice" | "web_chat" | "sms" | "email";

/** Live-call controls the agent can use. Only phone calls provide them. */
export type CallControl = {
  /** Phone calls only. Resolves false when the transfer can't start, for example the plan is out of transfer attempts. */
  transfer?(destination: string): Promise<boolean>;
  hangup(reason: "caller_finished" | "spam" | "abuse"): Promise<void>;
};

export type AgentToolContext = {
  domain: DomainContext;
  snapshot: BusinessContextSnapshot;
  channel: AgentChannel;
  /** Verified caller ID on phone calls and the sender's number on SMS. Never set from what a visitor types. */
  callerPhone?: string;
  callId?: string;
  sessionId?: string;
  conversationId?: string;
  callControl?: CallControl;
  /** Prospect demos only answer questions and take messages: no booking, no transfers. */
  intakeOnly?: boolean;
  /** Restricts an orchestration pass to business-information lookups with no side effects. */
  toolPolicy?: "full" | "information";
};

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatMinutes(minutes: number): string {
  return DateTime.fromObject({ hour: Math.floor(minutes / 60), minute: minutes % 60 }).toFormat("h:mm a");
}

function comparable(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ");
}

// Curated FAQs from the snapshot back up knowledge search when it finds nothing
// or is unavailable. The document digest is an inventory, not evidence.
function snapshotKnowledgeMatches(snapshot: BusinessContextSnapshot, query: string) {
  const wanted = comparable(query);
  const tokens = wanted.split(" ").filter((token) => token.length >= 3);
  return (snapshot.knowledgeSnippets ?? []).flatMap((snippet) => {
    const text = comparable(`${snippet.title} ${snippet.content}`);
    if (!wanted || !(text.includes(wanted) || tokens.some((token) => text.includes(token)))) return [];
    return [{ title: snippet.title, text: snippet.content.trim() }];
  });
}

const phone = z.string().describe("Phone number, preferably in E.164 format.");

function normalizePhone(value: string, callerPhone?: string): string | undefined {
  const trimmed = value.trim();
  const digits = trimmed.replace(/[\s().-]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(digits)) return digits;
  // The trusted caller ID provides the country context for common local input.
  if (callerPhone?.startsWith("+1") && /^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  return undefined;
}

function logOperational(event: string, details: Record<string, string | number>): void {
  try { console.info(JSON.stringify({ event, ...details })); } catch { /* logs must not change call behavior */ }
}

export function createReceptionistTools(context: AgentToolContext): ToolSet {
  const { domain, snapshot } = context;
  const businessId = snapshot.businessId;
  const timezone = snapshot.timezone;
  const bookingMode = context.intakeOnly ? "off" : normalizeBookingMode(snapshot.bookingMode);
  const channel = context.channel;
  const tools: ToolSet = {
    getBusinessHours: tool({
      description: "Get the business's weekly opening hours, upcoming closures, and whether it is open right now.",
      inputSchema: z.object({}),
      execute: async () => {
        const now = DateTime.now().setZone(timezone);
        const minutesNow = now.hour * 60 + now.minute;
        const today = now.weekday % 7;
        const openNow = snapshot.hours.some((window) => window.dayOfWeek === today && minutesNow >= window.openMinutes && minutesNow < window.closeMinutes)
          && !snapshot.closures.some((closure) => now >= DateTime.fromISO(closure.startsAt) && now < DateTime.fromISO(closure.endsAt));
        return {
          timezone,
          now: now.toFormat("cccc h:mm a"),
          openNow,
          configured: snapshot.hours.length > 0,
          weekly: DAY_NAMES.map((day, index) => {
            const windows = snapshot.hours.filter((window) => window.dayOfWeek === index);
            return `${day}: ${windows.length ? windows.map((window) => `${formatMinutes(window.openMinutes)} to ${formatMinutes(window.closeMinutes)}`).join(", ") : "closed"}`;
          }),
          upcomingClosures: snapshot.closures
            .filter((closure) => DateTime.fromISO(closure.endsAt) > now)
            .map((closure) => ({ from: closure.startsAt, to: closure.endsAt, reason: closure.reason })),
        };
      },
    }),

    getBusinessServices: tool({
      description: "List the services the business offers, with duration and a short description.",
      inputSchema: z.object({}),
      execute: async () => ({
        services: snapshot.services.map((service) => ({ name: service.name, durationMinutes: service.durationMinutes, ...(service.description ? { description: service.description } : {}) })),
      }),
    }),

    searchKnowledge: tool({
      description: "Look up any business-specific fact not in your instructions: prices, policies, parking, payment methods, what to bring, and so on. Never guess. Make the query self-contained.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const fallback = snapshotKnowledgeMatches(snapshot, query);
        try {
          const evidence = await searchKnowledgeEvidence(domain, { businessId, query, limit: 6, ...(context.callId ? { callId: context.callId } : {}) });
          const matches = [...fallback, ...evidence.matches.map((match) => ({ title: match.title, text: match.content }))].slice(0, 6);
          return { outcome: matches.length ? "found" : evidence.outcome, matches };
        } catch {
          return { outcome: fallback.length ? "found" : "unavailable", matches: fallback };
        }
      },
    }),

  };

  // Service facts and intake policies are already present in the per-call
  // voice snapshot; another delegation only repeats known context.
  if (channel === "voice" || channel === "web_voice") delete tools.getBusinessServices;

  // Email side effects are always owned by the verified domain workflow. Even
  // if a caller forgets the explicit policy, never expose them to the agent.
  if (context.toolPolicy === "information" || channel === "email") return tools;

  tools.takeMessage = tool({
      description: "Save a message for the team to follow up on: a callback request, or an appointment the caller could not complete because required details were declined or the service is out of area. Get permission before saving; this is a pending follow-up, not a confirmed booking.",
      inputSchema: z.object({
        message: z.string().describe("What the caller needs, summarized for staff."),
        callerName: z.string().optional(),
        callbackPhone: phone.optional(),
        urgency: z.enum(["low", "normal", "urgent"]).optional(),
        callbackWindow: z.string().optional().describe("When the caller prefers to be called back, in their words."),
        requestKind: z.enum(["appointment_request"]).optional().describe("Use appointment_request only when the caller consented to team follow-up because booking intake was incomplete; the request is not booked."),
      }),
      execute: async (input) => {
        const callbackPhone = input.callbackPhone ?? context.callerPhone;
        return await takeMessageForStaff(domain, {
          businessId,
          message: input.message,
          channel,
          ...(callbackPhone ? { callbackPhone } : {}),
          ...(input.callerName ? { callerName: input.callerName } : {}),
          ...(input.urgency ? { urgency: input.urgency } : {}),
          ...(input.callbackWindow ? { callbackWindow: input.callbackWindow } : {}),
          ...(input.requestKind ? { requestKind: input.requestKind } : {}),
          ...(context.callId ? { callId: context.callId } : {}),
          ...(context.conversationId ? { conversationId: context.conversationId } : {}),
        });
      },
    });

  if (bookingMode === "instant") {
    const availabilityCache = new Map<string, ReturnType<typeof findOpenings>>();
    const offeredSlots = new Set<string>();
    // These records belong to this agent instance, which is created for one call.
    // A correction replaces only the field the caller changed.
    let addressState: Partial<ServiceAddress> = {};
    const bookingAttempts = new Map<string, Promise<Awaited<ReturnType<typeof bookForCaller>>>>();
    tools.findAvailability = tool({
      description: "Find open appointment times for one service on one date. Never state availability without calling this.",
      inputSchema: z.object({
        serviceName: z.string().describe("One of the business's services."),
        date: z.string().describe("Date as YYYY-MM-DD in the business's timezone."),
        preferredTime: z.string().optional().describe("Preferred start time as HH:mm (24-hour)."),
      }),
      execute: async ({ serviceName, date, preferredTime }) => {
        const cacheKey = JSON.stringify([serviceName.trim().toLowerCase(), date, preferredTime ?? ""]);
        const cached = availabilityCache.get(cacheKey);
        if (cached) return await cached;
        const startedAt = Date.now();
        const [hour, minute] = (preferredTime ?? "").split(":").map(Number);
        const lookup = findOpenings(domain, {
          businessId,
          serviceName,
          date,
          timezone,
          hours: snapshot.hours,
          ...(Number.isFinite(hour) ? { preferredHour24: hour, preferredMinute: Number.isFinite(minute) ? minute : 0 } : {}),
          ...(context.callId ? { callId: context.callId } : {}),
        });
        availabilityCache.set(cacheKey, lookup);
        try {
          const result = await lookup;
          if (result.ok) for (const opening of result.openings) {
            offeredSlots.add(JSON.stringify([serviceName.trim().toLowerCase(), opening.startsAt]));
            offeredSlots.add(JSON.stringify([result.serviceName.trim().toLowerCase(), opening.startsAt]));
          }
          logOperational("voice.availability.completed", { operation: "find_availability", businessId, ...(context.callId ? { callId: context.callId } : {}), ...(context.sessionId ? { sessionId: context.sessionId } : {}), reasonCode: result.ok ? "completed" : "unavailable", resultCount: result.ok ? result.openings.length : 0, durationMs: Date.now() - startedAt });
          return result;
        } catch {
          availabilityCache.delete(cacheKey);
          logOperational("voice.availability.failed", { operation: "find_availability", businessId, ...(context.callId ? { callId: context.callId } : {}), ...(context.sessionId ? { sessionId: context.sessionId } : {}), reasonCode: "query_failed", durationMs: Date.now() - startedAt });
          throw new Error("Availability could not be checked. Offer to try another time or take a message.");
        }
      },
    });
    tools.bookAppointment = tool({
      description: "Book an appointment at an exact time findAvailability returned after the caller confirms it. Include only configured intake information the caller provided or confirmed. The backend rejects missing required fields; if it does, ask only for those fields and retry. Never claim success unless ok is true. On phone calls, SMS consent must be asked separately.",
      inputSchema: z.object({
        serviceName: z.string(),
        startsAt: z.string().describe("The exact startsAt value returned by findAvailability."),
        contactName: z.string().optional(),
        contactPhone: phone.optional().describe("Only set if caller explicitly chose a different callback number; otherwise use trusted Caller ID."),
        smsConsentGranted: z.boolean().describe("True only if the caller agreed to receive a confirmation and reminder text."),
        serviceLocation: z.object({ line1: z.string().optional(), unit: z.string().optional(), city: z.string().optional(), region: z.string().optional(), postalCode: z.string().optional(), country: z.string().optional(), instructions: z.string().optional() }).optional().describe("New or corrected job-location fields. Supply only details the caller provided or confirmed; previously supplied fields are retained for this call."),
        intakeAnswers: z.record(z.string(), z.string()).optional().describe("Configured service intake answers already provided by the caller, such as issueDescription or equipmentDetails."),
      }),
      execute: async (input) => {
        const startedAt = Date.now();
        if (input.serviceLocation) addressState = { ...addressState, ...Object.fromEntries(Object.entries(input.serviceLocation).filter(([, value]) => value !== undefined)) };
        const offeredSlotKey = JSON.stringify([input.serviceName.trim().toLowerCase(), input.startsAt]);
        if (!offeredSlots.has(offeredSlotKey)) {
          logOperational("voice.booking.failed", { operation: "book_appointment", businessId, ...(context.callId ? { callId: context.callId } : {}), ...(context.sessionId ? { sessionId: context.sessionId } : {}), reasonCode: "slot_not_offered", durationMs: Date.now() - startedAt });
          return { ok: false, reason: "Choose an exact time returned by findAvailability before booking." };
        }
        const rawPhone = input.contactPhone ?? context.callerPhone;
        if (!rawPhone) {
          logOperational("voice.booking.failed", { operation: "book_appointment", businessId, ...(context.callId ? { callId: context.callId } : {}), ...(context.sessionId ? { sessionId: context.sessionId } : {}), reasonCode: "missing_phone", durationMs: Date.now() - startedAt });
          return { ok: false, reason: "A valid callback number is needed. Ask one focused question for a number including its country code." };
        }
        const selected = normalizePhone(rawPhone, context.callerPhone);
        if (!selected) {
          logOperational("voice.booking.failed", { operation: "book_appointment", businessId, ...(context.callId ? { callId: context.callId } : {}), ...(context.sessionId ? { sessionId: context.sessionId } : {}), reasonCode: "invalid_phone", durationMs: Date.now() - startedAt });
          return { ok: false, reason: "A valid callback number is needed. Ask one focused question for a number including its country code." };
        }
        const businessDid = normalizePhone(snapshot.contactChannels.phoneNumber ?? "");
        if (input.contactPhone && businessDid && selected === businessDid) {
          logOperational("voice.booking.failed", { operation: "book_appointment", businessId, ...(context.callId ? { callId: context.callId } : {}), ...(context.sessionId ? { sessionId: context.sessionId } : {}), reasonCode: "business_did_ambiguous", durationMs: Date.now() - startedAt });
          return { ok: false, reason: "That number is the business line, not a caller callback number. Clarify whether to use the number they are calling from or ask for another number." };
        }
        if (input.serviceLocation && (!addressState.line1 || !addressState.city || !addressState.country)) {
          const missingFields = (["line1", "city", "country"] as const).filter((field) => !addressState[field]);
          return { ok: false, reasonCode: "missing_required_fields", reason: `The job address is incomplete. Ask only for ${missingFields.join(", ")}.`, missingFields };
        }
        const serviceLocation = addressState.line1 && addressState.city && addressState.country ? addressState as ServiceAddress : undefined;
        const attemptKey = JSON.stringify([input.serviceName.trim().toLowerCase(), input.startsAt, selected, input.contactName ?? "", input.smsConsentGranted, serviceLocation ?? null, input.intakeAnswers ?? null]);
        const previousAttempt = bookingAttempts.get(attemptKey);
        if (previousAttempt) {
          logOperational("voice.booking.duplicate_suppressed", { operation: "book_appointment", businessId, ...(context.callId ? { callId: context.callId } : {}), reasonCode: "unchanged_input" });
          return await previousAttempt;
        }
        logOperational("voice.booking.attempt", { operation: "book_appointment", businessId, ...(context.callId ? { callId: context.callId } : {}), ...(context.sessionId ? { sessionId: context.sessionId } : {}) });
        const attempt = bookForCaller(domain, {
          businessId,
          serviceName: input.serviceName,
          startsAt: input.startsAt,
          timezone,
          contactPhone: selected,
          channel,
          smsConsentGranted: input.smsConsentGranted,
          intake: { ...(serviceLocation ? { serviceLocation } : {}), ...(input.intakeAnswers ? { answers: input.intakeAnswers } : {}) },
          ...(input.contactName ? { contactName: input.contactName } : {}),
          ...(context.callId ? { callId: context.callId } : {}),
          ...(context.sessionId ? { sessionId: context.sessionId } : {}),
        }).then((result) => {
          logOperational("voice.booking.result", { operation: "book_appointment", businessId, ...(context.callId ? { callId: context.callId } : {}), ...(context.sessionId ? { sessionId: context.sessionId } : {}), reasonCode: result.ok ? "committed" : "not_committed", durationMs: Date.now() - startedAt });
          return result;
        });
        bookingAttempts.set(attemptKey, attempt);
        try { return await attempt; } catch (error) { bookingAttempts.delete(attemptKey); throw error; }
      },
    });
  }

  if (bookingMode === "request") {
    tools.requestAppointment = tool({
      description: "Pass an appointment request to the team, who will confirm the time with the caller. Collect the service, preferred day and time, name, and callback number first.",
      inputSchema: z.object({
        serviceName: z.string(),
        preferredTime: z.string().describe("The caller's preferred day and time, in their words."),
        callerName: z.string(),
        callbackPhone: phone.optional(),
        notes: z.string().optional(),
      }),
      execute: async (input) => {
        const callbackPhone = input.callbackPhone ?? context.callerPhone;
        if (!callbackPhone) return { ok: false, reason: "Ask for a callback number first." };
        const message = [`Appointment request: ${input.serviceName}`, `Preferred time: ${input.preferredTime}`, input.notes ? `Notes: ${input.notes}` : ""].filter(Boolean).join("\n");
        return await takeMessageForStaff(domain, {
          businessId,
          message,
          channel,
          callbackPhone,
          callerName: input.callerName,
          ...(context.callId ? { callId: context.callId } : {}),
          ...(context.conversationId ? { conversationId: context.conversationId } : {}),
        });
      },
    });
  }

  // Changing an appointment identifies the caller by their phone number, so it
  // is only offered when the call itself carries a trusted number.
  const changePolicy = normalizeAppointmentChangePolicy(snapshot.appointmentChangePolicy);
  const callerPhone = context.callerPhone;
  if (callerPhone && changePolicy.enabled && changePolicy.verificationMode !== "operator_only" && bookingMode !== "off") {
    let lookupAttempt = 0;
    let verifyAttempt = 0;
    let otpSendAttempt = 0;
    let otpVerifyAttempt = 0;
    let cancelAttempt = 0;
    let rescheduleAttempt = 0;
    let lastFailedLookup: { key: string; reason: string } | undefined;
    const lookupKey = (input: { callerName?: string | undefined; appointmentStartsAt?: string | undefined; serviceName?: string | undefined; appointmentId?: string | undefined }) => JSON.stringify([
      input.callerName ? input.callerName.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() : "",
      input.appointmentStartsAt?.trim().toLowerCase() ?? "",
      input.serviceName ? input.serviceName.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() : "",
      input.appointmentId ?? "",
    ]);
    tools.lookupAppointmentForChange = tool({
      description: "Find a confirmed appointment using the caller's incoming number plus facts, or use the customer's full name with the appointment date/time or service if the booking used another number. It returns an internal ID only for one unique match. An alternate-number match must be verified with the code sent to the phone saved on that booking before discussing details or making changes.",
      inputSchema: z.object({
        callerName: z.string().optional(),
        appointmentStartsAt: z.string().optional().describe("Date or date and time as the caller described it."),
        serviceName: z.string().optional(),
        appointmentId: z.string().optional(),
      }),
      execute: async (input) => {
        const startedAt = Date.now();
        const key = lookupKey(input);
        lookupAttempt += 1;
        const logBase = { operation: "lookup_appointment_for_change", businessId, ...(context.callId ? { callId: context.callId } : {}), ...(context.sessionId ? { sessionId: context.sessionId } : {}), attemptNumber: lookupAttempt };
        if (lastFailedLookup?.key === key) {
          logOperational("voice.appointment_lookup.duplicate_suppressed", { ...logBase, outcome: "no_lookup", reasonCode: "unchanged_query", durationMs: 0 });
          return { ok: true, reason: lastFailedLookup.reason, reasonCode: "unchanged_query", matchingAppointmentCount: 0, repeatSuppressed: true };
        }
        try {
          const result = await lookupCallerAppointments(domain, { businessId, callerPhone, timezone, ...(input.callerName ? { callerName: input.callerName } : {}), ...(input.appointmentStartsAt ? { appointmentStartsAt: input.appointmentStartsAt } : {}), ...(input.serviceName ? { serviceName: input.serviceName } : {}), ...(input.appointmentId ? { appointmentId: input.appointmentId } : {}) });
          const outcome = result.reason;
          logOperational("voice.appointment_lookup.completed", { ...logBase, outcome, reasonCode: outcome, candidateCount: result.matchingAppointmentCount, matchingStrategy: result.matchingStrategy, durationMs: Date.now() - startedAt });
          lastFailedLookup = outcome === "matched" ? undefined : { key, reason: outcome };
          return result;
        } catch {
          logOperational("voice.appointment_lookup.failed", { ...logBase, outcome: "system_error", reasonCode: "database_or_service_error", durationMs: Date.now() - startedAt });
          lastFailedLookup = undefined;
          return { ok: false, reasonCode: "system_error", matchingAppointmentCount: 0 };
        }
      },
    });
    tools.verifyAppointmentForChange = tool({
      description: "Verify the caller's name and one fact about their appointment (date/time or service) before any change.",
      inputSchema: z.object({
        action: z.enum(["cancel", "reschedule"]),
        appointmentId: z.string().optional().describe("Internal ID returned by lookupAppointmentForChange for the unique match."),
        callerName: z.string().optional(),
        appointmentStartsAt: z.string().optional().describe("The appointment time as the caller described it."),
        serviceName: z.string().optional(),
      }),
      execute: async (input) => {
        const startedAt = Date.now();
        const attemptNumber = ++verifyAttempt;
        try {
          const result = await verifyCallerForChange(domain, { businessId, callerPhone, timezone, action: input.action, ...(input.appointmentId ? { appointmentId: input.appointmentId } : {}), ...(input.callerName ? { callerName: input.callerName } : {}), ...(input.appointmentStartsAt ? { appointmentStartsAt: input.appointmentStartsAt } : {}), ...(input.serviceName ? { serviceName: input.serviceName } : {}) });
          logOperational("voice.appointment_change.verification", { operation: "verify_appointment_change", businessId, ...(context.callId ? { callId: context.callId } : {}), ...(context.sessionId ? { sessionId: context.sessionId } : {}), attemptNumber, outcome: result.verified ? "verified" : "verification_required", reasonCode: "status" in result ? result.status : "verification_failed", durationMs: Date.now() - startedAt });
          return result;
        } catch {
          logOperational("voice.appointment_change.verification_failed", { operation: "verify_appointment_change", businessId, ...(context.callId ? { callId: context.callId } : {}), ...(context.sessionId ? { sessionId: context.sessionId } : {}), attemptNumber, outcome: "system_error", reasonCode: "database_or_service_error", durationMs: Date.now() - startedAt });
          return { ok: false, verified: false, reasonCode: "system_error" };
        }
      },
    });
    tools.sendAppointmentChangeOtp = tool({
      description: "Text the caller a one-time code when verifyAppointmentForChange says a code is required.",
      inputSchema: z.object({ verificationId: z.string() }),
      execute: async ({ verificationId }) => {
        const startedAt = Date.now();
        const attemptNumber = ++otpSendAttempt;
        try {
          const result = await issueAppointmentChangeOtp(domain, { businessId, verificationId });
          logOperational("voice.appointment_change.otp_send", { operation: "send_change_otp", businessId, ...(context.callId ? { callId: context.callId } : {}), ...(context.sessionId ? { sessionId: context.sessionId } : {}), attemptNumber, outcome: result.ok ? result.status : "not_sent", reasonCode: result.ok ? result.status : result.status, durationMs: Date.now() - startedAt });
          return result;
        } catch {
          logOperational("voice.appointment_change.otp_send_failed", { operation: "send_change_otp", businessId, ...(context.callId ? { callId: context.callId } : {}), ...(context.sessionId ? { sessionId: context.sessionId } : {}), attemptNumber, outcome: "system_error", reasonCode: "database_or_service_error", durationMs: Date.now() - startedAt });
          return { ok: false, status: "system_error", reason: "The verification code could not be sent." };
        }
      },
    });
    tools.verifyAppointmentChangeOtp = tool({
      description: "Check the one-time code the caller reads back.",
      inputSchema: z.object({ verificationId: z.string(), code: z.string() }),
      execute: async ({ verificationId, code }) => {
        const startedAt = Date.now();
        const attemptNumber = ++otpVerifyAttempt;
        try {
          const result = await verifyAppointmentChangeOtp(domain, { businessId, verificationId, code });
          logOperational("voice.appointment_change.otp_verification", { operation: "verify_change_otp", businessId, ...(context.callId ? { callId: context.callId } : {}), ...(context.sessionId ? { sessionId: context.sessionId } : {}), attemptNumber, outcome: result.ok ? "verified" : "rejected", reasonCode: result.status, durationMs: Date.now() - startedAt });
          return result;
        } catch {
          logOperational("voice.appointment_change.otp_verification_failed", { operation: "verify_change_otp", businessId, ...(context.callId ? { callId: context.callId } : {}), ...(context.sessionId ? { sessionId: context.sessionId } : {}), attemptNumber, outcome: "system_error", reasonCode: "database_or_service_error", durationMs: Date.now() - startedAt });
          return { ok: false, status: "system_error", verificationId, reason: "The verification could not be completed." };
        }
      },
    });
    if (changePolicy.allowCancel) {
      tools.cancelAppointment = tool({
        description: "Cancel the verified appointment. Only after the caller explicitly confirms they want it cancelled now.",
        inputSchema: z.object({ appointmentId: z.string(), verificationId: z.string(), finalConfirmation: z.boolean() }),
        execute: async (input) => {
          const startedAt = Date.now();
          const attemptNumber = ++cancelAttempt;
          try {
            const result = await cancelForCaller(domain, { businessId, callerPhone, ...input });
            logOperational("voice.appointment_change.cancellation", { operation: "cancel_appointment", businessId, ...(context.callId ? { callId: context.callId } : {}), ...(context.sessionId ? { sessionId: context.sessionId } : {}), attemptNumber, outcome: result.ok ? "committed" : "not_committed", reasonCode: result.ok ? "committed" : "verification_or_confirmation_required", durationMs: Date.now() - startedAt });
            return result;
          } catch {
            logOperational("voice.appointment_change.cancellation_failed", { operation: "cancel_appointment", businessId, ...(context.callId ? { callId: context.callId } : {}), ...(context.sessionId ? { sessionId: context.sessionId } : {}), attemptNumber, outcome: "system_error", reasonCode: "database_or_service_error", durationMs: Date.now() - startedAt });
            return { ok: false, reason: "The cancellation could not be completed." };
          }
        },
      });
    }
    if (changePolicy.allowReschedule && bookingMode === "instant") {
      tools.rescheduleAppointment = tool({
        description: "Move the verified appointment to a new time that findAvailability returned. Only after the caller explicitly confirms the new time.",
        inputSchema: z.object({ appointmentId: z.string(), verificationId: z.string(), startsAt: z.string(), finalConfirmation: z.boolean() }),
        execute: async (input) => {
          const startedAt = Date.now();
          const attemptNumber = ++rescheduleAttempt;
          try {
            const result = await rescheduleForCaller(domain, { businessId, callerPhone, ...input });
            logOperational("voice.appointment_change.rescheduling", { operation: "reschedule_appointment", businessId, ...(context.callId ? { callId: context.callId } : {}), ...(context.sessionId ? { sessionId: context.sessionId } : {}), attemptNumber, outcome: result.ok ? "committed" : "not_committed", reasonCode: result.ok ? "committed" : "verification_or_confirmation_required", durationMs: Date.now() - startedAt });
            return result;
          } catch {
            logOperational("voice.appointment_change.rescheduling_failed", { operation: "reschedule_appointment", businessId, ...(context.callId ? { callId: context.callId } : {}), ...(context.sessionId ? { sessionId: context.sessionId } : {}), attemptNumber, outcome: "system_error", reasonCode: "database_or_service_error", durationMs: Date.now() - startedAt });
            return { ok: false, reason: "The rescheduling could not be completed." };
          }
        },
      });
    }
  }

  const callControl = context.callControl;
  const transfer = context.intakeOnly ? undefined : callControl?.transfer?.bind(callControl);
  if (transfer) {
    tools.transferCall = tool({
      description: "Transfer the call to a person at the business when the transfer rules allow it and the caller asks for a person or has an urgent problem.",
      inputSchema: z.object({
        callerRequested: z.boolean().describe("True only if the caller explicitly asked for a person."),
        urgent: z.boolean().describe("True only if the caller described an urgent situation."),
        reason: z.string().optional(),
      }),
      execute: async (input) => {
        const destination = snapshot.transferPolicy.transferNumber;
        if (!destination || !isTransferPermitted(snapshot, input)) return { ok: false, reason: "Transfers aren't allowed right now. Offer to take a message." };
        const started = await transfer(destination);
        return started ? { ok: true, transferring: true } : { ok: false, reason: "The transfer couldn't be started. Offer to take a message." };
      },
    });
  }
  if (callControl) {
    tools.endCall = tool({
      description: "Hang up after saying goodbye, when the caller is done, or when the call is spam or abusive.",
      inputSchema: z.object({ reason: z.enum(["caller_finished", "spam", "abuse"]) }),
      execute: async ({ reason }) => {
        logOperational("live.end_call_tool.invoked", { operation: "end_call", businessId, reason, ...(context.callId ? { callId: context.callId } : {}), ...(context.sessionId ? { sessionId: context.sessionId } : {}) });
        await callControl.hangup(reason);
        return { ok: true };
      },
    });
  }

  return tools;
}
