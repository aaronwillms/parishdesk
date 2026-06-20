-- ═══════════════════════════════════════════════════════════════════════════
-- Baptism "preparer" field — a clergy-aware "Person Responsible for Formation"
-- for each baptism file, matching the other initiation panels (First Communion /
-- Confirmation / OCIA each already added their own `preparer text` column).
-- Baptism's rebuild never added it, so panels/baptism.js writes `preparer`
-- (buildPreparerField / readPreparerValue) into a column that doesn't exist →
-- "Could not find the 'preparer' column of 'sacramental_baptism' in the schema
-- cache" on save. This is a genuinely MISSING column (a SELECT returns
-- 42703 "column does not exist"), NOT a stale PostgREST cache.
--
-- PROPOSED — pause for approval before applying. Additive + idempotent + nullable.
-- Run once in the Supabase SQL editor.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS preparer text;
