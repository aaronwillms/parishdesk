-- ═══════════════════════════════════════════════════════════════════════════
-- Annulments — restructure the marriage-location fields.
--   • Split the combined marriage_state_country into discrete marriage_state +
--     marriage_country columns.
--   • Add marriage_county.
--   • Add non_church_wedding (the annulment table never had it — the form gains a
--     "Non-Church Wedding" toggle that hides the parish/church field).
-- marriage_state_country is left in place but goes dead (no longer written); a probe
-- on 2026-06-19 confirmed ALL 13 rows have it empty, so there is NO data to migrate.
--
-- PROPOSED — pause for approval before applying. Additive, idempotent, reversible,
-- nullable / default false (no data impact). Run once in the Supabase SQL editor.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE annulment_cases
  ADD COLUMN IF NOT EXISTS marriage_state     text,
  ADD COLUMN IF NOT EXISTS marriage_country   text,
  ADD COLUMN IF NOT EXISTS marriage_county    text,
  ADD COLUMN IF NOT EXISTS non_church_wedding boolean DEFAULT false;
