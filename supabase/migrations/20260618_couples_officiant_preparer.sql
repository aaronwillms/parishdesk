-- ═══════════════════════════════════════════════════════════════════════════
-- Marriage officiant + preparer — clergy-aware fields stored as display-name
-- strings (the shared officiant/preparer dropdowns persist the chosen name and
-- render it in the file's read view).
--
--   officiant — from the shared officiant dropdown (institution clergy + Other).
--               Supersedes the legacy officiant_id (FK) / officiant_override
--               (free-text) pair, which the Marriage form no longer writes; the
--               new field is seeded from those on edit so saved values persist.
--   preparer  — from the shared preparer dropdown (institution clergy + the
--               Marriage coordinator + Other). New; couples had no preparer.
--
-- PROPOSED — pause for approval before applying. Additive + idempotent +
-- reversible. Run once in the Supabase SQL editor.
--
-- (officiant_id / officiant_override / delegation_given remain for now;
-- officiant_id + officiant_override become dead columns to drop in a later
-- cleanup task. delegation_given is still written by the form.)
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE couples ADD COLUMN IF NOT EXISTS officiant text;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS preparer  text;
