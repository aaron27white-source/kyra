// Kyra the Receptionist (Key 20): rules that both the dashboard and the server need.
// The server is the authority: every check here is enforced again in the
// domain layer before anything is sent, dialled or saved.

export const serviceTiers = ["missed_call", "receptionist", "assistant"] as const;
export type ServiceTier = (typeof serviceTiers)[number];

export type AssistantFeature =
  | "missed_call_text"
  | "sms_ai"
  | "voice_callback"
  | "live_receptionist"
  | "outbound_automations"
  | "back_office";

/** The tier each feature first appears in. Back Office is an add-on, not a tier. */
const FEATURE_MIN_TIER: Record<Exclude<AssistantFeature, "back_office">, ServiceTier> = {
  missed_call_text: "missed_call",
  sms_ai: "missed_call",
  voice_callback: "missed_call",
  live_receptionist: "receptionist",
  outbound_automations: "assistant",
};

export function isServiceTier(value: unknown): value is ServiceTier {
  return typeof value === "string" && (serviceTiers as readonly string[]).includes(value);
}

export function tierRank(tier: ServiceTier): number {
  return serviceTiers.indexOf(tier);
}

export function tierAllows(settings: { serviceTier: string; backOfficeEnabled?: boolean }, feature: AssistantFeature): boolean {
  if (feature === "back_office") return settings.backOfficeEnabled === true;
  const tier = isServiceTier(settings.serviceTier) ? settings.serviceTier : "missed_call";
  return tierRank(tier) >= tierRank(FEATURE_MIN_TIER[feature]);
}

export type AssistantLanguage = "en" | "es";

/** The assistant's name in every greeting and text. Businesses can't rename her yet. */
export const ASSISTANT_NAME = "Kyra";

// Fixed safety wording. Companies can't edit it and the AI never paraphrases it:
// it's sent as-is before any AI reply.
export const EMERGENCY_REPLY: Record<AssistantLanguage, string> = {
  en: "For your safety: if you smell gas or see sparks, smoke or fire, leave the house now and call 911. Then call your gas or electric company. We're alerting our on-call technician right now.",
  es: "Por su seguridad: si huele a gas o ve chispas, humo o fuego, salga de la casa ahora y llame al 911. Luego llame a su compañía de gas o de luz. Estamos avisando a nuestro técnico de guardia ahora mismo.",
};

export type EmergencyKind = "gas" | "fire" | "electrical" | "sewage" | "carbon_monoxide";

const EMERGENCY_PATTERNS: Array<{ kind: EmergencyKind; pattern: RegExp }> = [
  { kind: "gas", pattern: /\b(smell(s|ing)? (of |like )?gas|gas (leak|smell)|leaking gas|olor a gas|huele a gas|fuga de gas)\b/ },
  { kind: "carbon_monoxide", pattern: /\b(carbon monoxide|co (alarm|detector)|mon[oó]xido)\b/ },
  { kind: "fire", pattern: /\b(fire|smoke|smoking outlet|burning smell|humo|fuego|incendio|olor a quemado)\b/ },
  { kind: "electrical", pattern: /\b(sparks?|sparking|arcing|chispas?|water (near|in|on|by) (the )?(outlet|panel|breaker|electrical|wires?)|agua (en|cerca de) (el |la )?(enchufe|panel|cables?))\b/ },
  { kind: "sewage", pattern: /\b(sewage|sewer (is )?back(ing)? up|raw sewage|aguas negras|drenaje (se )?regres)/ },
];

function foldText(value: string): string {
  return value.toLowerCase().normalize("NFC").replace(/\s+/g, " ");
}

/** Deterministic, so it can't be talked out of: checked before the AI sees the message. */
export function detectEmergency(text: string): EmergencyKind | null {
  const folded = foldText(text);
  for (const { kind, pattern } of EMERGENCY_PATTERNS) if (pattern.test(folded)) return kind;
  return null;
}

const SPANISH_MARKERS = /\b(hola|gracias|necesito|tengo|por favor|agua|fuga|baño|cocina|llamar|cuando|mañana|buenos|buenas|sí|usted|ayuda|problema|está|casa)\b/;

/** A cheap first guess for the first reply. The AI follows the customer after that. */
export function guessLanguage(text: string): AssistantLanguage {
  return SPANISH_MARKERS.test(foldText(text)) ? "es" : "en";
}

const YES_REPLIES = new Set(["yes", "y", "yeah", "yep", "ok", "okay", "sure", "call me", "yes please", "si", "sí", "claro", "llámame", "llamame"]);

/** Only an explicit short yes counts as consent to an AI call. */
export function isAffirmativeReply(text: string): boolean {
  const folded = foldText(text).replace(/[.!¡?¿,]/g, "").trim();
  return YES_REPLIES.has(folded);
}

/** Minutes past local midnight in the business's time zone. */
export function localMinutes(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return (hour % 24) * 60 + minute;
}

/** Outbound calls and automated texts only go out inside this window. */
export function isWithinContactWindow(now: Date, timezone: string, window: { startMinutes: number; endMinutes: number }): boolean {
  const minutes = localMinutes(now, timezone);
  return minutes >= window.startMinutes && minutes < window.endMinutes;
}

export type TextBackSettings = {
  businessName: string;
  voiceCallbackEnabled: boolean;
  callbackMode: "ask_first" | "automatic";
  photoRequestsEnabled: boolean;
  customMessage?: string | null;
};

/** The first text after a missed call. Custom wording can't remove the opt-out line. */
export function renderTextBack(settings: TextBackSettings, language: AssistantLanguage): string {
  const name = settings.businessName.trim() || (language === "es" ? "nosotros" : "us");
  const offerCall = settings.voiceCallbackEnabled && settings.callbackMode === "ask_first";
  const custom = settings.customMessage?.trim().replaceAll("{business}", name);
  const lines = language === "es"
    ? [
      custom || `Hola, habla ${ASSISTANT_NAME}, la recepcionista virtual de ${name}. Perdimos su llamada. ¿En qué le podemos ayudar?`,
      settings.photoRequestsEnabled ? "Puede enviar fotos del problema a este número." : "",
      offerCall ? `Responda SÍ y ${ASSISTANT_NAME} le llamará ahora mismo.` : "",
      "Responda STOP para no recibir más mensajes.",
    ]
    : [
      custom || `Hi, this is ${ASSISTANT_NAME}, the virtual receptionist for ${name}. Sorry we missed your call. How can we help?`,
      settings.photoRequestsEnabled ? "You can text photos of the problem to this number." : "",
      offerCall ? `Reply YES and ${ASSISTANT_NAME} will call you right now.` : "",
      "Reply STOP to opt out.",
    ];
  return lines.filter(Boolean).join(" ");
}

export function missedCallGreeting(settings: { businessName: string; voiceCallbackEnabled: boolean; callbackMode: "ask_first" | "automatic"; customGreeting?: string | null }): string {
  const custom = settings.customGreeting?.trim();
  if (custom) return custom;
  const name = settings.businessName.trim() || "us";
  return settings.voiceCallbackEnabled && settings.callbackMode === "automatic"
    ? `Thanks for calling ${name}. Everyone is busy right now. ${ASSISTANT_NAME}, our virtual receptionist, will call you back in about a minute. To skip the call, reply STOP to our text.`
    : `Thanks for calling ${name}. Everyone is busy right now, so we're texting you. Reply to that text and we'll take care of you.`;
}
