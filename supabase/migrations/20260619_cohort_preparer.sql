-- ═══════════════════════════════════════════════════════════════════════════
-- Cohorts — "Person Responsible for Formation" on the cohort record (shared by
-- First Communion / Confirmation / OCIA). Stored as a plain display-name string in
-- `preparer` (same shape as the per-file preparer column the panels already use, via
-- the shared Clergy+Coordinator+Other dropdown). Assigning a cohort to a file
-- DEFAULTS the file's preparer to this value (editable per-person) — parallel to the
-- existing cohort→church inheritance. Editing a cohort changes the default for FUTURE
-- assignments only; it does NOT retroactively rewrite already-assigned files.
--
-- PROPOSED — pause for approval before applying. Additive, idempotent, nullable —
-- no data impact. Run once against the live DB.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE sacramental_cohorts ADD COLUMN IF NOT EXISTS preparer text;
