-- Preserve legacy records, but quarantine placeholders from public search.
UPDATE public.shows SET publishable=false, updated_at=now(),
 verification_reason='Exact performance time required before publication'
WHERE publishable AND (local_time IS NULL OR trim(local_time) = '' OR upper(trim(local_time)) IN ('TBA','TBD'));
ALTER TABLE public.shows ADD CONSTRAINT publishable_requires_exact_time
CHECK (NOT publishable OR (verification_status IN ('verified','verified_2_source') AND local_time IS NOT NULL AND
 local_time ~* '^(([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?|(0?[1-9]|1[0-2]):[0-5][0-9] ?[AP]M)$'));

-- Verification refresh is an administrative write, never a public RPC.
REVOKE EXECUTE ON FUNCTION public.refresh_show_verification(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_show_verification(uuid) TO service_role;
