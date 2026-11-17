CREATE TABLE public.lmc_tenant_drafts (
  tenant_id uuid PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
  owner_email text NOT NULL,
  draft jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_user_id uuid NOT NULL REFERENCES public.users(id),
  updated_by_user_id uuid NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lmc_tenant_drafts_owner_email_idx ON public.lmc_tenant_drafts (owner_email);
ALTER TABLE public.lmc_tenant_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lmc_tenant_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY lmc_tenant_drafts_system_access ON public.lmc_tenant_drafts
  FOR ALL TO lobbystack_system
  USING (app.current_actor_type() = 'system' AND tenant_id = app.current_business_id())
  WITH CHECK (app.current_actor_type() = 'system' AND tenant_id = app.current_business_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lmc_tenant_drafts TO lobbystack_system;

CREATE TABLE public.platform_admin_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES public.users(id),
  action varchar(120) NOT NULL,
  idempotency_key varchar(160) NOT NULL,
  request_hash varchar(64) NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_admin_operations_actor_action_key_unique UNIQUE (actor_user_id, action, idempotency_key)
);
ALTER TABLE public.platform_admin_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_admin_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_admin_operations_system_access ON public.platform_admin_operations
  FOR ALL TO lobbystack_system
  USING (app.current_actor_type() = 'system')
  WITH CHECK (app.current_actor_type() = 'system');
GRANT SELECT, INSERT ON public.platform_admin_operations TO lobbystack_system;

CREATE OR REPLACE FUNCTION app.superadmin_clients(p_search text, p_limit integer, p_offset integer)
RETURNS TABLE (id uuid, name text, slug varchar, owner_email text, lifecycle text, updated_at timestamptz, total_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT app.is_verified_platform_admin(app.current_user_id()) THEN RAISE insufficient_privilege USING MESSAGE = 'Platform administrator access is required.'; END IF;
  IF p_limit < 1 OR p_limit > 100 OR p_offset < 0 OR length(coalesce(p_search, '')) > 160 THEN RAISE invalid_parameter_value USING MESSAGE = 'Invalid pagination or search input.'; END IF;
  RETURN QUERY WITH clients AS (
    SELECT b.id, b.name, b.slug, coalesce(owner.email, draft.owner_email) AS owner_email,
      CASE WHEN b.status = 'error' OR EXISTS (SELECT 1 FROM public.lmc_jobs j WHERE j.tenant_id=b.id AND j.status IN ('failed','dead')) THEN 'error'
        WHEN b.status='paused' THEN 'paused' WHEN settings.tenant_id IS NULL THEN 'draft'
        WHEN NOT EXISTS (SELECT 1 FROM public.calendar_connections c WHERE c.business_id=b.id AND c.status='connected') THEN 'needs_connection'
        WHEN NOT settings.enabled THEN 'ready_for_test' ELSE 'active' END AS lifecycle,
      greatest(b.updated_at,coalesce(settings.updated_at,b.updated_at),coalesce(draft.updated_at,b.updated_at)) AS updated_at
    FROM public.businesses b LEFT JOIN public.lmc_settings settings ON settings.tenant_id=b.id
    LEFT JOIN public.lmc_tenant_drafts draft ON draft.tenant_id=b.id
    LEFT JOIN LATERAL (SELECT u.email FROM public.business_memberships m JOIN public.users u ON u.id=m.user_id WHERE m.business_id=b.id AND m.status='active' AND m.role IN ('business_owner','business_admin') ORDER BY CASE m.role WHEN 'business_owner' THEN 0 ELSE 1 END,m.created_at LIMIT 1) owner ON true
    WHERE coalesce(p_search,'')='' OR b.name ILIKE '%'||p_search||'%' OR b.slug ILIKE '%'||p_search||'%' OR coalesce(owner.email,draft.owner_email) ILIKE '%'||p_search||'%'
  ) SELECT clients.id,clients.name,clients.slug,clients.owner_email,clients.lifecycle,clients.updated_at,count(*) OVER () FROM clients ORDER BY clients.updated_at DESC,clients.id LIMIT p_limit OFFSET p_offset;
END $$;
REVOKE ALL ON FUNCTION app.superadmin_clients(text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.superadmin_clients(text,integer,integer) TO lobbystack_app;
