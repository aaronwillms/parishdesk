-- Marriage notes save fails: "Could not find the 'notes_log' column of 'couples'
-- in the schema cache."
--
-- DIAGNOSIS: not a wrong reference. The structured notes feature stores an array of
-- { note, by, created_at } in a `notes_log` jsonb column, and EVERY other sacrament
-- table already has it (sacramental_baptism / _firstcomm / _confirmation / _ocia all
-- EXIST). The couples table simply never received the column, so addCoupleNoteLog()'s
-- write rejects. (A legacy plain-text `notes` column also exists and is still read as
-- a fallback by notesOf(); it is unaffected.)
--
-- PAUSED: run this in the Supabase SQL editor. Until applied, adding a note to a
-- marriage file fails with the error above; everything else is unaffected.

ALTER TABLE couples ADD COLUMN IF NOT EXISTS notes_log jsonb NOT NULL DEFAULT '[]'::jsonb;
