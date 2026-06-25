-- ════════════════════════════════════════════════════════════════════════════
-- Multi-tenancy Step 3b — PRE-CUTOVER GUARDS
-- Stage these BEFORE inserting a second parish (3c). Behaviorally INERT while one
-- parish exists (every user's parish_id resolves, so the hardened fallback is never
-- reached and nothing observable changes — except the cosmetic display_name label).
--
-- ROOT CAUSE these guards close: current_parish_id() previously COALESCEd an
-- unresolved user (no auth.uid(), no profile row, or NULL parish_id) to the
-- lowest-UUID parish. With one parish that is harmless (it IS Basilica); with two it
-- is a SILENT cross-parish resolution — and because current_parish_id() gates 6 HR
-- RLS policies (incident_disciplinary_links, institutions, person_positions,
-- positions, review_template_positions, review_templates), that becomes a cross-parish
-- HR read/write LEAK, in an unpredictable direction (the new parish's UUID may sort
-- below Basilica's). We close it fail-closed.
-- ════════════════════════════════════════════════════════════════════════════

-- (a) HARDEN current_parish_id(): drop the singleton fallback. An unresolved user now
--     resolves to NULL instead of an arbitrary parish. Downstream effect, all desired:
--       • 25 NOT NULL parish_id write-stamps  → INSERT fails LOUDLY (no silent mis-file)
--       • institutions.parish_id (nullable)   → stamps NULL → row invisible via RLS
--       • 6 HR RLS (parish_id = current_parish_id()) → NULL is never = anything → the
--         policy matches NOTHING → fail-CLOSED (no cross-parish leak)
--     LANGUAGE/STABLE/SECURITY DEFINER/search_path preserved exactly.
CREATE OR REPLACE FUNCTION public.current_parish_id()
  RETURNS uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
  SELECT parish_id FROM user_profiles WHERE user_id = auth.uid()
$function$;

-- (b) GUARANTEE non-null user_profiles.parish_id going forward.
--     0 NULLs today → SET NOT NULL validates immediately. New rows auto-stamp to the
--     INSERTING (authenticated) user's resolved parish via the DEFAULT; upsert-UPDATE
--     paths that omit parish_id leave the existing value untouched. A row inserted with
--     NO authenticated parish context gets NULL → violates NOT NULL → fails loudly
--     (intended fail-closed: a parishless user is NOT silently created as Basilica).
ALTER TABLE public.user_profiles ALTER COLUMN parish_id SET DEFAULT current_parish_id();
ALTER TABLE public.user_profiles ALTER COLUMN parish_id SET NOT NULL;

-- (c) display_name: short/badge label for the sidebar, login, and the future multi-parish
--     toggle. Nullable (single-name parishes need not fill it); read pattern is
--     COALESCE(display_name, parish_name). Backfill the Basilica's short name now;
--     Assumption's ('Assumption', full name 'Assumption of the Blessed Virgin Mary') is
--     set at its insert in 3c.
ALTER TABLE public.parish_settings ADD COLUMN display_name text;
UPDATE public.parish_settings
   SET display_name = 'Basilica'
 WHERE id = 'da288a33-32c1-4aa1-8cb7-76dd3edecbd9';
