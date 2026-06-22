-- ═══════════════════════════════════════════════════════════════════════════
-- Calendar Phase 2: per-user multi-calendar READ selection.
--
-- PROPOSED — pause for approval before applying. Additive + idempotent + nullable.
--
-- Stores the SET of Google calendars a user chose to DISPLAY on the dashboard, on
-- their existing personal calendars row. The single WRITE target reuses the existing
-- `url` column (the chosen calendarId; defaults to 'primary'). This is a jsonb column
-- on an EXISTING table — NOT a new table — so it needs no RLS-disable step.
--
-- Backward compatible: NULL/empty selected_calendars → read 'primary' (and url stays
-- 'primary'), exactly as today. Existing connections are unaffected until the user
-- opens the calendar picker and saves a selection.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE calendars ADD COLUMN IF NOT EXISTS selected_calendars jsonb;
