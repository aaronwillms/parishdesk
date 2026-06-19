-- ═══════════════════════════════════════════════════════════════════════════
-- Annulment "preparer" field — Person Responsible for Formation.
-- Stored as a plain display-name string (the shared preparer dropdown offers
-- parish clergy + the Annulments coordinator + an "Other…" free entry; the chosen
-- name is persisted and rendered in the case's read view). This brings the
-- Annulments panel onto the same consolidation standard as every other sacrament
-- panel (Baptism / First Communion / Confirmation / Marriage / OCIA all use a
-- single `preparer` text column).
--
-- ⚠️ BLOCKING for the Person-Responsible field: until this runs, an annulment
-- case Save writes `preparer` and the column is missing, so the write fails. The
-- read view falls back to the legacy preparation_responsible_id FK for old rows.
--
-- PROPOSED — pause for approval before applying. Additive + idempotent +
-- reversible. Run once in the Supabase SQL editor.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS preparer text;
