-- ═══════════════════════════════════════════════════════════════════════════
-- HR MODULE — STAGE 2 (tiny migration): position archival + current-occupant
-- index, supporting the org-tree editor and occupancy link/unlink UI.
--
-- Run once in the Supabase SQL editor. Both statements are idempotent and
-- reversible (DROP COLUMN / DROP INDEX). No data is modified.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Soft-archive for positions. Active tree = archived_at IS NULL.
--    (Positions that have ever held an occupant can only be archived, never
--    hard-deleted — see Stage 2 removal rules. The column is the anchor.)
ALTER TABLE positions ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- 2. Partial index for "current occupants of a position" — the hot path the
--    tree editor hits for every node (Stage 1 created a full index on
--    position_id; this narrows it to live occupancies).
CREATE INDEX IF NOT EXISTS idx_person_positions_current
  ON person_positions (position_id)
  WHERE unlinked_at IS NULL;
