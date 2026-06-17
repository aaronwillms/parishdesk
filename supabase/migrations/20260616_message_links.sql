-- ── Case/file links in messages ───────────────────────────────────────────
-- Run once in the Supabase SQL editor.
--
-- Stores linked sacramental records / projects attached to a message via the
-- "#" mention picker. Shape:
--   { "links": [ { "type": "marriage", "id": "<uuid>", "label": "Jane & John" } ] }

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT NULL;

ALTER TABLE discussion_messages
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT NULL;
