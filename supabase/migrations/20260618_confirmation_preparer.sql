-- ═══════════════════════════════════════════════════════════════════════════
-- Confirmation "preparer" field — a clergy-aware preparer for each candidate.
-- Stored as a plain display-name string (the shared preparer dropdown offers
-- institution clergy + the Confirmation coordinator + an "Other…" free entry;
-- the chosen name is persisted and rendered in the file's read view).
--
-- PROPOSED — pause for approval before applying. Additive + idempotent +
-- reversible. Run once in the Supabase SQL editor. (Mirrors the First Communion
-- and Marriage preparer columns.)
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS preparer text;
