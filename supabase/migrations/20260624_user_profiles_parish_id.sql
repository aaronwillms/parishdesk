-- Multi-tenancy Phase 1b — STEP 1 of 3: user->parish mapping column (backfilled, UNUSED).
--
-- Adds parish_id to user_profiles and backfills it once from the existing HR chain.
-- This is the 1a pattern: populate the seam, verify, ship alone. NOTHING reads this
-- column at runtime yet — current_parish_id(), main.js:24, roles.js, and every RLS
-- policy are deliberately untouched (those are Steps 2 and 3). Single-tenant behavior
-- is fully intact: the column is populated and inert.
--
-- parish_settings/user_profiles already exist -> no new-table RLS/anon changes.

-- 1. Add the mapping column (nullable FK, strict NO ACTION — matches the 1a convention).
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS parish_id uuid REFERENCES parish_settings(id);

-- 2. One-time backfill via the chain:
--      user_profiles.personnel_id
--        -> person_positions (current only: unlinked_at IS NULL)
--        -> positions.institution_id
--        -> institutions.parish_id
--    Only stamps users whose current positions resolve to EXACTLY ONE parish
--    (HAVING count(distinct)=1), so ambiguous multi-parish users are left NULL rather
--    than mis-stamped. IS NULL-guarded so re-running is idempotent and never clobbers
--    a value already set.
--
UPDATE user_profiles up
SET    parish_id = sub.parish_id
FROM (
  -- min(uuid) has no built-in aggregate, so reduce over the text cast (the HAVING
  -- guarantees a single distinct value anyway) and cast back to uuid.
  SELECT pp.person_id AS personnel_id, MIN(i.parish_id::text)::uuid AS parish_id
  FROM person_positions pp
  JOIN positions po   ON po.id = pp.position_id
  JOIN institutions i ON i.id = po.institution_id
  WHERE pp.unlinked_at IS NULL
    AND i.parish_id IS NOT NULL
  GROUP BY pp.person_id
  HAVING count(DISTINCT i.parish_id) = 1
) sub
WHERE up.personnel_id = sub.personnel_id
  AND up.parish_id IS NULL;

-- 3. Manual stamp: Gabriel McMillin is a real active Basilica volunteer whose personnel
--    record holds no current position, so the chain in step 2 cannot resolve him. Stamp
--    him to the Basilica parish explicitly. IS NULL-guarded like the rest (idempotent;
--    never clobbers). With this, all 6 user_profiles rows resolve.
UPDATE user_profiles
SET    parish_id = 'da288a33-32c1-4aa1-8cb7-76dd3edecbd9'   -- The Basilica of Saint Mary
WHERE  personnel_id = '7a2afa4b-6609-4d6e-8346-16f063af04d9' -- Gabriel McMillin
  AND  parish_id IS NULL;
