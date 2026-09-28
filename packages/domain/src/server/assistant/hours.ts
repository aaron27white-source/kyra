import { DateTime } from "luxon";

export type WeeklyHours = Array<{ dayOfWeek: number; openMinutes: number; closeMinutes: number }>;
export type Closure = { startsAt: Date; endsAt: Date };

const LOOKAHEAD_DAYS = 14;

/**
 * Whether the business is open at `now`, and when it next opens if not.
 * dayOfWeek follows the rest of the app: 0 = Sunday. Closures (holidays,
 * days off) win over weekly hours. No hours at all counts as always closed,
 * with no next opening.
 */
export function openingState(now: Date, timezone: string, hours: WeeklyHours, closures: Closure[]): { open: boolean; nextOpenAt: Date | null } {
  const local = DateTime.fromJSDate(now, { zone: timezone });
  const closureAt = (instant: DateTime) => closures.find((closure) => instant.toMillis() >= closure.startsAt.getTime() && instant.toMillis() < closure.endsAt.getTime());
  for (let offset = 0; offset <= LOOKAHEAD_DAYS; offset += 1) {
    const day = local.startOf("day").plus({ days: offset });
    const today = hours.find((row) => row.dayOfWeek === day.weekday % 7);
    if (!today || today.closeMinutes <= today.openMinutes) continue;
    const opensAt = day.plus({ minutes: today.openMinutes });
    const closesAt = day.plus({ minutes: today.closeMinutes });
    let candidate = opensAt < local ? local : opensAt;
    // Step past any closures that cover the candidate time.
    for (let guard = 0; guard < 20; guard += 1) {
      const closure = closureAt(candidate);
      if (!closure) break;
      candidate = DateTime.fromJSDate(closure.endsAt, { zone: timezone });
    }
    if (candidate >= closesAt) continue;
    if (candidate.toMillis() === local.toMillis()) return { open: true, nextOpenAt: null };
    return { open: false, nextOpenAt: candidate.toJSDate() };
  }
  return { open: false, nextOpenAt: null };
}
