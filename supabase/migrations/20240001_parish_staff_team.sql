-- ── Parish Staff protected team migration ─────────────────────────────────
-- Run once in the Supabase SQL editor.

-- 1. Add is_protected column to teams
ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS is_protected boolean NOT NULL DEFAULT false;

-- 2. Ensure (team_id, personnel_id) is unique in team_members to support ON CONFLICT
ALTER TABLE team_members
  DROP CONSTRAINT IF EXISTS team_members_team_id_personnel_id_key;
ALTER TABLE team_members
  ADD CONSTRAINT team_members_team_id_personnel_id_key
  UNIQUE (team_id, personnel_id);

-- 3. Insert Parish Staff team (idempotent)
INSERT INTO teams (name, description, is_protected)
VALUES ('Parish Staff', 'Full-time and part-time parish employees', true)
ON CONFLICT DO NOTHING;

-- 4. Insert team_members for all full-time and part-time personnel
--    Links to the Parish Staff team by name + is_protected guard.
--    ON CONFLICT DO NOTHING skips personnel already in the team.
INSERT INTO team_members (team_id, personnel_id)
SELECT
  t.id,
  p.id
FROM personnel p
CROSS JOIN (
  SELECT id FROM teams WHERE name = 'Parish Staff' AND is_protected = true LIMIT 1
) t
WHERE p.employment_type IN ('full-time', 'part-time')
ON CONFLICT (team_id, personnel_id) DO NOTHING;
