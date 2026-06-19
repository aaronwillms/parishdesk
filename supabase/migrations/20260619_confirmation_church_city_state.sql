-- ═══════════════════════════════════════════════════════════════════════════
-- Confirmation — church City/State for "Other" (non-listed) confirmation churches.
-- The Confirmation Details section gains City/State fields (shown only when the
-- church is "Other"), matching First Communion's communion_city / communion_state.
-- These store the manual city/state for a non-listed church (a listed church derives
-- its location from the institution). First Communion already had these columns;
-- Confirmation did not.
--
-- PROPOSED — pause for approval before applying. Additive, idempotent, nullable —
-- no data impact. Run once in the Supabase SQL editor.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS confirmation_city text;
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS confirmation_state text;
