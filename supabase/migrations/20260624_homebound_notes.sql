-- ═══════════════════════════════════════════════════════════════════════════
-- SICK & HOMEBOUND — per-recipient NOTES (accompaniment notes on the file viewer),
-- mirroring discernment_notes. Run ONCE in the SQL editor. Additive · idempotent.
-- Client-gated like the other homebound tables (NOT RLS).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS homebound_notes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id uuid NOT NULL REFERENCES homebound_recipients(id) ON DELETE CASCADE,
  parish_id    uuid NOT NULL DEFAULT current_parish_id() REFERENCES parish_settings(id) ON DELETE CASCADE,
  author_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  note_date    date,
  subject      text,
  body         text,
  edited_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE homebound_notes DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON homebound_notes FROM anon;
CREATE INDEX IF NOT EXISTS idx_homebound_notes_recipient ON homebound_notes (recipient_id);

NOTIFY pgrst, 'reload schema';
