-- ── Disable RLS on projects + tasks ───────────────────────────────────────
-- Run once in the Supabase SQL editor.
-- Project/task UPDATEs were succeeding with no error but persisting nothing —
-- the classic signature of RLS matching 0 rows (a SELECT policy lets rows be
-- read, but no permissive UPDATE policy lets them be written). The rest of the
-- app's tables already run with RLS disabled; bring these in line.

ALTER TABLE projects DISABLE ROW LEVEL SECURITY;
ALTER TABLE tasks    DISABLE ROW LEVEL SECURITY;
