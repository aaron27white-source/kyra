CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;

CREATE OR REPLACE FUNCTION public.normalize_contact_name_search(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  WITH normalized AS (
    SELECT trim(regexp_replace(lower(public.unaccent(input)), '[^[:alnum:]]+', ' ', 'g')) AS value
  )
  SELECT CASE
    WHEN value ~ '^[[:alnum:]]( [[:alnum:]])+$' THEN replace(value, ' ', '')
    ELSE value
  END
  FROM normalized
$$;

