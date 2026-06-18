-- "Marriage File Placed in Parish Records" toggle (FIX 4).
--
-- Adds a boolean to back the non-removable, viewer-editable checkbox that appears
-- on Complete marriage files. It feeds the Priority Actions banner: a Complete file
-- with records_placed = false surfaces "Marriage file not yet placed in parish
-- records" — the SOLE banner item that also applies to archived/inactive files.
--
-- The other new toggle (Delegation given) reuses the EXISTING couples.delegation_given
-- column — no schema change needed for it.
--
-- PAUSED: run this in the Supabase SQL editor. Until it is applied, the toggle reads
-- as unchecked (so Complete files show the records-placement reminder) and checking
-- it cannot persist — the app is otherwise unaffected.

ALTER TABLE couples ADD COLUMN IF NOT EXISTS records_placed boolean NOT NULL DEFAULT false;
