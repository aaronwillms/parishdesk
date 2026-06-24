-- Phase 1a: stable FK for the parish's PRINCIPAL institution, replacing the legacy
-- name-match (institutions.name === parish_settings.primary_institution).
--
-- Single-tenant-safe: parish_settings stays a singleton; this migration does NOT add
-- tenant resolution, does NOT touch current_parish_id(), and does NOT make
-- parish_settings multi-row. That is Phase 1b.
--
-- primary_institution (the name string) is RETAINED as a live safety-net fallback;
-- it dies only after every read is confirmed repointed in production.
--
-- parish_settings already exists → no RLS/anon changes here (not a new table).

-- 1. Add the FK column (nullable — the app falls back to the name-match while NULL).
ALTER TABLE parish_settings
  ADD COLUMN IF NOT EXISTS principal_institution_id uuid REFERENCES institutions(id);

-- 2. One-time backfill using the existing name-match. NULL-only so re-running is
--    idempotent and never clobbers a value an app save has already written.
UPDATE parish_settings ps
SET    principal_institution_id = i.id
FROM   institutions i
WHERE  i.name = ps.primary_institution
  AND  ps.principal_institution_id IS NULL;
