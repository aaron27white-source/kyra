-- Sharing service addresses with a connected calendar is opt-in per business.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS calendar_share_service_address boolean NOT NULL DEFAULT false;
