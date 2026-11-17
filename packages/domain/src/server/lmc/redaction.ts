/** Action/reply capabilities belong to the recipient and execution layer, not model prompts or CRM read responses. */
export function redactLmcCapabilities(value: string): string {
  return value
    .replace(
      /https?:\/\/[^\s<>]+\/api\/lmc\/unsubscribe\/[A-Za-z0-9_.-]+/g,
      "[unsubscribe link sent to lead]",
    )
    .replace(
      /reply\+[A-Za-z0-9_-]{43}@[A-Za-z0-9.-]+/g,
      "[conversation reply address]",
    )
    .replace(
      /(?:lead|forward)\+[A-Za-z0-9_-]{43}@[A-Za-z0-9.-]+/gi,
      "[lead intake address]",
    );
}

export function redactLmcReadValue<T>(value: T): T {
  if (typeof value === "string") return redactLmcCapabilities(value) as T;
  if (value instanceof Date) return value;
  if (Array.isArray(value))
    return value.map((item) => redactLmcReadValue(item)) as T;
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactLmcReadValue(item),
      ]),
    ) as T;
  return value;
}
