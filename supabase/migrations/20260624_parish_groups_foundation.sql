-- Multi-tenancy Step-3 sequence, STEP 1: GROUP foundation (behaviorally inert).
--
-- Creates the GROUP entity (one pastor's parishes = the isolation boundary), attaches
-- the existing single parish to a single group, and adds current_group_id() alongside
-- the existing current_parish_id(). One group, one parish → the app behaves identically
-- to today. NOTHING else changes: no parish_id added to coordinator/grant/prep tables,
-- no 2nd parish, no UI change, and current_parish_id() is NOT modified.
--
-- STANDING RULES (new table): RLS DISABLED + anon access REVOKED.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. GROUP entity
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS parish_groups (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- New-table standing rule: client-gated app → RLS off + no anon access.
ALTER TABLE parish_groups DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON parish_groups FROM anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. parish_settings.group_id (nullable FK; NO ACTION — matches the 1a/1b convention).
--    Stays nullable in this step; any NOT NULL tightening comes later once the
--    backfill is trusted.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE parish_settings
  ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES parish_groups(id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Seed exactly ONE group (idempotent: only when none exists yet). This is the
--    tenant that will later contain both parishes (placeholder name).
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO parish_groups (name)
SELECT 'Basilica of Saint Mary & Assumption'
WHERE NOT EXISTS (SELECT 1 FROM parish_groups);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Backfill: attach the single Basilica parish to the seeded group. NULL-guarded
--    so re-running is idempotent and never clobbers an existing group_id.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE parish_settings ps
SET    group_id = (SELECT id FROM parish_groups ORDER BY created_at, id LIMIT 1)
WHERE  ps.group_id IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. RESOLVER: current_group_id() — mirrors current_parish_id() EXACTLY
--    (LANGUAGE sql, STABLE, SECURITY DEFINER, search_path=public, schema-qualified
--    auth.uid() reached transitively via current_parish_id()). Resolves the group of
--    the current user's resolved parish (same path current_parish_id() uses), with a
--    singleton-group fallback mirroring current_parish_id()'s singleton fallback.
--    current_parish_id() itself is NOT modified — only called.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.current_group_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT ps.group_id FROM parish_settings ps WHERE ps.id = current_parish_id()),
    (SELECT id FROM parish_groups ORDER BY id LIMIT 1)   -- legacy singleton-group fallback
  )
$function$;
