-- ═══════════════════════════════════════════════════════════════════════════
-- OCIA — "Person Responsible for Formation" field (the consolidation standard,
-- same as Baptism / First Communion / Confirmation / Marriage). Stored as a plain
-- display-name string in `preparer`; the shared dropdown offers parish clergy + the
-- OCIA coordinator(s) + "Other…". The viewer labels it "OCIA Prep".
--
-- ⚠️ BLOCKING for OCIA saves once the field is wired: the Add/Edit payload writes
-- `preparer`, and the column is missing, so an OCIA file save fails until this runs.
--
-- PROPOSED — pause for approval before applying. Additive, idempotent, nullable —
-- no data impact. Run once in the Supabase SQL editor.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE sacramental_ocia ADD COLUMN IF NOT EXISTS preparer text;
