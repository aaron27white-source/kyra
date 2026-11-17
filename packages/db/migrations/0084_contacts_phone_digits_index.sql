-- lobbystack:concurrent-index contacts_business_phone_digits_idx
CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_business_phone_digits_idx
  ON public.contacts (business_id, (regexp_replace(phone, '[^0-9]', '', 'g')))
  WHERE phone IS NOT NULL;
