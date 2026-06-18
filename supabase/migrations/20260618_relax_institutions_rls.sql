-- ═══════════════════════════════════════════════════════════════════════════
-- RECONCILE: relax RLS on the shared `institutions` table to match the app.
--
-- Stage 1 enabled RLS on institutions (parish-scoped SELECT, admin writes), but
-- institutions is a SHARED table read by every sacramental board, the directory,
-- and the contact pickers — and the rest of the app runs with RLS DISABLED.
-- To remove a class of subtle shared-table risk and match the app's uniform
-- model, we drop the institutions policies and disable RLS on it.
--
-- The genuinely sensitive HR tables KEEP their RLS:
--   positions, person_positions, performance_reviews, disciplinary_records,
--   incident_reports, memos, review_templates, review_template_positions,
--   incident_disciplinary_links, record_grants — all unchanged.
--
-- Run once in the Supabase SQL editor. Reversible (re-create the two policies +
-- ENABLE ROW LEVEL SECURITY) — see Stage 1 for the original definitions.
-- Output for review; not run against any remote DB from here.
-- ═══════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS institutions_select      ON institutions;
DROP POLICY IF EXISTS institutions_admin_write ON institutions;
ALTER TABLE institutions DISABLE ROW LEVEL SECURITY;
