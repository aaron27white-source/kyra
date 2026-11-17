-- Canonical tenant identity for the directly business-owned legacy tables.
-- A stored generated key cannot disagree with the existing ownership key.
-- Existing RLS predicates on business_id are therefore equivalent to tenant_id.
-- Global and mixed-scope tables are deliberately not assigned a fabricated tenant.
DO $$
DECLARE target record;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('affiliate_attributions', 'business_id'),
      ('affiliate_voided_sources', 'business_id'),
      ('agent_rules', 'business_id'),
      ('api_keys', 'business_id'),
      ('appointment_change_verifications', 'business_id'),
      ('appointments', 'business_id'),
      ('assistant_settings', 'business_id'),
      ('audit_logs', 'business_id'),
      ('billing_accounts', 'business_id'),
      ('billing_checkout_requests', 'business_id'),
      ('billing_transactions', 'business_id'),
      ('billing_usage_events', 'business_id'),
      ('billing_usage_months', 'business_id'),
      ('business_context_snapshots', 'business_id'),
      ('business_hours', 'business_id'),
      ('business_invitations', 'business_id'),
      ('business_memberships', 'business_id'),
      ('businesses', 'id'),
      ('calendar_busy_blocks', 'business_id'),
      ('calendar_connections', 'business_id'),
      ('calls', 'business_id'),
      ('closures', 'business_id'),
      ('compliance_records', 'business_id'),
      ('contacts', 'business_id'),
      ('conversation_sessions', 'business_id'),
      ('conversations', 'business_id'),
      ('inbox_items', 'business_id'),
      ('invoices', 'business_id'),
      ('knowledge_chunks', 'business_id'),
      ('knowledge_documents', 'business_id'),
      ('knowledge_snippets', 'business_id'),
      ('messages', 'business_id'),
      ('missed_calls', 'business_id'),
      ('notifications', 'business_id'),
      ('onboarding_number_claim_events', 'business_id'),
      ('onboarding_phone_verifications', 'business_id'),
      ('operator_notification_deliveries', 'business_id'),
      ('operator_notification_preferences', 'business_id'),
      ('outreach_automations', 'business_id'),
      ('outreach_sends', 'business_id'),
      ('phone_numbers', 'business_id'),
      ('prospect_demos', 'business_id'),
      ('quotes', 'business_id'),
      ('receptionist_profiles', 'business_id'),
      ('services', 'business_id'),
      ('sms_consent_events', 'business_id'),
      ('staff', 'business_id'),
      ('staff_service_assignments', 'business_id'),
      ('storage_objects', 'business_id'),
      ('transcripts', 'business_id'),
      ('unit_economics_events', 'business_id'),
      ('unit_economics_rollups', 'business_id'),
      ('webhook_deliveries', 'business_id'),
      ('webhook_delivery_attempts', 'business_id'),
      ('webhook_endpoints', 'business_id'),
      ('webhook_events', 'business_id'),
      ('website_ingestion_jobs', 'business_id'),
      ('widget_keys', 'business_id'),
      ('widget_visitors', 'business_id')
    ) AS owned(table_name, source_column)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = target.source_column
      WHERE n.nspname = 'public' AND c.relname = target.table_name
        AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity
        AND a.attnotnull AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype
    ) THEN
      RAISE EXCEPTION 'Expected protected, non-null UUID ownership key on %', target.table_name;
    END IF;
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN tenant_id uuid GENERATED ALWAYS AS (%I) STORED NOT NULL',
      target.table_name, target.source_column
    );
  END LOOP;
END
$$;
