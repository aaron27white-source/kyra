-- Key 20 Virtual Assistant: service tiers, missed-call recovery (Tier 1),
-- outbound automations (Tier 3) and the Back Office add-on (quotes, invoices).

-- One row per business. Absent row = defaults (Tier 1, text-back on, voice off).
CREATE TABLE IF NOT EXISTS public.assistant_settings (
  business_id uuid PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
  service_tier varchar(32) NOT NULL DEFAULT 'missed_call',
  back_office_enabled boolean NOT NULL DEFAULT false,
  missed_call_text_enabled boolean NOT NULL DEFAULT true,
  missed_call_greeting text,
  text_back_message text,
  text_back_message_es text,
  sms_ai_enabled boolean NOT NULL DEFAULT true,
  photo_requests_enabled boolean NOT NULL DEFAULT true,
  -- The voice switch: when on, the AI calls missed callers back.
  voice_callback_enabled boolean NOT NULL DEFAULT false,
  callback_mode varchar(16) NOT NULL DEFAULT 'ask_first',
  callback_delay_seconds integer NOT NULL DEFAULT 60,
  after_hours_mode varchar(16) NOT NULL DEFAULT 'send_now',
  -- Outbound calls and automated texts only inside this local window.
  contact_window_start_minutes integer NOT NULL DEFAULT 480,
  contact_window_end_minutes integer NOT NULL DEFAULT 1200,
  emergency_phone varchar(32),
  review_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_settings_tier CHECK (service_tier IN ('missed_call', 'receptionist', 'assistant')),
  CONSTRAINT assistant_settings_callback_mode CHECK (callback_mode IN ('ask_first', 'automatic')),
  CONSTRAINT assistant_settings_after_hours CHECK (after_hours_mode IN ('send_now', 'hold')),
  CONSTRAINT assistant_settings_delay CHECK (callback_delay_seconds BETWEEN 0 AND 900),
  CONSTRAINT assistant_settings_window CHECK (
    contact_window_start_minutes BETWEEN 0 AND 1439
    AND contact_window_end_minutes BETWEEN 1 AND 1440
    AND contact_window_start_minutes < contact_window_end_minutes
  )
);

CREATE TABLE IF NOT EXISTS public.missed_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  provider_call_id varchar(255) NOT NULL,
  caller_phone varchar(32) NOT NULL,
  dialled_phone varchar(32) NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  after_hours boolean NOT NULL DEFAULT false,
  -- A repeat call inside the cooldown points at the first missed call and sends nothing.
  repeat_of_id uuid REFERENCES public.missed_calls(id) ON DELETE SET NULL,
  status varchar(32) NOT NULL DEFAULT 'new',
  text_back_message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  text_back_due_at timestamptz,
  consent_requested_at timestamptz,
  consent_message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  consent_granted_at timestamptz,
  -- Opaque token carried through Twilio and the SIP header; never the row id.
  callback_token varchar(64),
  callback_due_at timestamptz,
  callback_attempted_at timestamptz,
  callback_provider_call_id varchar(255),
  callback_outcome varchar(32),
  handled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT missed_calls_status CHECK (status IN ('new', 'held', 'texted', 'awaiting_consent', 'callback_queued', 'calling', 'reached', 'not_reached', 'handled', 'opted_out', 'skipped'))
);
CREATE UNIQUE INDEX IF NOT EXISTS missed_calls_provider_call_unique ON public.missed_calls(business_id, provider_call_id);
CREATE UNIQUE INDEX IF NOT EXISTS missed_calls_callback_token_unique ON public.missed_calls(callback_token) WHERE callback_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS missed_calls_business_caller_idx ON public.missed_calls(business_id, caller_phone, received_at DESC);
CREATE INDEX IF NOT EXISTS missed_calls_business_received_idx ON public.missed_calls(business_id, received_at DESC);

CREATE TABLE IF NOT EXISTS public.outreach_automations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  kind varchar(32) NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  message_template text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outreach_automations_kind CHECK (kind IN ('quote_followup', 'review_request', 'win_back', 'lead_nudge', 'owner_brief', 'payment_reminder')),
  CONSTRAINT outreach_automations_settings_object CHECK (jsonb_typeof(settings) = 'object')
);
CREATE UNIQUE INDEX IF NOT EXISTS outreach_automations_business_kind_unique ON public.outreach_automations(business_id, kind);

-- One row per automated send. The unique key makes every sweep idempotent.
CREATE TABLE IF NOT EXISTS public.outreach_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  kind varchar(32) NOT NULL,
  subject_id uuid NOT NULL,
  step integer NOT NULL DEFAULT 1,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS outreach_sends_subject_step_unique ON public.outreach_sends(business_id, kind, subject_id, step);
CREATE INDEX IF NOT EXISTS outreach_sends_contact_sent_idx ON public.outreach_sends(business_id, contact_id, sent_at DESC);

CREATE TABLE IF NOT EXISTS public.quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  title text NOT NULL,
  amount_cents integer NOT NULL,
  currency varchar(3) NOT NULL DEFAULT 'USD',
  status varchar(16) NOT NULL DEFAULT 'draft',
  notes text,
  line_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  sent_at timestamptz,
  decided_at timestamptz,
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quotes_status CHECK (status IN ('draft', 'sent', 'accepted', 'declined', 'expired')),
  CONSTRAINT quotes_amount CHECK (amount_cents >= 0),
  CONSTRAINT quotes_line_items_array CHECK (jsonb_typeof(line_items) = 'array')
);
CREATE INDEX IF NOT EXISTS quotes_business_status_idx ON public.quotes(business_id, status, sent_at);

CREATE TABLE IF NOT EXISTS public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  appointment_id uuid REFERENCES public.appointments(id) ON DELETE SET NULL,
  quote_id uuid REFERENCES public.quotes(id) ON DELETE SET NULL,
  number varchar(32) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'draft',
  currency varchar(3) NOT NULL DEFAULT 'USD',
  total_cents integer NOT NULL,
  line_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  payment_url text,
  notes text,
  due_at timestamptz,
  sent_at timestamptz,
  paid_at timestamptz,
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoices_status CHECK (status IN ('draft', 'sent', 'paid', 'void')),
  CONSTRAINT invoices_total CHECK (total_cents >= 0),
  CONSTRAINT invoices_line_items_array CHECK (jsonb_typeof(line_items) = 'array'),
  CONSTRAINT invoices_payment_url_https CHECK (payment_url IS NULL OR payment_url ~ '^https://')
);
CREATE UNIQUE INDEX IF NOT EXISTS invoices_business_number_unique ON public.invoices(business_id, number);
CREATE INDEX IF NOT EXISTS invoices_business_status_idx ON public.invoices(business_id, status, due_at);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['assistant_settings', 'missed_calls', 'outreach_automations', 'outreach_sends', 'quotes', 'invoices'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON public.%I', table_name, table_name);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON public.%I USING (business_id = app.current_business_id() AND (app.current_actor_type() IN (''system'', ''worker'', ''dispatcher'') OR app.has_business_membership(business_id))) WITH CHECK (business_id = app.current_business_id() AND (app.current_actor_type() IN (''system'', ''worker'', ''dispatcher'') OR app.has_business_membership(business_id)))',
      table_name, table_name
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO lobbystack_app, lobbystack_worker', table_name);
    EXECUTE format('GRANT SELECT ON public.%I TO lobbystack_readonly', table_name);
  END LOOP;
END
$$;

-- AI callbacks arrive (Twilio status callback, OpenAI SIP header) without a
-- tenant context. Map the opaque token to its business so the request can then
-- run inside that business's RLS context.
CREATE OR REPLACE FUNCTION app.resolve_missed_call_callback(p_token text)
RETURNS TABLE (business_id uuid, missed_call_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT missed.business_id, missed.id
  FROM public.missed_calls missed
  JOIN public.businesses business ON business.id = missed.business_id
  WHERE missed.callback_token = p_token
    AND length(p_token) >= 32
    AND business.status = 'active'
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION app.resolve_missed_call_callback(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_missed_call_callback(text) TO lobbystack_app, lobbystack_worker;
