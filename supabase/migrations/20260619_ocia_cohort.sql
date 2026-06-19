-- ═══════════════════════════════════════════════════════════════════════════
-- OCIA — cohort linkage (mirrors sacramental_confirmation).
-- The OCIA panel is moving onto the master-detail shell with two-level grouping:
-- cohort (top) → candidate_type (sub). Confirmation links records to a cohort row
-- via cohort_id (FK sacramental_cohorts, panel='ocia') plus a denormalized
-- cohort_date for sort. sacramental_ocia has neither column yet, so add them.
--
-- PROPOSED — pause for approval before applying. Additive, idempotent, nullable
-- (no data impact; sacramental_ocia is empty). Run once in the Supabase SQL editor.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE sacramental_ocia ADD COLUMN IF NOT EXISTS cohort_id uuid REFERENCES sacramental_cohorts(id) ON DELETE SET NULL;
ALTER TABLE sacramental_ocia ADD COLUMN IF NOT EXISTS cohort_date date;

-- Allow 'ocia' cohorts. The panel CHECK was ('firstcomm','confirmation') only;
-- widen it so sacramental_cohorts can hold OCIA reception-year classes. Idempotent.
ALTER TABLE sacramental_cohorts DROP CONSTRAINT IF EXISTS sacramental_cohorts_panel_check;
ALTER TABLE sacramental_cohorts ADD CONSTRAINT sacramental_cohorts_panel_check CHECK (panel IN ('firstcomm', 'confirmation', 'ocia'));
