import { eq, or, sql, type SQL } from "drizzle-orm";

import { contacts } from "@lobbystack/db";

/** Match canonical E.164 plus common legacy formatting, without fuzzy suffix matching. */
export function contactPhoneMatchesCaller(callerPhone: string): SQL {
  const digits = callerPhone.replace(/\D/g, "");
  const normalizedStoredPhone = sql`regexp_replace(${contacts.phone}, '[^0-9]', '', 'g')`;
  const variants = [
    eq(contacts.phone, callerPhone),
    sql`${normalizedStoredPhone} = ${digits}`,
  ];

  // Many North American contact imports contain ten local digits without +1.
  if (callerPhone.startsWith("+1") && digits.length === 11) {
    variants.push(sql`${normalizedStoredPhone} = ${digits.slice(1)}`);
  }

  return or(...variants)!;
}

export function contactPhoneMatchesCallerValue(contactPhone: string | null, callerPhone: string): boolean {
  if (!contactPhone) return false;
  const storedDigits = contactPhone.replace(/\D/g, "");
  const callerDigits = callerPhone.replace(/\D/g, "");
  if (storedDigits === callerDigits) return true;
  return callerPhone.startsWith("+1") && callerDigits.length === 11 && storedDigits === callerDigits.slice(1);
}
