ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS origin_call_id uuid REFERENCES calls(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS idempotency_key varchar(128);

CREATE UNIQUE INDEX IF NOT EXISTS appointments_call_idempotency_unique
  ON appointments (business_id, origin_call_id, idempotency_key)
  WHERE origin_call_id IS NOT NULL AND idempotency_key IS NOT NULL;
