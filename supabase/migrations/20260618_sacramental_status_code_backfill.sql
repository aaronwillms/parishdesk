-- ═══════════════════════════════════════════════════════════════════════════
-- Fix: add the missing status_code column to baptism / first communion /
-- confirmation.
--
-- The *_rebuild migrations declare status_code, but on these three tables the
-- column never landed (the rest of each rebuild did) — confirmed live:
--   sacramental_baptism / _firstcomm / _confirmation  → status_code ABSENT
--   sacramental_ocia / couples / annulment_cases       → status_code present
-- That absence is why creating/editing/bulk-updating files on those three
-- boards fails with "column ... status_code does not exist" (the real
-- "Bug 2"). statusOf() falls back for READS, so the boards display fine — only
-- WRITES break.
--
-- Defaults mirror the originating rebuild migrations
-- (baptism → 'scheduled', firstcomm/confirmation → 'enrolled').
-- Idempotent (ADD COLUMN IF NOT EXISTS); safe to run more than once.
-- Run once in the Supabase SQL editor. Not run against any remote DB from here.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE sacramental_baptism      ADD COLUMN IF NOT EXISTS status_code text DEFAULT 'scheduled';
ALTER TABLE sacramental_firstcomm    ADD COLUMN IF NOT EXISTS status_code text DEFAULT 'enrolled';
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS status_code text DEFAULT 'enrolled';
