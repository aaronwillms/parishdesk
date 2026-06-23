-- ═══════════════════════════════════════════════════════════════════════════
-- HR REDESIGN — PHASE 2: scope personnel records to (PERSON, INSTITUTION).
--
-- The four HR record tables currently key ONLY to person_position_id (one
-- specific occupancy row). Per the locked spec a personnel FILE is per
-- (person, institution): every record a person has at an institution — across
-- however many positions they hold there — lives in ONE file, and a different
-- institution is a SEPARATE file. So records attach directly to
-- (person_id, institution_id), independent of any single occupancy.
--
-- ADDITIVE · IDEMPOTENT · REVERSIBLE. Columns on EXISTING tables only — no new
-- tables, so there is NO row-level-security step here. (RLS was enabled on these
-- four tables in stage 1; its policies key off author_id, which is unchanged, so
-- the additive columns do not affect access.) Run once in the Supabase SQL editor.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Add the (person, institution) anchor to each record table.
ALTER TABLE performance_reviews  ADD COLUMN IF NOT EXISTS person_id      uuid REFERENCES personnel(id)    ON DELETE CASCADE;
ALTER TABLE performance_reviews  ADD COLUMN IF NOT EXISTS institution_id uuid REFERENCES institutions(id) ON DELETE CASCADE;
ALTER TABLE disciplinary_records ADD COLUMN IF NOT EXISTS person_id      uuid REFERENCES personnel(id)    ON DELETE CASCADE;
ALTER TABLE disciplinary_records ADD COLUMN IF NOT EXISTS institution_id uuid REFERENCES institutions(id) ON DELETE CASCADE;
ALTER TABLE incident_reports     ADD COLUMN IF NOT EXISTS person_id      uuid REFERENCES personnel(id)    ON DELETE CASCADE;
ALTER TABLE incident_reports     ADD COLUMN IF NOT EXISTS institution_id uuid REFERENCES institutions(id) ON DELETE CASCADE;
ALTER TABLE memos                ADD COLUMN IF NOT EXISTS person_id      uuid REFERENCES personnel(id)    ON DELETE CASCADE;
ALTER TABLE memos                ADD COLUMN IF NOT EXISTS institution_id uuid REFERENCES institutions(id) ON DELETE CASCADE;

-- 2. Backfill from the existing occupancy linkage (person_position → position).
UPDATE performance_reviews r
  SET person_id = pp.person_id, institution_id = pos.institution_id
  FROM person_positions pp JOIN positions pos ON pos.id = pp.position_id
  WHERE r.person_position_id = pp.id AND (r.person_id IS NULL OR r.institution_id IS NULL);
UPDATE disciplinary_records r
  SET person_id = pp.person_id, institution_id = pos.institution_id
  FROM person_positions pp JOIN positions pos ON pos.id = pp.position_id
  WHERE r.person_position_id = pp.id AND (r.person_id IS NULL OR r.institution_id IS NULL);
UPDATE incident_reports r
  SET person_id = pp.person_id, institution_id = pos.institution_id
  FROM person_positions pp JOIN positions pos ON pos.id = pp.position_id
  WHERE r.person_position_id = pp.id AND (r.person_id IS NULL OR r.institution_id IS NULL);
UPDATE memos r
  SET person_id = pp.person_id, institution_id = pos.institution_id
  FROM person_positions pp JOIN positions pos ON pos.id = pp.position_id
  WHERE r.person_position_id = pp.id AND (r.person_id IS NULL OR r.institution_id IS NULL);

-- 3. New records key to (person, institution); the occupancy link is now OPTIONAL
--    (retained for provenance / back-compat, but no longer the access grain).
ALTER TABLE performance_reviews  ALTER COLUMN person_position_id DROP NOT NULL;
ALTER TABLE disciplinary_records ALTER COLUMN person_position_id DROP NOT NULL;
ALTER TABLE incident_reports     ALTER COLUMN person_position_id DROP NOT NULL;
ALTER TABLE memos                ALTER COLUMN person_position_id DROP NOT NULL;

-- 4. Fast per-file lookup (person + institution).
CREATE INDEX IF NOT EXISTS idx_perf_reviews_person_inst ON performance_reviews  (person_id, institution_id);
CREATE INDEX IF NOT EXISTS idx_disciplinary_person_inst ON disciplinary_records (person_id, institution_id);
CREATE INDEX IF NOT EXISTS idx_incidents_person_inst    ON incident_reports     (person_id, institution_id);
CREATE INDEX IF NOT EXISTS idx_memos_person_inst        ON memos                (person_id, institution_id);
