-- Trusted internal operations use a separate login, never a user-settable actor alone.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lobbystack_system') THEN
    CREATE ROLE lobbystack_system NOLOGIN;
  END IF;
END
$$;
ALTER ROLE lobbystack_system NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;
-- One-way inheritance preserves app object grants and policies for internal operations.
-- App must never inherit this role or be able to SET ROLE to it.
REVOKE lobbystack_system FROM lobbystack_app;
GRANT lobbystack_app TO lobbystack_system;
DO $$
BEGIN
  IF pg_has_role('lobbystack_app', 'lobbystack_system', 'MEMBER') THEN
    RAISE EXCEPTION 'Unsafe app membership in internal system role';
  END IF;
END
$$;
CREATE OR REPLACE FUNCTION app.current_actor_type()
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
  SELECT CASE COALESCE(NULLIF(current_setting('app.actor_type', true), ''), 'none')
    WHEN 'operator' THEN CASE WHEN current_user = 'lobbystack_app' THEN 'operator' ELSE 'none' END
    WHEN 'system' THEN CASE WHEN current_user = 'lobbystack_system' THEN 'system' ELSE 'none' END
    WHEN 'worker' THEN CASE WHEN current_user = 'lobbystack_worker' THEN 'worker' ELSE 'none' END
    WHEN 'dispatcher' THEN CASE WHEN current_user = 'lobbystack_dispatcher' THEN 'dispatcher' ELSE 'none' END
    ELSE 'none'
  END
$$;
REVOKE ALL ON FUNCTION app.current_actor_type() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_actor_type() TO lobbystack_app, lobbystack_system, lobbystack_worker, lobbystack_dispatcher, lobbystack_readonly;
