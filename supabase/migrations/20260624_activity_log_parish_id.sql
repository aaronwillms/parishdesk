-- Multi-tenancy 2b-feed-(b): parish dimension on the activity feed.
--
-- Adds nullable activity_log.parish_id and backfills it KEY-AWARE, mirroring the shared
-- classifier isActivityParishScoped() in src/utils.js (single source of truth — the
-- writer logActivity() stamps new rows the same way). NULL = group-shared tenancy
-- (matches any parish); a parish id = scoped to that parish. Default NULL — do NOT
-- default current_parish_id() (cura/universal rows must not be auto-stamped).
--
-- Behaviorally inert single-parish: parish-scoped rows → Basilica (= the resolved parish),
-- group-shared rows → NULL; both match the one parish.
--
-- PARISH-SCOPED context_types (→ Basilica):
--   ocia, marriage, couple, baptism, confirmation, firstcomm, firstcommunion, family, hr,
--   and 'general' ONLY when entity_type ∈ {hr_record, person_position, position, review_template}.
-- GROUP-SHARED / universal / id-set-governed (→ NULL):
--   homebound, annulments, discernment (cura); personnel (directory has no parish_id);
--   announcement (universal); project, task, team (own id-sets); link; general-non-HR; unlisted.
--
-- activity_log already exists → no RLS/anon change (standing rules already apply).

-- 1. Column (nullable FK, NO ACTION).
ALTER TABLE activity_log
  ADD COLUMN IF NOT EXISTS parish_id uuid REFERENCES parish_settings(id);

-- 2a. PARISH-SCOPED context_types → Basilica (NULL-guarded → idempotent).
UPDATE activity_log SET parish_id = 'da288a33-32c1-4aa1-8cb7-76dd3edecbd9'
WHERE parish_id IS NULL
  AND context_type IN ('ocia','marriage','couple','baptism','confirmation',
                       'firstcomm','firstcommunion','family','hr');

-- 2b. 'general' → Basilica ONLY for the HR entity_types; general-non-HR stays NULL.
UPDATE activity_log SET parish_id = 'da288a33-32c1-4aa1-8cb7-76dd3edecbd9'
WHERE parish_id IS NULL
  AND context_type = 'general'
  AND entity_type IN ('hr_record','person_position','position','review_template');

-- 2c. All remaining context_types (homebound, annulments, discernment, personnel,
--     announcement, project, task, team, link, general-non-HR, unlisted) are left NULL
--     (group-shared) by omission — nothing to do.
