-- lobbystack:concurrent-index contacts_business_name_search_idx
CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_business_name_search_idx
  ON public.contacts (business_id, public.normalize_contact_name_search(name))
  WHERE name IS NOT NULL;
