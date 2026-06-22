-- ═══════════════════════════════════════════════════════════════════════════
-- Calendar: per-parish colour for the Application Work Calendar's dashboard events.
--
-- PROPOSED — pause for approval before applying. Additive + idempotent + nullable.
--
-- A colour column on the EXISTING parish_settings row (alongside work_calendar_id)
-- — NOT a new table — so it needs no RLS-disable step. Drives how work-calendar
-- events render on the dashboard. NULL → falls back to the previous default red.
--
-- (The Global Parish Calendar's colour reuses the existing calendars.color column
-- on its writer row — no migration needed for that one.)
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE parish_settings ADD COLUMN IF NOT EXISTS work_calendar_color text;
