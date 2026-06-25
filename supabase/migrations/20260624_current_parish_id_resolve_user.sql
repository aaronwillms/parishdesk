-- Multi-tenancy Phase 1b — STEP 2 (Part A): rewrite current_parish_id() to resolve the
-- CURRENT USER's parish (user_profiles.parish_id), with the legacy singleton as fallback.
--
-- Single-tenant-safe: while parish_settings has one row and every user_profiles.parish_id
-- points at it, the per-user lookup and the fallback both return the same id, so all 12
-- RLS policies (6 HR-core tables x {select, admin_write}), the 26 parish_id write-stamp
-- defaults, and the no-auth/service-role path behave BYTE-IDENTICALLY. Verified
-- empirically in the Step 2 recon (all 6 users simulated -> da288a33 under both forms).
--
-- PRESERVED EXACTLY (recon flagged these as load-bearing):
--   • LANGUAGE sql, STABLE, SECURITY DEFINER, RETURNS uuid       — unchanged
--   • SET search_path TO 'public'                                — unchanged
--     auth.uid() is schema-qualified, so 'public' alone is sufficient; do NOT add 'auth'.
--
-- No RLS recursion introduced: user_profiles has RLS disabled, and this function is
-- SECURITY DEFINER anyway; the policies that CALL current_parish_id() live on OTHER
-- tables (institutions, positions, person_positions, review_templates,
-- review_template_positions, incident_disciplinary_links), never on user_profiles.

CREATE OR REPLACE FUNCTION public.current_parish_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT parish_id FROM user_profiles WHERE user_id = auth.uid()),
    (SELECT id FROM parish_settings ORDER BY id LIMIT 1)   -- legacy singleton fallback
  )
$function$;
