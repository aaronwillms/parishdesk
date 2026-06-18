-- ═══════════════════════════════════════════════════════════════════════════
-- Cleanup: drop the unused get_person_titles(uuid) function.
--
-- Stage 1 created both get_person_titles(uuid) AND the person_current_titles
-- view. The client only ever consumes the VIEW (personnel.js loads
-- person_current_titles); the function is dead code. The view is unaffected.
--
-- Run once in the Supabase SQL editor. Reversible — see the original definition
-- in 20260617_hr_module_stage1.sql if you ever need it back.
-- ═══════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS get_person_titles(uuid);
