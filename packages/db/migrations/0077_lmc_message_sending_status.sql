-- The worker claims outbound messages as `sending` before calling the provider.
-- Keep that durable state in the database so provider calls never run inside a
-- long transaction and stale sends can be reconciled safely after a restart.
ALTER TABLE public.lmc_messages
  DROP CONSTRAINT IF EXISTS lmc_messages_status_check;

ALTER TABLE public.lmc_messages
  ADD CONSTRAINT lmc_messages_status_check
  CHECK (status IN ('received','queued','sending','sent','failed','cancelled'));
