-- ═══════════════════════════════════════════════════════════════════════════
-- First Communion "preparer" field — a clergy-aware preparer for each file.
-- Stored as a plain display-name string (the dropdown offers institution clergy +
-- the First Communion coordinator + an "Other…" free entry; the chosen name is
-- persisted and rendered in the file's read view).
--
-- PROPOSED — pause for approval before applying. Additive + idempotent + reversible.
-- Run once in the Supabase SQL editor.
--
-- (Confirmation will reuse the same shared preparer dropdown and add its own
-- analogous column under a separate, later migration.)
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS preparer text;
