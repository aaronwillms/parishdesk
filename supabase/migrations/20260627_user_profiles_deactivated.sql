-- ═══════════════════════════════════════════════════════════════════════════
-- User lifecycle — the `deactivated` in-session ejection marker.
--
-- PROPOSED — pause for approval before applying. Additive + idempotent + NOT NULL
-- with a safe default (existing rows backfill to false).
--
-- Deactivation is enforced at TWO layers (belt-and-suspenders):
--   1. GoTrue ban (ban_duration "876000h") — blocks NEW logins at the auth layer.
--   2. This flag — blocks an ALREADY-OPEN session: startApp checks
--      store.currentUserProfile.deactivated right after loadUserProfile and signs
--      the user out immediately (the ban alone would only drop them on the next
--      token refresh, up to ~1h later).
--
-- Kept in sync with the GoTrue ban by functions/admin-user-lifecycle.js:
--   deactivate → ban + deactivated=true ;  reactivate → un-ban + deactivated=false.
--
-- Plain boolean column on an existing table — no RLS step (user_profiles RLS is
-- unchanged; access stays client-gated per the standing rule).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS deactivated boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN user_profiles.deactivated IS
  'In-session ejection marker for the user-lifecycle feature. true = account deactivated (kept in sync with the GoTrue ban). startApp signs out a session whose profile has this set. Cleared on reactivate.';
