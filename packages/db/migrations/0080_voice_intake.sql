-- Service-specific voice intake. Existing rows remain in legacy/unspecified
-- mode: no new mandatory information is imposed until an operator configures it.
ALTER TABLE services ADD COLUMN IF NOT EXISTS intake_policy jsonb;
ALTER TABLE receptionist_profiles ADD COLUMN IF NOT EXISTS intake_policy jsonb;
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS service_location jsonb,
  ADD COLUMN IF NOT EXISTS intake_answers jsonb,
  ADD COLUMN IF NOT EXISTS intake_completion_status varchar(24) NOT NULL DEFAULT 'not_required';

DO $$ BEGIN
  ALTER TABLE appointments ADD CONSTRAINT appointments_intake_completion_status_check
    CHECK (intake_completion_status IN ('not_required', 'complete', 'pending_follow_up'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
