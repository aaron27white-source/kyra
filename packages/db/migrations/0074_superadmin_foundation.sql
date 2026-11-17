ALTER TABLE public.users
  ADD COLUMN two_factor_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE public.two_factors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  secret text NOT NULL,
  backup_codes text NOT NULL,
  verified boolean NOT NULL DEFAULT false,
  failed_verification_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT two_factors_user_unique UNIQUE (user_id)
);

ALTER TABLE public.two_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.two_factors FORCE ROW LEVEL SECURITY;
CREATE POLICY two_factors_auth_access ON public.two_factors
  FOR ALL TO lobbystack_auth USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.two_factors TO lobbystack_auth;
GRANT SELECT (id, platform_role, email_verified, two_factor_enabled) ON public.users TO lobbystack_app;

CREATE TABLE public.platform_admin_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  action varchar(120) NOT NULL,
  target_type varchar(80) NOT NULL,
  target_id text,
  changes jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_admin_audit_events_created_idx ON public.platform_admin_audit_events (created_at);
CREATE INDEX platform_admin_audit_events_actor_idx ON public.platform_admin_audit_events (actor_user_id, created_at);
ALTER TABLE public.platform_admin_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_admin_audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_admin_audit_system_access ON public.platform_admin_audit_events
  FOR ALL TO lobbystack_system
  USING (app.current_actor_type() = 'system')
  WITH CHECK (app.current_actor_type() = 'system');
GRANT SELECT, INSERT ON public.platform_admin_audit_events TO lobbystack_system;

CREATE OR REPLACE FUNCTION app.is_verified_platform_admin(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = p_user_id
      AND platform_role = 'platform_admin'
      AND email_verified
      AND two_factor_enabled
  )
$$;
REVOKE ALL ON FUNCTION app.is_verified_platform_admin(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.superadmin_clients(p_search text, p_limit integer, p_offset integer)
RETURNS TABLE (
  id uuid, name text, slug varchar, owner_email text, lifecycle text,
  updated_at timestamptz, total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT app.is_verified_platform_admin(app.current_user_id()) THEN
    RAISE insufficient_privilege USING MESSAGE = 'Platform administrator access is required.';
  END IF;
  IF p_limit < 1 OR p_limit > 100 OR p_offset < 0 OR length(coalesce(p_search, '')) > 160 THEN
    RAISE invalid_parameter_value USING MESSAGE = 'Invalid pagination or search input.';
  END IF;
  RETURN QUERY
  WITH clients AS (
    SELECT b.id, b.name, b.slug,
      owner.email AS owner_email,
      CASE
        WHEN b.status = 'error' OR EXISTS (
          SELECT 1 FROM public.lmc_jobs j
          WHERE j.tenant_id = b.id AND j.status IN ('failed', 'dead')
        ) THEN 'error'
        WHEN b.status = 'paused' THEN 'paused'
        WHEN settings.tenant_id IS NULL THEN 'draft'
        WHEN NOT EXISTS (
          SELECT 1 FROM public.calendar_connections connection
          WHERE connection.business_id = b.id AND connection.status = 'connected'
        ) THEN 'needs_connection'
        WHEN NOT settings.enabled THEN 'ready_for_test'
        ELSE 'active'
      END AS lifecycle,
      greatest(b.updated_at, coalesce(settings.updated_at, b.updated_at)) AS updated_at
    FROM public.businesses b
    LEFT JOIN public.lmc_settings settings ON settings.tenant_id = b.id
    LEFT JOIN LATERAL (
      SELECT u.email
      FROM public.business_memberships membership
      JOIN public.users u ON u.id = membership.user_id
      WHERE membership.business_id = b.id
        AND membership.status = 'active'
        AND membership.role IN ('business_owner', 'business_admin')
      ORDER BY CASE membership.role WHEN 'business_owner' THEN 0 ELSE 1 END, membership.created_at
      LIMIT 1
    ) owner ON true
    WHERE coalesce(p_search, '') = ''
      OR b.name ILIKE '%' || p_search || '%'
      OR b.slug ILIKE '%' || p_search || '%'
      OR owner.email ILIKE '%' || p_search || '%'
  )
  SELECT clients.id, clients.name, clients.slug, clients.owner_email, clients.lifecycle,
    clients.updated_at, count(*) OVER () AS total_count
  FROM clients
  ORDER BY clients.updated_at DESC, clients.id
  LIMIT p_limit OFFSET p_offset;
END
$$;
REVOKE ALL ON FUNCTION app.superadmin_clients(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.superadmin_clients(text, integer, integer) TO lobbystack_app;

CREATE OR REPLACE FUNCTION app.superadmin_overview()
RETURNS TABLE (lifecycle text, client_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT app.is_verified_platform_admin(app.current_user_id()) THEN
    RAISE insufficient_privilege USING MESSAGE = 'Platform administrator access is required.';
  END IF;
  RETURN QUERY
  SELECT CASE
      WHEN b.status = 'error' OR EXISTS (
        SELECT 1 FROM public.lmc_jobs j
        WHERE j.tenant_id = b.id AND j.status IN ('failed', 'dead')
      ) THEN 'error'
      WHEN b.status = 'paused' THEN 'paused'
      WHEN settings.tenant_id IS NULL THEN 'draft'
      WHEN NOT EXISTS (
        SELECT 1 FROM public.calendar_connections connection
        WHERE connection.business_id = b.id AND connection.status = 'connected'
      ) THEN 'needs_connection'
      WHEN NOT settings.enabled THEN 'ready_for_test'
      ELSE 'active'
    END AS lifecycle,
    count(*)::bigint AS client_count
  FROM public.businesses b
  LEFT JOIN public.lmc_settings settings ON settings.tenant_id = b.id
  GROUP BY 1;
END
$$;
REVOKE ALL ON FUNCTION app.superadmin_overview() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.superadmin_overview() TO lobbystack_app;

CREATE OR REPLACE FUNCTION app.bootstrap_platform_admin(p_email text, p_request_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  target_user_id uuid;
BEGIN
  IF session_user <> 'lobbystack_system' THEN
    RAISE insufficient_privilege USING MESSAGE = 'System database identity required.';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('lobbystack:platform-admin-bootstrap', 0));
  IF EXISTS (SELECT 1 FROM public.users WHERE platform_role = 'platform_admin') THEN
    RAISE unique_violation USING MESSAGE = 'A platform administrator already exists.';
  END IF;
  SELECT id INTO target_user_id
  FROM public.users
  WHERE normalized_email = lower(btrim(p_email)) AND email_verified
  FOR UPDATE;
  IF target_user_id IS NULL THEN
    RAISE no_data_found USING MESSAGE = 'A verified user with that email was not found.';
  END IF;
  UPDATE public.users SET platform_role = 'platform_admin', updated_at = now() WHERE id = target_user_id;
  INSERT INTO public.platform_admin_audit_events
    (actor_user_id, action, target_type, target_id, changes, request_id)
  VALUES
    (target_user_id, 'platform_admin.bootstrap', 'user', target_user_id::text,
     jsonb_build_object('platformRole', 'platform_admin', 'mfaRequired', true), p_request_id);
  RETURN target_user_id;
END
$$;
REVOKE ALL ON FUNCTION app.bootstrap_platform_admin(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.bootstrap_platform_admin(text, uuid) TO lobbystack_system;
