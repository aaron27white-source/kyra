import { and, asc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";

import { appointments, contacts, services, type DatabaseTransaction } from "@lobbystack/db";

import {
  appointmentSearchRanges,
  classifyPersonNameMatch,
  inspectAppointmentTimeFact,
  normalizeComparable,
  normalizePersonNameForSearch,
  serviceNamesMatch,
  substantiveServiceNameFactMatches,
  type PersonNameMatch,
} from "./appointmentFacts";
import { contactPhoneMatchesCaller, contactPhoneMatchesCallerValue } from "./contactPhone";

const MAX_LOOKUP_CANDIDATES = 200;

export type AppointmentChangeLookupInput = {
  businessId: string;
  callerPhone: string;
  callerName?: string;
  appointmentStartsAt?: string;
  serviceName?: string;
  appointmentId?: string;
  timezone?: string;
  now?: Date;
};

export type AppointmentLookupReason =
  | "matched"
  | "ambiguous"
  | "no_match"
  | "insufficient_facts"
  | "invalid_facts"
  | "candidate_limit";

type LookupRow = {
  id: string;
  contactId: string;
  startsAt: Date;
  timezone: string;
  name: string | null;
  phone: string | null;
  serviceName: string;
  serviceSlug: string;
  localizedNames: Record<string, string> | null;
};

type EvaluatedRow = {
  row: LookupRow;
  score: number;
  phoneMatched: boolean;
  nameMatch: PersonNameMatch;
  matchedFacts: string[];
};

export async function findAppointmentChangeMatches(tx: DatabaseTransaction, input: AppointmentChangeLookupInput) {
  const name = input.callerName?.trim();
  const hasAnotherFact = Boolean(input.appointmentStartsAt?.trim() || input.serviceName?.trim());
  const normalizedName = name ? normalizePersonNameForSearch(name) : "";
  const normalizedContactName = sql.raw("public.normalize_contact_name_search(contacts.name)");
  // This expression is backed by contacts_business_name_search_idx. It handles
  // accents and punctuation without a tenant-wide contact scan.
  const factsSearch = normalizedName && hasAnotherFact
    ? eq(normalizedContactName, normalizedName)
    : undefined;

  const serviceRows = name && hasAnotherFact && input.serviceName?.trim()
    ? await tx.select({ id: services.id, name: services.name, slug: services.slug, localizedNames: services.localizedNames })
      .from(services)
      .where(eq(services.businessId, input.businessId))
      .limit(MAX_LOOKUP_CANDIDATES + 1)
    : [];
  const serviceIds = input.serviceName
    ? serviceRows.filter((service) => substantiveServiceNameFactMatches(service, input.serviceName!)).map((service) => service.id)
    : [];
  const timeRanges = name && hasAnotherFact && input.appointmentStartsAt
    ? appointmentSearchRanges(input.appointmentStartsAt, input.timezone ?? "UTC", input.now)
    : [];
  const factFallback = or(
    ...timeRanges.map((range) => and(gte(appointments.startsAt, range.startsAtOrAfter), lt(appointments.startsAt, range.startsBefore))!),
    ...(serviceIds.length ? [inArray(appointments.serviceId, serviceIds)] : []),
  );

  const rows = await tx.select({
    id: appointments.id,
    contactId: appointments.contactId,
    startsAt: appointments.startsAt,
    timezone: appointments.timezone,
    name: contacts.name,
    phone: contacts.phone,
    serviceName: services.name,
    serviceSlug: services.slug,
    localizedNames: services.localizedNames,
  }).from(appointments)
    .innerJoin(contacts, and(eq(appointments.contactId, contacts.id), eq(contacts.businessId, input.businessId)))
    .innerJoin(services, and(eq(appointments.serviceId, services.id), eq(services.businessId, input.businessId)))
    .where(and(
      input.appointmentId ? eq(appointments.id, input.appointmentId) : undefined,
      eq(appointments.businessId, input.businessId),
      eq(appointments.status, "confirmed"),
      input.appointmentId
        ? undefined
        : or(contactPhoneMatchesCaller(input.callerPhone), factsSearch, factFallback),
    ))
    .orderBy(asc(appointments.startsAt))
    .limit(MAX_LOOKUP_CANDIDATES + 1);

  const truncated = rows.length > MAX_LOOKUP_CANDIDATES || serviceRows.length > MAX_LOOKUP_CANDIDATES;
  const candidates = rows.slice(0, MAX_LOOKUP_CANDIDATES);
  const callerPhoneRows = candidates.filter((row) => contactPhoneMatchesCallerValue(row.phone, input.callerPhone));
  let invalidFactSeen = false;

  const evaluate = (row: LookupRow, phoneMatched: boolean): EvaluatedRow | null => {
    const nameMatch = classifyPersonNameMatch(row.name ?? undefined, name);
    // A caller number is a search key, not identity proof. A transcription
    // mismatch in the name must not discard a matching phone/date/service.
    // Alternate-number name matches only discover a candidate; verification
    // still sends OTP to the saved contact number.
    if (!phoneMatched && (nameMatch === "missing" || nameMatch === "mismatch")) return null;

    const time = input.appointmentStartsAt?.trim()
      ? inspectAppointmentTimeFact({ startsAt: row.startsAt.toISOString(), timezone: row.timezone }, input.appointmentStartsAt)
      : undefined;
    if (time && !time.valid) { invalidFactSeen = true; return null; }
    if (time?.hasDate && !time.dateMatches) return null;

    const serviceMatch = input.serviceName?.trim()
      ? serviceNamesMatch({ name: row.serviceName, slug: row.serviceSlug, localizedNames: row.localizedNames }, input.serviceName)
      : false;
    // If the local date and service agree, tolerate a misheard clock time.
    // Conversely, a matching date/time pair may overcome a service ASR error.
    if (time?.hasTime && !time.timeMatches && !(time.hasDate && serviceMatch)) return null;
    if (input.serviceName?.trim() && !serviceMatch && !(time?.hasDate && time.timeMatches)) return null;

    const matchedFacts: string[] = [];
    let score = phoneMatched ? 100 : 0;
    if (time?.hasDate && time.dateMatches) { matchedFacts.push("date"); score += 8; }
    if (time?.hasTime && time.timeMatches) { matchedFacts.push("time"); score += 4; }
    if (serviceMatch) { matchedFacts.push("service"); score += 6; }
    if (nameMatch === "normalized") { matchedFacts.push("name"); score += 2; }
    if (nameMatch === "transcription_variant") matchedFacts.push("name_transcription_variant");
    if (!phoneMatched && matchedFacts.filter((fact) => fact !== "name" && fact !== "name_transcription_variant").length === 0) return null;
    return { row, score, phoneMatched, nameMatch, matchedFacts };
  };

  const evaluateGroup = (source: LookupRow[], phoneMatched: boolean) =>
    source.flatMap((row) => {
      const result = evaluate(row, phoneMatched);
      return result ? [result] : [];
    });

  const phoneMatches = evaluateGroup(callerPhoneRows, true);
  // Prefer candidates under the incoming caller number; only use the
  // name+appointment-facts search if those facts do not identify a booking.
  const eligible = phoneMatches.length ? phoneMatches : evaluateGroup(candidates, false);
  const candidateCount = phoneMatches.length ? callerPhoneRows.length : candidates.length;
  if (truncated) {
    return {
      matches: [],
      callerPhoneAppointmentCount: callerPhoneRows.length,
      candidateCount,
      reason: "candidate_limit" as const,
      matchingStrategy: phoneMatches.length ? "caller_phone" as const : "appointment_facts" as const,
      matchedFacts: [],
      nameMatch: "missing" as const,
    };
  }
  if (!eligible.length) {
    const hasFacts = Boolean(input.appointmentStartsAt?.trim() || input.serviceName?.trim());
    return {
      matches: [],
      callerPhoneAppointmentCount: callerPhoneRows.length,
      candidateCount,
      reason: !name && !hasFacts ? "insufficient_facts" as const : invalidFactSeen ? "invalid_facts" as const : "no_match" as const,
      matchingStrategy: phoneMatches.length ? "caller_phone" as const : "appointment_facts" as const,
      matchedFacts: [],
      nameMatch: "missing" as const,
    };
  }

  const highestScore = Math.max(...eligible.map((candidate) => candidate.score));
  const best = eligible.filter((candidate) => candidate.score === highestScore);
  const matches = best.map((candidate) => candidate.row);
  const reason = matches.length === 1 ? "matched" as const : "ambiguous" as const;
  return {
    matches,
    callerPhoneAppointmentCount: callerPhoneRows.length,
    candidateCount,
    reason,
    matchingStrategy: input.appointmentId
      ? "appointment_id" as const
      : phoneMatches.length
        ? "caller_phone_and_facts" as const
        : "appointment_facts" as const,
    matchedFacts: best[0]?.matchedFacts ?? [],
    nameMatch: best.length === 1 ? best[0]!.nameMatch : "missing" as const,
  };
}
