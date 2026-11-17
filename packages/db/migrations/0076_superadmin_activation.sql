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
        WHEN b.status='paused' THEN 'paused'
        WHEN draft.tenant_id IS NOT NULL AND owner.user_id IS NULL THEN 'draft'
        WHEN draft.tenant_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.calendar_connections c WHERE c.business_id=b.id AND c.owner_user_id=owner.user_id AND c.status='connected' AND c.selected_calendar_id IS NOT NULL AND c.last_synced_at >= now() - interval '24 hours') THEN 'needs_connection'
        WHEN draft.tenant_id IS NOT NULL AND (settings.tenant_id IS NULL OR b.status='draft' OR NOT settings.enabled) THEN 'ready_for_test'
        WHEN settings.tenant_id IS NULL THEN 'draft'
        WHEN NOT EXISTS (SELECT 1 FROM public.calendar_connections c WHERE c.business_id=b.id AND c.status='connected') THEN 'needs_connection'
        WHEN NOT settings.enabled THEN 'ready_for_test' ELSE 'active' END AS lifecycle,
      greatest(b.updated_at,coalesce(settings.updated_at,b.updated_at),coalesce(draft.updated_at,b.updated_at)) AS updated_at
    FROM public.businesses b LEFT JOIN public.lmc_settings settings ON settings.tenant_id=b.id
    LEFT JOIN public.lmc_tenant_drafts draft ON draft.tenant_id=b.id
    LEFT JOIN LATERAL (SELECT u.id AS user_id,u.email FROM public.business_memberships m JOIN public.users u ON u.id=m.user_id WHERE m.business_id=b.id AND m.status='active' AND m.role='business_owner' AND u.email_verified AND (draft.owner_email IS NULL OR u.normalized_email=draft.owner_email) ORDER BY m.created_at LIMIT 1) owner ON true
    WHERE coalesce(p_search,'')='' OR b.name ILIKE '%'||p_search||'%' OR b.slug ILIKE '%'||p_search||'%' OR coalesce(owner.email,draft.owner_email) ILIKE '%'||p_search||'%'
  ) SELECT clients.id,clients.name,clients.slug,clients.owner_email,clients.lifecycle,clients.updated_at,count(*) OVER () FROM clients ORDER BY clients.updated_at DESC,clients.id LIMIT p_limit OFFSET p_offset;
END $$;
REVOKE ALL ON FUNCTION app.superadmin_clients(text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.superadmin_clients(text,integer,integer) TO lobbystack_app;

CREATE OR REPLACE FUNCTION app.superadmin_overview()
RETURNS TABLE (lifecycle text, client_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT app.is_verified_platform_admin(app.current_user_id()) THEN RAISE insufficient_privilege USING MESSAGE = 'Platform administrator access is required.'; END IF;
  RETURN QUERY WITH clients AS (
    SELECT CASE WHEN b.status = 'error' OR EXISTS (SELECT 1 FROM public.lmc_jobs j WHERE j.tenant_id=b.id AND j.status IN ('failed','dead')) THEN 'error'
      WHEN b.status='paused' THEN 'paused'
      WHEN draft.tenant_id IS NOT NULL AND owner.user_id IS NULL THEN 'draft'
      WHEN draft.tenant_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.calendar_connections c WHERE c.business_id=b.id AND c.owner_user_id=owner.user_id AND c.status='connected' AND c.selected_calendar_id IS NOT NULL AND c.last_synced_at >= now() - interval '24 hours') THEN 'needs_connection'
      WHEN draft.tenant_id IS NOT NULL AND (settings.tenant_id IS NULL OR b.status='draft' OR NOT settings.enabled) THEN 'ready_for_test'
      WHEN settings.tenant_id IS NULL THEN 'draft'
      WHEN NOT EXISTS (SELECT 1 FROM public.calendar_connections c WHERE c.business_id=b.id AND c.status='connected') THEN 'needs_connection'
      WHEN NOT settings.enabled THEN 'ready_for_test' ELSE 'active' END AS lifecycle
    FROM public.businesses b LEFT JOIN public.lmc_settings settings ON settings.tenant_id=b.id
    LEFT JOIN public.lmc_tenant_drafts draft ON draft.tenant_id=b.id
    LEFT JOIN LATERAL (SELECT u.id AS user_id FROM public.business_memberships m JOIN public.users u ON u.id=m.user_id WHERE m.business_id=b.id AND m.status='active' AND m.role='business_owner' AND u.email_verified AND (draft.owner_email IS NULL OR u.normalized_email=draft.owner_email) ORDER BY m.created_at LIMIT 1) owner ON true
  ) SELECT clients.lifecycle,count(*)::bigint FROM clients GROUP BY clients.lifecycle;
END $$;
REVOKE ALL ON FUNCTION app.superadmin_overview() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.superadmin_overview() TO lobbystack_app;

CREATE OR REPLACE FUNCTION app.superadmin_managed_owner(p_tenant_id uuid)
RETURNS TABLE (user_id uuid, email_verified boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT app.is_verified_platform_admin(app.current_user_id()) THEN RAISE insufficient_privilege USING MESSAGE = 'Platform administrator access is required.'; END IF;
  RETURN QUERY
    SELECT u.id,u.email_verified
    FROM public.lmc_tenant_drafts d
    JOIN public.business_memberships m ON m.business_id=d.tenant_id AND m.status='active' AND m.role='business_owner'
    JOIN public.users u ON u.id=m.user_id AND u.normalized_email=d.owner_email
    WHERE d.tenant_id=p_tenant_id
    ORDER BY m.created_at
    LIMIT 1;
END $$;
REVOKE ALL ON FUNCTION app.superadmin_managed_owner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.superadmin_managed_owner(uuid) TO lobbystack_app;
