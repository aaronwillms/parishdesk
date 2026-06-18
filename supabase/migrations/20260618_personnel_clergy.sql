-- ═══════════════════════════════════════════════════════════════════════════
-- Directory clergy field — a manual boolean on the directory person, set in the
-- Add/Edit Person dialog. Single source of truth for clergy-aware dropdowns
-- (consumed later by the sacramental panels via getInstitutionClergy()).
--
-- PROPOSED — pause for approval before applying (it alters an existing table).
-- Run once in the Supabase SQL editor. Additive + idempotent + reversible.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE personnel ADD COLUMN IF NOT EXISTS clergy boolean NOT NULL DEFAULT false;

-- Backfill: people already typed as clergy keep clergy status so the directory
-- doesn't silently demote them. (Run with the ALTER, in the same migration.)
UPDATE personnel SET clergy = true
 WHERE clergy = false
   AND type IN ('pastor', 'parochial-vicar', 'priest-in-residence', 'deacon', 'religious');
