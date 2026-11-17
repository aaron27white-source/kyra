import { DateTime } from "luxon";

type AppointmentFact = { startsAt: string; timezone: string };
type ServiceFact = { name: string; slug: string; localizedNames?: Record<string, string> | null };
function getServiceNameCandidates(service: ServiceFact): string[] {
  return [...new Set([service.name, service.slug, service.localizedNames?.en, service.localizedNames?.fr].map(value => value?.trim()).filter((value): value is string => Boolean(value)))];
}

/** Accent-insensitive comparison only. The original contact name is never changed. */
export function normalizeComparable(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function normalizePersonNameForSearch(value: string): string {
  return normalizePersonName(value);
}

function normalizePersonName(value: string): string {
  const normalized = normalizeComparable(value);
  const tokens = normalized.split(" ").filter(Boolean);
  // Callers sometimes spell a name letter by letter ("J-O-A-O"). Join only
  // an all-single-letter sequence so ordinary multiword names stay intact.
  if (tokens.length > 1 && tokens.every((token) => [...token].length === 1)) {
    return tokens.join("");
  }
  return normalized;
}

function tokenizeComparable(value: string): Array<string> {
  return normalizePersonName(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

export type PersonNameMatch = "normalized" | "transcription_variant" | "mismatch" | "missing";

function editDistanceAtMostOne(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  let leftIndex = 0;
  let rightIndex = 0;
  let edits = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    if (++edits > 1) return false;
    if (left.length > right.length) leftIndex += 1;
    else if (right.length > left.length) rightIndex += 1;
    else { leftIndex += 1; rightIndex += 1; }
  }
  return edits + Number(leftIndex < left.length || rightIndex < right.length) <= 1;
}

/**
 * Approximate transcription matching is for discovery only. Callers whose
 * incoming phone does not match the contact still require OTP verification.
 */
export function classifyPersonNameMatch(storedName: string | undefined, providedName: string | undefined): PersonNameMatch {
  if (!storedName?.trim() || !providedName?.trim()) {
    return "missing";
  }

  const stored = tokenizeComparable(storedName);
  const provided = tokenizeComparable(providedName);
  if (!stored.length || !provided.length) return "missing";
  const remaining = [...stored];
  let transcriptionVariant = false;
  for (const providedToken of provided) {
    const exactIndex = remaining.indexOf(providedToken);
    if (exactIndex >= 0) {
      remaining.splice(exactIndex, 1);
      continue;
    }
    const variantIndex = remaining.findIndex((token) =>
      Math.min(providedToken.length, token.length) >= 4 && editDistanceAtMostOne(providedToken, token),
    );
    if (variantIndex < 0) return "mismatch";
    transcriptionVariant = true;
    remaining.splice(variantIndex, 1);
  }
  return transcriptionVariant ? "transcription_variant" : "normalized";
}

export function storedContactNameMatchesIfPresent(
  storedName: string | undefined,
  providedName: string | undefined,
): boolean {
  return !storedName?.trim() || Boolean(providedName?.trim() && classifyPersonNameMatch(storedName, providedName) !== "mismatch");
}

export function serviceNamesMatch(service: ServiceFact, providedServiceName: string): boolean {
  const provided = normalizeComparable(providedServiceName);
  if (!provided) {
    return false;
  }

  return getServiceNameCandidates(service)
    .map((candidate) => normalizeComparable(candidate))
    .some(
      (candidate) =>
        candidate === provided ||
        candidate.includes(provided) ||
        provided.includes(candidate),
    );
}

export function substantiveServiceNameFactMatches(
  service: ServiceFact,
  providedServiceName: string,
): boolean {
  const provided = normalizeComparable(providedServiceName);
  if (!provided) {
    return false;
  }

  const candidates = getServiceNameCandidates(service).map((candidate) =>
    normalizeComparable(candidate),
  );
  if (candidates.some((candidate) => candidate === provided)) {
    return true;
  }

  const providedTokens = tokenizeComparable(provided).filter((token) => token.length >= 3);
  if (providedTokens.length === 0) {
    return false;
  }

  return candidates.some((candidate) => {
    const candidateTokens = tokenizeComparable(candidate);
    return providedTokens.every((providedToken) =>
      candidateTokens.some(
        (candidateToken) =>
          candidateToken === providedToken ||
          (providedToken.length >= 4 && candidateToken.startsWith(providedToken)),
      ),
    );
  });
}

export function appointmentTimesMatch(
  appointment: AppointmentFact,
  providedStartsAt: string,
): boolean {
  return inspectAppointmentTimeFact(appointment, providedStartsAt).matches;
}

export type AppointmentTimeFactInspection = {
  valid: boolean;
  hasDate: boolean;
  hasTime: boolean;
  dateMatches: boolean;
  timeMatches: boolean;
  matches: boolean;
};

const MONTHS_BY_NAME = new Map(
  [
    ["jan", 1], ["janvier", 1], ["janv", 1], ["enero", 1], ["ene", 1], ["janeiro", 1],
    ["january", 1],
    ["feb", 2], ["fevrier", 2], ["fevr", 2], ["febrero", 2], ["febr", 2], ["fevereiro", 2], ["fev", 2],
    ["february", 2],
    ["mar", 3], ["mars", 3], ["marzo", 3], ["marco", 3],
    ["march", 3],
    ["apr", 4], ["avril", 4], ["abril", 4],
    ["april", 4],
    ["may", 5], ["mai", 5], ["mayo", 5],
    ["jun", 6], ["juin", 6], ["junio", 6],
    ["june", 6],
    ["jul", 7], ["juillet", 7], ["julio", 7],
    ["july", 7],
    ["aug", 8], ["aout", 8], ["agosto", 8],
    ["august", 8],
    ["sep", 9], ["septembre", 9], ["septiembre", 9], ["setembro", 9],
    ["sept", 9],
    ["september", 9],
    ["oct", 10], ["octobre", 10], ["octubre", 10],
    ["october", 10],
    ["nov", 11], ["novembre", 11], ["noviembre", 11],
    ["november", 11],
    ["dec", 12], ["decembre", 12], ["diciembre", 12], ["dezembro", 12],
    ["december", 12],
  ].map(([name, month]) => [name, month as number]),
);
const MONTH_PATTERN = [...MONTHS_BY_NAME.keys()].sort((a, b) => String(b).length - String(a).length).join("|");

const WEEKDAYS_BY_NAME = new Map(
  [
    ["sun", 0],
    ["sunday", 0],
    ["mon", 1], ["monday", 1], ["lundi", 1], ["lunes", 1],
    ["tue", 2], ["tuesday", 2], ["mardi", 2], ["martes", 2],
    ["tues", 2],
    ["wed", 3], ["wednesday", 3], ["mercredi", 3], ["miercoles", 3],
    ["thu", 4], ["thursday", 4], ["jeudi", 4], ["jueves", 4],
    ["thur", 4],
    ["thurs", 4],
    ["fri", 5], ["friday", 5], ["vendredi", 5], ["viernes", 5],
    ["sat", 6], ["saturday", 6], ["samedi", 6], ["sabado", 6],
  ].map(([name, weekday]) => [name, weekday as number]),
);

type LocalAppointmentDateTime = {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
};

function getAppointmentLocalDateTime(
  appointment: AppointmentFact,
): LocalAppointmentDateTime | null {
  const date = new Date(appointment.startsAt);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: appointment.timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const year = Number(value("year"));
  const month = Number(value("month"));
  const day = Number(value("day"));
  const weekday = WEEKDAYS_BY_NAME.get(value("weekday")?.toLowerCase() ?? "");
  const hour = Number(value("hour"));
  const minute = Number(value("minute"));

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    weekday === undefined ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute)
  ) {
    return null;
  }

  return { year, month, day, weekday, hour, minute };
}

function getBusinessRelativeLocalDate(
  timezone: string,
  daysFromToday: number,
): Pick<LocalAppointmentDateTime, "year" | "month" | "day"> | null {
  const target = DateTime.now().setZone(timezone).plus({ days: daysFromToday });
  if (!target.isValid) {
    return null;
  }

  return {
    year: target.year,
    month: target.month,
    day: target.day,
  };
}

function parseProvidedClockTime(input: string):
  | {
      hour: number;
      minute: number;
      hasMeridiem: boolean;
    }
  | null {
  const meridiemMatch = input.match(
    /\b(\d{1,2})(?:(?::|\s)(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/,
  );
  if (meridiemMatch) {
    const rawHour = Number(meridiemMatch[1]);
    const minute = meridiemMatch[2] ? Number(meridiemMatch[2]) : 0;
    if (rawHour < 1 || rawHour > 12 || minute < 0 || minute > 59) {
      return null;
    }
    const isPm = meridiemMatch[3]?.startsWith("p") ?? false;
    return {
      hour: rawHour === 12 ? (isPm ? 12 : 0) : rawHour + (isPm ? 12 : 0),
      minute,
      hasMeridiem: true,
    };
  }

  const hourSuffixMatch = input.match(/\b(\d{1,2})\s*h(?:\s*(\d{2}))?\b/);
  if (hourSuffixMatch) {
    const hour = Number(hourSuffixMatch[1]);
    const minute = hourSuffixMatch[2] ? Number(hourSuffixMatch[2]) : 0;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      return null;
    }
    return { hour, minute, hasMeridiem: true };
  }

  const qualifiedTimeMatch = input.match(
    /\b(?:at|around|about|near|vers|a|à)\s+(\d{1,2})(?:(?::|\s)(\d{2}))?\b/,
  );
  const bareTimeMatch = input.trim().match(/^(\d{1,2})(?:(?::|\s)(\d{2}))?$/);
  const match = qualifiedTimeMatch ?? bareTimeMatch;
  if (!match) {
    return null;
  }

  const hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  if (hour < 1 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }

  return { hour, minute, hasMeridiem: false };
}

function appointmentDayPartMatches(hour: number, input: string): boolean | null {
  if (/\b(morning|matin)\b/.test(input)) {
    return hour >= 5 && hour < 12;
  }
  if (/\b(afternoon|apres midi|apres-midi|apr s midi)\b/.test(input)) {
    return hour >= 12 && hour < 17;
  }
  if (/\b(evening|soir|soiree|soir e)\b/.test(input)) {
    return hour >= 17 && hour < 21;
  }
  if (/\b(night|tonight|nuit)\b/.test(input)) {
    return hour >= 21 || hour < 5;
  }
  return null;
}

function clockDifferenceMinutes(leftMinutes: number, rightMinutes: number): number {
  const absoluteDifference = Math.abs(leftMinutes - rightMinutes);
  return Math.min(absoluteDifference, 24 * 60 - absoluteDifference);
}

function appointmentClockTimeMatches(
  local: Pick<LocalAppointmentDateTime, "hour" | "minute">,
  clockTime: { hour: number; minute: number; hasMeridiem: boolean },
): boolean {
  // Caller supplied times are approximate; keep the matching window explicit
  // and consistent for both absolute and spoken local-time facts.
  const localMinutes = local.hour * 60 + local.minute;
  const candidateHours = clockTime.hasMeridiem
    ? [clockTime.hour]
    : [...new Set([clockTime.hour, (clockTime.hour + 12) % 24])];

  return candidateHours.some((hour) => {
    const candidateMinutes = hour * 60 + clockTime.minute;
    return clockDifferenceMinutes(localMinutes, candidateMinutes) <= 30;
  });
}

export function inspectAppointmentTimeFact(
  appointment: AppointmentFact,
  providedStartsAt: string,
): AppointmentTimeFactInspection {
  const empty: AppointmentTimeFactInspection = { valid: false, hasDate: false, hasTime: false, dateMatches: false, timeMatches: false, matches: false };
  const normalized = normalizeComparable(providedStartsAt);
  if (!normalized) return empty;

  const absoluteInput = /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(providedStartsAt.trim());
  const actualMs = Date.parse(appointment.startsAt);
  const providedMs = absoluteInput ? Date.parse(providedStartsAt) : Number.NaN;
  if (absoluteInput && Number.isFinite(actualMs) && Number.isFinite(providedMs)) {
    const matches = Math.abs(actualMs - providedMs) <= 30 * 60 * 1000;
    return { valid: true, hasDate: true, hasTime: true, dateMatches: matches, timeMatches: matches, matches };
  }

  let local: LocalAppointmentDateTime | null;
  try {
    local = getAppointmentLocalDateTime(appointment);
  } catch {
    return empty;
  }
  if (!local) return empty;

  const raw = providedStartsAt.trim().toLowerCase();
  let hasDate = false;
  let dateMatches = true;
  const isoDateMatch = raw.match(/\b((?:19|20)\d{2})-(\d{1,2})-(\d{1,2})\b/);
  const yearMatch = normalized.match(/\b((?:19|20)\d{2})\b/);
  if (yearMatch) {
    hasDate = true;
    dateMatches = dateMatches && Number(yearMatch[1]) === local.year;
  }

  const monthDayMatch = normalized.match(new RegExp("\\b(" + MONTH_PATTERN + ")\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b"));
  const dayMonthMatch = normalized.match(new RegExp("\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(" + MONTH_PATTERN + ")\\b"));
  const numericDateMatch = isoDateMatch ? null : raw.match(/\b(\d{1,2})[/.\\-](\d{1,2})(?:[/.\\-]((?:19|20)\d{2}))?\b/);
  if (isoDateMatch || monthDayMatch || dayMonthMatch || numericDateMatch) {
    hasDate = true;
    let month: number;
    let day: number;
    let year: number | undefined;
    if (isoDateMatch) {
      year = Number(isoDateMatch[1]);
      month = Number(isoDateMatch[2]);
      day = Number(isoDateMatch[3]);
    } else if (numericDateMatch) {
      const first = Number(numericDateMatch[1]);
      const second = Number(numericDateMatch[2]);
      month = first > 12 ? second : first;
      day = first > 12 ? first : second;
      year = numericDateMatch[3] ? Number(numericDateMatch[3]) : undefined;
    } else {
      const monthFirst = Boolean(monthDayMatch);
      month = MONTHS_BY_NAME.get(monthFirst ? monthDayMatch![1]! : dayMonthMatch![2]!) ?? 0;
      day = Number(monthFirst ? monthDayMatch![2] : dayMonthMatch![1]);
    }
    const numericAlternatives = numericDateMatch && Number(numericDateMatch[1]) <= 12 && Number(numericDateMatch[2]) <= 12
      ? [[Number(numericDateMatch[2]), Number(numericDateMatch[1])]]
      : [];
    const dateMatchesAnyInterpretation = [[month, day], ...numericAlternatives].some(([candidateMonth, candidateDay]) =>
      candidateMonth === local.month && candidateDay === local.day && (year === undefined || year === local.year),
    );
    dateMatches = dateMatches && dateMatchesAnyInterpretation;
  }

  const weekday = [...WEEKDAYS_BY_NAME.entries()].find(([name]) =>
    new RegExp("\\b" + name + "\\b").test(normalized),
  )?.[1];
  if (weekday !== undefined) {
    hasDate = true;
    dateMatches = dateMatches && weekday === local.weekday;
  }

  const relativeDay = /\b(tomorrow|tmrw|demain|manana|amanha|morgen)\b/.test(normalized)
    ? getBusinessRelativeLocalDate(appointment.timezone, 1)
    : /\b(today|aujourd hui|hoy|hoje|heute)\b/.test(normalized)
      ? getBusinessRelativeLocalDate(appointment.timezone, 0)
      : null;
  if (relativeDay) {
    hasDate = true;
    dateMatches = dateMatches && relativeDay.year === local.year && relativeDay.month === local.month && relativeDay.day === local.day;
  }

  const clockTime = parseProvidedClockTime(raw);
  const isoClockMatch = raw.match(/\b(?:t|at)\s*(\d{1,2}):(\d{2})\b/) ?? raw.match(/\b(\d{1,2}):(\d{2}):\d{2}\b/);
  const clock = clockTime ?? (isoClockMatch ? { hour: Number(isoClockMatch[1]), minute: Number(isoClockMatch[2]), hasMeridiem: true } : null);
  const dayPartMatches = appointmentDayPartMatches(local.hour, normalized);
  const hasTime = Boolean(clock || dayPartMatches !== null);
  const timeMatches = clock ? appointmentClockTimeMatches(local, clock) : dayPartMatches === null ? true : dayPartMatches;
  const valid = hasDate || hasTime;
  return { valid, hasDate, hasTime, dateMatches, timeMatches, matches: valid && dateMatches && timeMatches };
}

export function appointmentSearchRanges(
  input: string,
  timezone: string,
  now = new Date(),
): Array<{ startsAtOrAfter: Date; startsBefore: Date }> {
  const normalized = normalizeComparable(input);
  if (!normalized) return [];
  const isoDate = input.match(/\b((?:19|20)\d{2})-(\d{1,2})-(\d{1,2})\b/);
  const named = normalized.match(new RegExp("\\b(" + MONTH_PATTERN + ")\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b"))
    ?? normalized.match(new RegExp("\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(" + MONTH_PATTERN + ")\\b"));
  const numeric = isoDate ? null : input.match(/\b(\d{1,2})[/.\\-](\d{1,2})(?:[/.\\-]((?:19|20)\d{2}))?\b/);
  let month = 0;
  let day = 0;
  let alternateNumericDate: { month: number; day: number } | undefined;
  let year: number | undefined = Number(normalized.match(/\b((?:19|20)\d{2})\b/)?.[1]) || undefined;
  if (isoDate) {
    year = Number(isoDate[1]);
    month = Number(isoDate[2]);
    day = Number(isoDate[3]);
  } else if (named) {
    const monthFirst = Boolean(named[1] && MONTHS_BY_NAME.has(named[1]));
    month = MONTHS_BY_NAME.get(monthFirst ? named[1]! : named[2]!) ?? 0;
    day = Number(monthFirst ? named[2] : named[1]);
  } else if (numeric) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    month = first > 12 ? second : first;
    day = first > 12 ? first : second;
    year = numeric[3] ? Number(numeric[3]) : undefined;
    if (first <= 12 && second <= 12) alternateNumericDate = { month: second, day: first };
  }

  let nowLocal: DateTime;
  try {
    nowLocal = DateTime.fromJSDate(now, { zone: timezone });
  } catch {
    return [];
  }
  if (!nowLocal.isValid) return [];
  const years = new Set<number>();
  if (month && day) {
    if (year) years.add(year);
    else {
      years.add(nowLocal.year - 1);
      years.add(nowLocal.year);
      years.add(nowLocal.year + 1);
    }
  } else if (/\b(tomorrow|tmrw|demain|manana|amanha|morgen)\b/.test(normalized)) {
    const date = nowLocal.plus({ days: 1 });
    years.add(date.year);
    month = date.month;
    day = date.day;
  } else if (/\b(today|aujourd hui|hoy|hoje|heute)\b/.test(normalized)) {
    years.add(nowLocal.year);
    month = nowLocal.month;
    day = nowLocal.day;
  } else {
    return [];
  }

  const ranges: Array<{ startsAtOrAfter: Date; startsBefore: Date }> = [];
  const dateOptions = [{ month, day }, ...(alternateNumericDate ? [alternateNumericDate] : [])];
  for (const selectedYear of years) {
    for (const option of dateOptions) {
      const date = DateTime.fromObject({ year: selectedYear, month: option.month, day: option.day }, { zone: "UTC" });
      if (!date.isValid) continue;
      ranges.push({
        // Appointments may be stored in any civil timezone, so widen the UTC
        // window rather than interpreting a spoken date in the server timezone.
        startsAtOrAfter: date.startOf("day").minus({ hours: 14 }).toJSDate(),
        startsBefore: date.startOf("day").plus({ days: 1, hours: 12 }).toJSDate(),
      });
    }
  }
  return ranges;
}
