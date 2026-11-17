-- Inbound GPT-Live is opt-in per LMC tenant. Existing phone/SIP records and
-- outbound missed-call callbacks are intentionally unaffected.
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS lmc_voice_enabled boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION app.resolve_lmc_live_business_by_phone(phone_e164 text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT p.business_id
  FROM public.phone_numbers p
  JOIN public.businesses b ON b.id = p.business_id
  JOIN public.lmc_settings s ON s.tenant_id = p.business_id
  WHERE p.e164 = phone_e164
    AND p.status = 'active'
    AND p.voice_enabled
    AND b.deployment_mode = 'cloud'
    AND b.status = 'active'
    AND b.lmc_voice_enabled
    AND s.enabled
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION app.resolve_lmc_live_business_by_phone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_lmc_live_business_by_phone(text) TO lobbystack_app;
