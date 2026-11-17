import { z } from "zod";

export const lmcEmailAddressSchema = z.string().trim().email().max(320);
export const lmcAuthenticationSchema = z.object({
  spf: z.enum(["pass", "fail", "softfail", "neutral", "none", "temperror", "permerror"]),
  dkim: z.enum(["pass", "fail", "none", "temperror", "permerror"]),
  dmarc: z.enum(["pass", "fail", "none", "temperror", "permerror"]),
  aligned: z.boolean(),
}).strict();

// Authentication is populated only by a verified inbound provider adapter.
// A message's own Authentication-Results header is never an authentication source.
export const lmcRawEmailSchema = z.object({
  from: z.string().min(3).max(512),
  to: z.string().min(3).max(512),
  subject: z.string().max(998).default(""),
  text: z.string().optional(),
  html: z.string().optional(),
  headers: z.record(z.string(), z.string()).default({}),
  authentication: lmcAuthenticationSchema.optional(),
  attachments: z.array(z.unknown()).max(100).default([]),
});
export type LmcRawEmail = z.infer<typeof lmcRawEmailSchema>;

export const lmcQualificationSchema = z.object({
  serviceType: z.string().max(120).optional(),
  zip: z.string().regex(/^\d{5}$/).optional(),
  city: z.string().max(120).optional(),
  urgency: z.enum(["normal", "urgent", "emergency"]).optional(),
  propertyType: z.enum(["residential", "commercial", "other"]).optional(),
  name: z.string().max(160).optional(),
  phone: z.string().max(32).optional(),
}).strict();
export type LmcQualification = z.infer<typeof lmcQualificationSchema>;

export const lmcEmailDecisionSchema = z.object({
  intent: z.enum(["qualification", "question", "price", "availability", "book", "reschedule", "cancel", "complaint", "complex", "wait", "unknown"]),
  confidence: z.number().min(0).max(1),
  qualification: lmcQualificationSchema,
  requestedSlot: z.string().datetime().optional(),
}).strict();
export type LmcEmailDecision = z.infer<typeof lmcEmailDecisionSchema>;

export const lmcBookingRulesSchema = z.object({
  minimumNoticeMinutes: z.number().int().min(0).max(10_080).default(0),
  horizonDays: z.number().int().min(1).max(7).default(7),
  requireVerifiedRequester: z.literal(true).default(true),
}).strict();

export const lmcBusinessSettingsSchema = z.object({
  faqs: z.array(z.object({ question: z.string().trim().min(3).max(500), answer: z.string().trim().min(1).max(2_000) }).strict()).max(50).optional(),
  escalation: z.object({ keywords: z.array(z.string().trim().min(3).max(100)).max(50), replyText: z.string().trim().min(20).max(2_000) }).strict().optional(),
  bookingRules: lmcBookingRulesSchema.optional(),
  ownerEmail: lmcEmailAddressSchema,
  fromEmail: lmcEmailAddressSchema,
  physicalAddress: z.string().trim().min(10).max(500),
  serviceAreaZips: z.array(z.string().regex(/^\d{5}$/)).min(1).max(5_000),
  serviceAreaCities: z.array(z.string().max(120)).max(500).default([]),
  services: z.array(z.object({ id: z.string().uuid(), name: z.string().min(1).max(120), aliases: z.array(z.string().max(120)).max(20).default([]) }).strict()).min(1).max(100),
  emergencyKeywords: z.array(z.string().min(3).max(100)).min(1).max(50),
  emergencyText: z.string().min(20).max(2_000),
  priceInformation: z.string().max(2_000).default(""),
  tone: z.enum(["professional", "friendly", "concise"]).default("professional"),
  confidenceThreshold: z.number().min(0.5).max(1).default(0.8),
  tools: z.array(z.enum(["availability", "book", "reschedule", "cancel", "handoff"])).max(5),
  followups: z.object({ enabled: z.boolean(), maxTouches: z.number().int().min(0).max(3), delaysHours: z.array(z.number().int().min(1).max(720)).max(3), dailyCap: z.number().int().min(0).max(1_000) }).strict(),
}).strict();
export type LmcBusinessSettings = z.infer<typeof lmcBusinessSettingsSchema>;

export type LmcChannelRequest = {
  channel: "email" | "voice";
  tenant: { id: string; settings: LmcBusinessSettings };
  contact: { id: string; email?: string; phone?: string };
  message: { id: string; subject: string; text: string };
  history: Array<{ role: "lead" | "assistant" | "human"; text: string }>;
};

export type LmcStructuredAction =
  | { type: "qualify"; fields: LmcQualification; confidence: number }
  | { type: "intent"; intent: LmcEmailDecision["intent"]; requestedSlot?: string }
  | { type: "clarify"; reason: "ambiguous_request" | "missing_information" }
  | { type: "handoff"; reason: string };

export type LmcChannelResult = {
  actions: LmcStructuredAction[];
  /** Bounded model decision metadata for telemetry; never contains message content. */
  decision?: Pick<LmcEmailDecision, "intent" | "confidence">;
  /** Optional prose from the shared receptionist agent. The domain layer decides whether it is safe to send. */
  suggestedReply?: string;
};

export interface LmcChannel {
  readonly kind: "email" | "voice";
  run(request: LmcChannelRequest): Promise<LmcChannelResult>;
}

export type LmcModelPrompt = {
  tenantId: string;
  trustedInstructions: string;
  business: { services: Array<{ name: string; aliases: string[] }>; tone: string; faqs?: Array<{ question: string; answer: string }> };
  untrusted: { message: LmcChannelRequest["message"]; history: LmcChannelRequest["history"] };
};
export interface LmcEmailModel { analyze(prompt: LmcModelPrompt): Promise<unknown>; }
export type LmcOutboundEmail = {
  tenantId: string;
  leadId: string;
  idempotencyKey: string;
  kind: "reply" | "followup" | "owner_alert";
  from: string;
  to: string;
  replyTo: string;
  subject: string;
  text: string;
  headers: Record<string,string>;
};
export interface LmcEmailTransport { send(message: LmcOutboundEmail): Promise<{ providerMessageId: string }>; }

export const lmcCaptureSchema = z.object({
  requestId: z.string().uuid(),
  email: lmcEmailAddressSchema,
  name: z.string().max(160).refine(value => !/[\r\n]/.test(value)).default(""),
  subject: z.string().max(200).refine(value => !/[\r\n]/.test(value)).default(""),
  message: z.string().trim().min(1).max(16_000),
  consentToFollowUp: z.boolean().default(false),
}).strict();
export type LmcCaptureInput = z.infer<typeof lmcCaptureSchema>;

export const lmcProcessJobSchema = z.object({
  messageId: z.string().uuid(), replyToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/), generation: z.number().int().min(0).default(0),
}).strict();
export const lmcOutboundEmailSchema = z.object({
  tenantId: z.string().uuid(), leadId: z.string().uuid(), idempotencyKey: z.string().min(1).max(255), kind: z.enum(["reply","followup","owner_alert"]),
  from: lmcEmailAddressSchema, to: lmcEmailAddressSchema, replyTo: lmcEmailAddressSchema,
  subject: z.string().max(998).refine(value=>!/[\r\n\0]/.test(value)), text: z.string().max(65_536), headers: z.record(z.string(),z.string().max(4096)),
}).strict();
export const lmcSendJobSchema = z.object({
  messageId: z.string().uuid(), outbound: lmcOutboundEmailSchema, generation: z.number().int().min(0), allowPaused: z.boolean(), followupTouch: z.number().int().min(1).max(3).optional(),
}).strict();

export const lmcProviderEventSchema = z.discriminatedUnion("kind",[
  z.object({kind:z.literal("message"),id:z.string().min(1).max(255).regex(/^[\x21-\x7e]+$/),email:lmcRawEmailSchema}).strict(),
  z.object({kind:z.literal("suppression"),id:z.string().min(1).max(255).regex(/^[\x21-\x7e]+$/),tenantId:z.string().uuid(),providerMessageId:z.string().min(1).max(255),email:lmcEmailAddressSchema.transform(value=>value.toLowerCase()),reason:z.enum(["bounce","complaint"])}).strict(),
]);
export type LmcProviderEvent = z.infer<typeof lmcProviderEventSchema>;
export interface LmcInboundProvider {
  verifyAndLoad(input:{rawBody:string;headers:Headers}):Promise<LmcProviderEvent|null>;
}

export const lmcFollowupJobSchema = lmcProcessJobSchema.extend({touch:z.number().int().min(1).max(3)}).strict();

export const lmcHumanReplySchema = z.object({requestId:z.string().uuid(),text:z.string().trim().min(1).max(16_000)}).strict();

export const lmcSettingsWriteSchema = z.object({config:lmcBusinessSettingsSchema,enabled:z.boolean()}).strict();

export const lmcPauseSchema = z.object({paused:z.boolean()}).strict();

// Strict structured-output APIs require required properties; unknown facts are null on the wire.
const facts = lmcQualificationSchema.shape;
export const lmcEmailDecisionWireSchema = z.object({
  intent: lmcEmailDecisionSchema.shape.intent,
  confidence: lmcEmailDecisionSchema.shape.confidence,
  qualification: z.object({
    serviceType: facts.serviceType.unwrap().nullable(), zip: facts.zip.unwrap().nullable(),
    city: facts.city.unwrap().nullable(), urgency: facts.urgency.unwrap().nullable(),
    propertyType: facts.propertyType.unwrap().nullable(), name: facts.name.unwrap().nullable(), phone: facts.phone.unwrap().nullable(),
  }).strict(),
  requestedSlot: lmcEmailDecisionSchema.shape.requestedSlot.unwrap().nullable(),
}).strict();


export type LmcEmailDecisionWire = z.infer<typeof lmcEmailDecisionWireSchema>;
