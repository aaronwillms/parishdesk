-- ── Task dashboard redesign ───────────────────────────────────────────────
-- Run once in the Supabase SQL editor.
--
-- Adds Kanban status, a description field, and a chronological comments thread
-- to tasks. `completed`/`completed_at` remain the source of truth for existing
-- dashboard stats; the app keeps `status` and `completed` in sync.

-- 1. Kanban status: todo | in_progress | blocked | complete
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'todo';

-- 2. Longer free-text description (modal detail view)
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS description text;

-- 3. Chronological comments: [{ id, author_id, author_name, body, created_at }]
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS comments jsonb DEFAULT '[]'::jsonb;

-- 4. Backfill status from the legacy completed flag (idempotent)
UPDATE tasks SET status = 'complete'
  WHERE completed = true AND (status IS NULL OR status = 'todo');
UPDATE tasks SET status = 'todo'
  WHERE status IS NULL;
