-- ═══════════════════════════════════════════════════════════════════════════
-- HR PHASE 4C — make incident_reports + disciplinary_records TEMPLATE-DRIVEN,
-- matching performance_reviews (frozen_definition + answers via the cf engine).
--
-- STEP 0 reader map (verified): every read of the fixed columns below lives inside
-- hr.js's own create/edit/view forms. The severity ladder reads
-- parish_settings.hr_severity_ladder (NOT disciplinary_records.severity); the
-- %-grant system references these tables by record id, not by column. NO external
-- readers → all fixed columns collapse into `answers`. (The new Disciplinary
-- template uses action_type, not severity, so severity is dropped, not retained.)
--
-- Tables hold only disposable test data → cleared (no backfill / no frozen_definition
-- synthesis). Additive columns + drops; reload the PostgREST schema cache at the end.
-- Run once in the SQL editor.
-- ═══════════════════════════════════════════════════════════════════════════

-- Clear disposable test rows first (drop-and-rebuild authorized).
DELETE FROM incident_reports;
DELETE FROM disciplinary_records;

-- Template-driven storage (mirrors performance_reviews).
ALTER TABLE incident_reports     ADD COLUMN IF NOT EXISTS frozen_definition jsonb DEFAULT '[]'::jsonb;
ALTER TABLE incident_reports     ADD COLUMN IF NOT EXISTS answers           jsonb DEFAULT '{}'::jsonb;
ALTER TABLE disciplinary_records ADD COLUMN IF NOT EXISTS frozen_definition jsonb DEFAULT '[]'::jsonb;
ALTER TABLE disciplinary_records ADD COLUMN IF NOT EXISTS answers           jsonb DEFAULT '{}'::jsonb;

-- Drop the now-unused fixed columns (no external reader per STEP 0).
ALTER TABLE incident_reports     DROP COLUMN IF EXISTS description;
ALTER TABLE disciplinary_records DROP COLUMN IF EXISTS narrative;
ALTER TABLE disciplinary_records DROP COLUMN IF EXISTS severity;
ALTER TABLE disciplinary_records DROP COLUMN IF EXISTS corrective_action;
ALTER TABLE disciplinary_records DROP COLUMN IF EXISTS signed_on_file;
ALTER TABLE disciplinary_records DROP COLUMN IF EXISTS signed_date;

-- Retained on both (common with performance_reviews): id, person_id, institution_id,
-- author_id, person_position_id, parish_id, record_date, created_at, updated_at,
-- archived_at. The uneditable creation date (created_at) still feeds the universal header.

NOTIFY pgrst, 'reload schema';
