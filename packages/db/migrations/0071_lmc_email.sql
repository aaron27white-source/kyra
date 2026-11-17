-- Email-specific persistence is additive. Existing voice tables and runtime remain intact.
CREATE UNIQUE INDEX IF NOT EXISTS contacts_business_id_id_unique ON public.contacts(business_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS appointments_business_id_id_unique ON public.appointments(business_id, id);

CREATE TABLE IF NOT EXISTS public.lmc_settings (
  tenant_id uuid PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
  config jsonb NOT NULL,
  capture_token_hash text NOT NULL CHECK (capture_token_hash ~ '^[a-f0-9]{64}$'),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(config) = 'object')
);

CREATE TABLE IF NOT EXISTS public.lmc_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  contact_id uuid,
  email text NOT NULL CHECK (email = lower(email) AND length(email) <= 320),
  name text,
  subject text NOT NULL DEFAULT '',
  status varchar(32) NOT NULL DEFAULT 'new' CHECK (status IN ('new','qualifying','qualified','declined','human_handoff','booked','opted_out','suppressed')),
  reason text,
  qualification jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(qualification) = 'object'),
  offered_slots jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(offered_slots) = 'array'),
  reply_token_hash text NOT NULL CHECK (reply_token_hash ~ '^[a-f0-9]{64}$'),
  consent_followups boolean NOT NULL DEFAULT false,
  followup_count integer NOT NULL DEFAULT 0 CHECK (followup_count BETWEEN 0 AND 3),
  followup_generation integer NOT NULL DEFAULT 0 CHECK (followup_generation >= 0),
  ai_paused boolean NOT NULL DEFAULT false,
  appointment_id uuid,
  last_inbound_at timestamptz,
  last_outbound_message_id text,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, reply_token_hash),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES public.contacts(business_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, appointment_id) REFERENCES public.appointments(business_id,id)
);
CREATE INDEX IF NOT EXISTS lmc_leads_tenant_email_idx ON public.lmc_leads(tenant_id,email);
CREATE INDEX IF NOT EXISTS lmc_leads_tenant_status_idx ON public.lmc_leads(tenant_id,status,updated_at);

CREATE TABLE IF NOT EXISTS public.lmc_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL,
  direction varchar(16) NOT NULL CHECK (direction IN ('lead','assistant','human','owner')),
  kind varchar(32) NOT NULL CHECK (kind IN ('inbound','reply','followup','owner_alert')),
  message_id text NOT NULL CHECK (length(message_id) <= 255),
  provider_id text,
  to_email text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL CHECK (octet_length(body) <= 65536),
  headers jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(headers) = 'object'),
  status varchar(16) NOT NULL DEFAULT 'queued' CHECK (status IN ('received','queued','sending','sent','failed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,message_id),
  UNIQUE (tenant_id,provider_id),
  FOREIGN KEY (tenant_id,lead_id) REFERENCES public.lmc_leads(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS lmc_messages_history_idx ON public.lmc_messages(tenant_id,lead_id,created_at,id);

CREATE TABLE IF NOT EXISTS public.lmc_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  lead_id uuid,
  type varchar(160) NOT NULL,
  external_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,external_id),
  FOREIGN KEY (tenant_id,lead_id) REFERENCES public.lmc_leads(tenant_id,id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.lmc_suppressions (
  tenant_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(email) AND length(email) <= 320),
  reason varchar(32) NOT NULL CHECK (reason IN ('opt_out','bounce','complaint')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,email)
);

CREATE TABLE IF NOT EXISTS public.lmc_rate_windows (
  tenant_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  scope_key text NOT NULL CHECK (length(scope_key) <= 160),
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (tenant_id,scope_key,window_start)
);

CREATE TABLE IF NOT EXISTS public.lmc_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL,
  kind varchar(32) NOT NULL CHECK (kind IN ('process','send','followup')),
  dedupe_key text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status varchar(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','cancelled')),
  available_at timestamptz NOT NULL DEFAULT now(),
  leased_until timestamptz,
  lease_token uuid,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,dedupe_key),
  FOREIGN KEY (tenant_id,lead_id) REFERENCES public.lmc_leads(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS lmc_jobs_due_idx ON public.lmc_jobs(status,available_at,tenant_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lmc_settings','lmc_leads','lmc_messages','lmc_events','lmc_suppressions','lmc_rate_windows','lmc_jobs'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',t || '_tenant_isolation',t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I TO lobbystack_app,lobbystack_worker,lobbystack_readonly USING (tenant_id=app.current_business_id() AND (app.current_actor_type() IN (''system'',''worker'') OR app.has_business_membership(tenant_id))) WITH CHECK (tenant_id=app.current_business_id() AND (app.current_actor_type() IN (''system'',''worker'') OR app.has_business_membership(tenant_id)))',
      t || '_tenant_isolation',t
    );
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON public.%I TO lobbystack_app',t);
    IF t='lmc_settings' THEN
      EXECUTE format('GRANT SELECT ON public.%I TO lobbystack_worker',t);
    ELSE
      EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON public.%I TO lobbystack_worker',t);
    END IF;
    EXECUTE format('GRANT SELECT ON public.%I TO lobbystack_readonly',t);
  END LOOP;
END $$;

-- The unscoped dispatcher sees due-work metadata only. Workers read payloads
-- after entering that tenant's transaction. A scoped dispatcher cannot see B.
REVOKE ALL ON public.lmc_jobs FROM lobbystack_dispatcher;
GRANT SELECT(id,tenant_id,status,available_at) ON public.lmc_jobs TO lobbystack_dispatcher;
DROP POLICY IF EXISTS lmc_jobs_dispatch_metadata ON public.lmc_jobs;
CREATE POLICY lmc_jobs_dispatch_metadata ON public.lmc_jobs FOR SELECT TO lobbystack_dispatcher
  USING (app.current_actor_type()='dispatcher' AND (app.current_business_id() IS NULL OR tenant_id=app.current_business_id()));
