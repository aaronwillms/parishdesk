-- "Wedding Complete" gate for the records-placement chain.
--
-- Adds a boolean that GATES the existing couples.records_placed column. The chain:
--   status = Complete → show "Wedding Complete" → (when checked) show
--   "Marriage File Placed in Parish Records" (records_placed).
--
-- Priority Actions banner now keys records-placement on wedding_complete = true AND
-- records_placed = false (was: status = Complete AND records_placed = false). The
-- archived/inactive carve-out is preserved but likewise gated on wedding_complete.
--
-- PAUSED: run this in the Supabase SQL editor. Until it is applied, the Marriage
-- edit-modal save (which writes the full couple row, including wedding_complete) will
-- be rejected — apply before relying on the editor, exactly as with records_placed.

ALTER TABLE couples ADD COLUMN IF NOT EXISTS wedding_complete boolean NOT NULL DEFAULT false;
