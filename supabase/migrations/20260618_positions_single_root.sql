-- ═══════════════════════════════════════════════════════════════════════════
-- Permanent single root per institution (Revision 2).
--
-- The schema currently ALLOWS multiple roots per institution (parent_position_id
-- is nullable with no constraint). This migration backfills a guaranteed single
-- root, then adds a partial unique index to enforce it going forward.
--
-- PROPOSED — pause for approval before applying (it MUTATES existing data + adds
-- a constraint). Runs against the freshly-cleaned test build. Review first.
--
-- Backfill approach (minimal disruption):
--   • Institution with NO active root  → insert a blank "Root Administrator".
--   • Institution with MULTIPLE active roots → keep the OLDEST as the root and
--     reparent the others under it (they become children; never orphaned).
--   • Institution with exactly one root → unchanged.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- 1. Insert a root where an institution has none.
INSERT INTO positions (institution_id, title, parent_position_id, is_administrator)
SELECT i.id, 'Root Administrator', NULL, true
FROM institutions i
WHERE NOT EXISTS (
  SELECT 1 FROM positions p
  WHERE p.institution_id = i.id AND p.parent_position_id IS NULL AND p.archived_at IS NULL
);

-- 2. Collapse multiple roots: keep the oldest, reparent the rest under it.
WITH ranked AS (
  SELECT id, institution_id,
         row_number() OVER (PARTITION BY institution_id ORDER BY created_at, id) AS rn,
         first_value(id) OVER (PARTITION BY institution_id ORDER BY created_at, id) AS keep_id
  FROM positions
  WHERE parent_position_id IS NULL AND archived_at IS NULL
)
UPDATE positions p
SET parent_position_id = r.keep_id, updated_at = now()
FROM ranked r
WHERE p.id = r.id AND r.rn > 1;

-- 3. Enforce exactly one active root per institution going forward.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_positions_root_per_institution
  ON positions (institution_id)
  WHERE parent_position_id IS NULL AND archived_at IS NULL;

-- Verify (should return ZERO rows — no institution with 0 or >1 active roots):
-- SELECT i.id, count(p.*) FROM institutions i
--   LEFT JOIN positions p ON p.institution_id=i.id AND p.parent_position_id IS NULL AND p.archived_at IS NULL
--   GROUP BY i.id HAVING count(p.*) <> 1;

COMMIT;
