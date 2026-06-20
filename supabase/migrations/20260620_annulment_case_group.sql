-- ═══════════════════════════════════════════════════════════════════════════
-- Annulments — case-to-case linking via a shared case group.
--
-- Mirrors the existing `family_group_id` pattern (FC / Confirmation / OCIA): cases
-- that share a `case_group_id` are all mutually linked. Linking two cases creates or
-- joins a group; this makes linking transitive (A-B then B-C → A, B, C share one
-- group). Unlinking clears a case's `case_group_id`; a group that drops to one member
-- is retired (the lone case is cleared too).
--
-- One new nullable column; no data backfill. The shared family-link mechanism is
-- reused (group create/join/merge/unlink) with this column configured per-panel.
--
-- PROPOSED — pause for approval before applying. Additive, idempotent, reversible,
-- nullable (no data impact on existing rows). Run once in the Supabase SQL editor.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS case_group_id uuid;
