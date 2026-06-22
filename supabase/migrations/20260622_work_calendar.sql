-- ═══════════════════════════════════════════════════════════════════════════
-- Calendar Phase 3: designated "Application Work Calendar" for Sacramental /
-- Project / Team events.
--
-- PROPOSED — pause for approval before applying. Additive + idempotent + nullable.
--
-- Stores WHICH calendar (on the global-writer's connected account) ParishDesk
-- posts panel-originated events to. A jsonb/text column on the EXISTING
-- parish_settings row — NOT a new table — so it needs no RLS-disable step. It is
-- just a calendarId (not a token), safe to be client-read.
--
-- The per-event ORIGIN (which panel created it, for visibility) is NOT stored in
-- the database — it travels with the Google event in extendedProperties.private
-- (pd_panel, pd_record_id), read back via the writer's token. No table needed.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE parish_settings ADD COLUMN IF NOT EXISTS work_calendar_id text;
