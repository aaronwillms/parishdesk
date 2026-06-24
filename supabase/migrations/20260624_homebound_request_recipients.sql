-- ═══════════════════════════════════════════════════════════════════════════
-- SICK & HOMEBOUND — 3d-supplement: multiple pastoral-request recipients (shared
-- queue) + resolved_by. Run ONCE in the SQL editor. Clean repoint of 3d's single
-- parish_settings.pastoral_request_recipient (no real data).
--
-- A relational join table (NOT an array/jsonb column) — consistent with how the app
-- models every other multi-value relationship (team_members, person_positions,
-- program_coordinators ids, homebound_assignments). Routing fans out over its rows;
-- the request itself stays a single shared care_requests row.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS homebound_request_recipients (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parish_id    uuid NOT NULL DEFAULT current_parish_id() REFERENCES parish_settings(id) ON DELETE CASCADE,
  personnel_id uuid NOT NULL REFERENCES personnel(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE homebound_request_recipients DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON homebound_request_recipients FROM anon;
CREATE INDEX IF NOT EXISTS idx_homebound_request_recipients_parish ON homebound_request_recipients (parish_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_homebound_request_recipients ON homebound_request_recipients (parish_id, personnel_id);

-- care_requests: who resolved it (3d only had resolved_at).
ALTER TABLE care_requests ADD COLUMN IF NOT EXISTS resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- Drop 3d's single-recipient column (replaced by the join table; clean repoint).
ALTER TABLE parish_settings DROP COLUMN IF EXISTS pastoral_request_recipient;

NOTIFY pgrst, 'reload schema';
