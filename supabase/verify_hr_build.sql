-- ═══════════════════════════════════════════════════════════════════════════
-- HR MODULE — BUILD VERIFICATION (read-only)
-- Paste into the Supabase SQL editor and run. Every row should read ✅ PASS.
-- Any ❌ FAIL = that migration (or the title drop) has not been applied.
-- Covers: Stage 1 (20260617_hr_module_stage1), Stage 2 (20260618_hr_stage2),
-- Stage 4 (20260618_hr_stage4_autoclear). Stage 3 added no SQL.
-- ═══════════════════════════════════════════════════════════════════════════
WITH checks(ord, item, ok) AS (VALUES

  -- ── Stage 1 · helper functions ──────────────────────────────────────────
  (101, 'S1 fn  current_parish_id()',                to_regprocedure('public.current_parish_id()')                    IS NOT NULL),
  (102, 'S1 fn  is_super_admin(uuid)',               to_regprocedure('public.is_super_admin(uuid)')                   IS NOT NULL),
  (103, 'S1 fn  is_admin(uuid)',                     to_regprocedure('public.is_admin(uuid)')                         IS NOT NULL),
  (104, 'S1 fn  has_record_grant(text,uuid,uuid)',   to_regprocedure('public.has_record_grant(text,uuid,uuid)')       IS NOT NULL),
  (105, 'S1 fn  get_person_titles(uuid)',            to_regprocedure('public.get_person_titles(uuid)')                IS NOT NULL),
  (106, 'S1 view person_current_titles',             to_regclass('public.person_current_titles')                      IS NOT NULL),

  -- ── Stage 1 · tables ────────────────────────────────────────────────────
  (110, 'S1 tbl positions',                          to_regclass('public.positions')                    IS NOT NULL),
  (111, 'S1 tbl person_positions',                   to_regclass('public.person_positions')             IS NOT NULL),
  (112, 'S1 tbl performance_reviews',                to_regclass('public.performance_reviews')          IS NOT NULL),
  (113, 'S1 tbl disciplinary_records',               to_regclass('public.disciplinary_records')         IS NOT NULL),
  (114, 'S1 tbl incident_reports',                   to_regclass('public.incident_reports')             IS NOT NULL),
  (115, 'S1 tbl memos',                              to_regclass('public.memos')                        IS NOT NULL),
  (116, 'S1 tbl incident_disciplinary_links',        to_regclass('public.incident_disciplinary_links')  IS NOT NULL),
  (117, 'S1 tbl record_grants',                      to_regclass('public.record_grants')                IS NOT NULL),
  (118, 'S1 tbl review_templates',                   to_regclass('public.review_templates')             IS NOT NULL),
  (119, 'S1 tbl review_template_positions',          to_regclass('public.review_template_positions')    IS NOT NULL),

  -- ── Stage 1 · key columns / constraints ─────────────────────────────────
  (120, 'S1 col institutions.parish_id',
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='institutions' AND column_name='parish_id')),
  (121, 'S1 chk record_grants bounded type list (youth_member present)',
        EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = to_regclass('public.record_grants') AND contype='c'
                  AND pg_get_constraintdef(oid) LIKE '%youth_member%')),
  (122, 'S1 col person_positions.employment_type CHECK',
        EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = to_regclass('public.person_positions') AND contype='c'
                  AND pg_get_constraintdef(oid) LIKE '%full_time%')),

  -- ── Stage 1 · parish_settings additions ─────────────────────────────────
  (130, 'S1 col parish_settings.hr_severity_ladder',
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='parish_settings' AND column_name='hr_severity_ladder')),
  (131, 'S1 col parish_settings.hr_banner_text',
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='parish_settings' AND column_name='hr_banner_text')),
  (132, 'S1 col parish_settings.hr_grant_autoclear',
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='parish_settings' AND column_name='hr_grant_autoclear')),
  (133, 'S1 seed parish_settings HR values populated',
        EXISTS (SELECT 1 FROM parish_settings
                WHERE hr_banner_text IS NOT NULL AND hr_severity_ladder IS NOT NULL AND hr_grant_autoclear IS NOT NULL)),

  -- ── Stage 1 · RLS enabled on HR tables ──────────────────────────────────
  (140, 'S1 RLS positions',            COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.positions')), false)),
  (141, 'S1 RLS person_positions',     COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.person_positions')), false)),
  (142, 'S1 RLS record_grants',        COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.record_grants')), false)),
  (143, 'S1 RLS performance_reviews',  COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.performance_reviews')), false)),
  (144, 'S1 RLS disciplinary_records', COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.disciplinary_records')), false)),
  (145, 'S1 RLS incident_reports',     COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.incident_reports')), false)),
  (146, 'S1 RLS memos',                COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.memos')), false)),
  (147, 'S1 policies on memos exist',  EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='memos')),
  (148, 'S1 policies on record_grants exist', EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='record_grants')),

  -- ── Stage 1 · title collapse (column MUST be gone) ──────────────────────
  (150, 'S1 personnel.title DROPPED (must be absent)',
        NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='personnel' AND column_name='title')),

  -- ── Stage 2 · archival + current-occupant index ─────────────────────────
  (200, 'S2 col positions.archived_at',
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='positions' AND column_name='archived_at')),
  (201, 'S2 idx idx_person_positions_current (partial)',
        to_regclass('public.idx_person_positions_current') IS NOT NULL),

  -- ── Stage 4 · auto-clear enforcement ────────────────────────────────────
  (400, 'S4 fn  clear_grants_for_person(uuid)',  to_regprocedure('public.clear_grants_for_person(uuid)') IS NOT NULL),
  (401, 'S4 fn  hr_autoclear_on_unlink()',       to_regprocedure('public.hr_autoclear_on_unlink()')      IS NOT NULL),
  (402, 'S4 trigger trg_hr_autoclear_on_unlink on person_positions',
        EXISTS (SELECT 1 FROM pg_trigger
                WHERE tgname='trg_hr_autoclear_on_unlink' AND tgrelid = to_regclass('public.person_positions')))
)
SELECT item AS check,
       CASE WHEN ok THEN '✅ PASS' ELSE '❌ FAIL' END AS status
FROM checks
ORDER BY ord;
