-- Multi-tenancy Step 2a: DATA SPINE for parish-scoped sacramental access.
--
-- Adds nullable parish_id to the grant/coordinator tables and the five prep tables,
-- swaps the three plain UNIQUE constraints for partial-index PAIRS, key-aware backfills,
-- and (in app code) parish-filters the five prep fetches. NO access-logic change in this
-- sub-step: canAccessSacrament, the role load-flatten, isSacramentCoordinator, the
-- notification routing, and the context-access helper are all UNTOUCHED (that is 2b).
-- Behaviorally inert single-parish: every row ends up NULL or Basilica.
--
-- CRITICAL: parish_id defaults to NULL on ALL of these. Do NOT default to
-- current_parish_id() (unlike the 26 HR columns) — cura/group-shared rows must never be
-- auto-stamped to a parish.
--
-- PREP keys  (parish-scoped → backfilled to Basilica):
--   'baptism','firstcomm','first_communion','confirmation','ocia','marriage'
-- CURA keys  (group-shared → deliberately LEFT NULL):
--   'homebound','annulments','discernment'
--
-- Basilica parish id: da288a33-32c1-4aa1-8cb7-76dd3edecbd9

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. ADD COLUMNS (nullable, default NULL, FK → parish_settings.id, NO ACTION)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE program_coordinators    ADD COLUMN IF NOT EXISTS parish_id uuid REFERENCES parish_settings(id);
ALTER TABLE sacramental_roles        ADD COLUMN IF NOT EXISTS parish_id uuid REFERENCES parish_settings(id);
ALTER TABLE panel_grants             ADD COLUMN IF NOT EXISTS parish_id uuid REFERENCES parish_settings(id);
ALTER TABLE sacramental_baptism      ADD COLUMN IF NOT EXISTS parish_id uuid REFERENCES parish_settings(id);
ALTER TABLE sacramental_firstcomm    ADD COLUMN IF NOT EXISTS parish_id uuid REFERENCES parish_settings(id);
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS parish_id uuid REFERENCES parish_settings(id);
ALTER TABLE sacramental_ocia         ADD COLUMN IF NOT EXISTS parish_id uuid REFERENCES parish_settings(id);
ALTER TABLE couples                  ADD COLUMN IF NOT EXISTS parish_id uuid REFERENCES parish_settings(id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. KEY-AWARE BACKFILL (NULL-guarded → idempotent).
--    Grant/coordinator tables: stamp Basilica ONLY for the PREP keys; CURA keys
--    (homebound, annulments, discernment) are excluded by omission → stay NULL.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE program_coordinators SET parish_id = 'da288a33-32c1-4aa1-8cb7-76dd3edecbd9'
WHERE parish_id IS NULL
  AND program  IN ('baptism','firstcomm','first_communion','confirmation','ocia','marriage');

UPDATE sacramental_roles SET parish_id = 'da288a33-32c1-4aa1-8cb7-76dd3edecbd9'
WHERE parish_id IS NULL
  AND sacrament IN ('baptism','firstcomm','first_communion','confirmation','ocia','marriage');

UPDATE panel_grants SET parish_id = 'da288a33-32c1-4aa1-8cb7-76dd3edecbd9'
WHERE parish_id IS NULL
  AND panel    IN ('baptism','firstcomm','first_communion','confirmation','ocia','marriage');

--    Prep DATA tables: every existing row is prep at the Basilica → stamp all.
UPDATE sacramental_baptism      SET parish_id = 'da288a33-32c1-4aa1-8cb7-76dd3edecbd9' WHERE parish_id IS NULL;
UPDATE sacramental_firstcomm    SET parish_id = 'da288a33-32c1-4aa1-8cb7-76dd3edecbd9' WHERE parish_id IS NULL;
UPDATE sacramental_confirmation SET parish_id = 'da288a33-32c1-4aa1-8cb7-76dd3edecbd9' WHERE parish_id IS NULL;
UPDATE sacramental_ocia         SET parish_id = 'da288a33-32c1-4aa1-8cb7-76dd3edecbd9' WHERE parish_id IS NULL;
UPDATE couples                  SET parish_id = 'da288a33-32c1-4aa1-8cb7-76dd3edecbd9' WHERE parish_id IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. SWAP plain UNIQUE constraints → partial-index PAIRS.
--    A plain UNIQUE(key, parish_id) is WRONG: NULLs are distinct, so it would permit
--    multiple NULL-parish rows for the same key. The pair enforces one group-shared row
--    (WHERE parish_id IS NULL) AND one row per (key, parish_id) (WHERE parish_id IS NOT NULL).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE program_coordinators DROP CONSTRAINT IF EXISTS program_coordinators_program_key;
CREATE UNIQUE INDEX IF NOT EXISTS program_coordinators_program_null_parish_uq
  ON program_coordinators (program) WHERE parish_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS program_coordinators_program_parish_uq
  ON program_coordinators (program, parish_id) WHERE parish_id IS NOT NULL;

ALTER TABLE sacramental_roles DROP CONSTRAINT IF EXISTS sacramental_roles_user_id_sacrament_key;
CREATE UNIQUE INDEX IF NOT EXISTS sacramental_roles_user_sacrament_null_parish_uq
  ON sacramental_roles (user_id, sacrament) WHERE parish_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sacramental_roles_user_sacrament_parish_uq
  ON sacramental_roles (user_id, sacrament, parish_id) WHERE parish_id IS NOT NULL;

ALTER TABLE panel_grants DROP CONSTRAINT IF EXISTS panel_grants_user_id_panel_key;
CREATE UNIQUE INDEX IF NOT EXISTS panel_grants_user_panel_null_parish_uq
  ON panel_grants (user_id, panel) WHERE parish_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS panel_grants_user_panel_parish_uq
  ON panel_grants (user_id, panel, parish_id) WHERE parish_id IS NOT NULL;
