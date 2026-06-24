-- ═══════════════════════════════════════════════════════════════════════════
-- SICK & HOMEBOUND — BUILD STEP 1: schema foundation (Pastoral Care module).
-- Run ONCE in the Supabase SQL editor. Additive · idempotent · no panel/roles code.
--
-- ACCESS MODEL: these tables are CLIENT-GATED in JS (src/roles.js +
-- src/panels/homebound.js, both built in later steps), exactly like the
-- Discernment + sacramental tables — NOT RLS. Resolution is CACHED-AT-LOAD
-- (advocate-model): roles.js will read homebound_assignments at role-load the way
-- it reads annulment_cases.advocate_id today. No live-check infra here.
--
-- Conventions mirror 20260620_discernment.sql:
--   • uuid PKs (gen_random_uuid()), parish_id DEFAULT current_parish_id(),
--     timestamptz created_at/updated_at DEFAULT now(), archived_at soft-archive.
--   • inline-or-directory person: nullable FK → personnel (NULL = pure inline) +
--     first/middle/last + denormalized `name` + inline phone/email.
--   • author_id / requested_by → auth.users(id) ON DELETE SET NULL.
--
-- STANDING RULES enforced per new table below:
--   • ALTER TABLE … DISABLE ROW LEVEL SECURITY;  (new tables auto-enable RLS)
--   • REVOKE ALL ON … FROM anon;                 (anon was just locked out app-wide;
--                                                 new tables must not re-open it)
-- authenticated + service_role keep their default grants (unchanged).
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- 1. homebound_recipients — the core file (one row per sick/homebound/hospital
--    person). personnel_id links a directory person (NULL → pure inline identity,
--    the common case: a parishioner not in the staff/volunteer directory).
--    Location is structured by care_type; mailing address is SEPARATE from the
--    current location (defaults from the home address, overridable) so a hospital
--    patient's bulletin still reaches their home.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS homebound_recipients (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parish_id     uuid NOT NULL DEFAULT current_parish_id() REFERENCES parish_settings(id) ON DELETE CASCADE,

  -- Identity (inline-or-directory; mirrors discerners). personnel_id NULL = inline.
  personnel_id  uuid REFERENCES personnel(id) ON DELETE SET NULL,
  first_name    text,
  middle_name   text,
  last_name     text,
  name          text,                       -- denormalized combined display name (kept in sync on save)
  phone         text,                       -- inline contact (used when personnel_id NULL)
  email         text,

  care_type     text NOT NULL DEFAULT 'home'   CHECK (care_type IN ('home', 'facility', 'hospital')),
  status        text NOT NULL DEFAULT 'active' CHECK (status   IN ('active', 'resolved_discharged', 'deceased')),

  -- Current location, structured by care_type (panel renders the right subset):
  --   home     → home_street/city/state/zip
  --   facility → facility_name + facility_room_unit
  --   hospital → hospital_name + hospital_room
  home_street        text,
  home_city          text,
  home_state         text,
  home_zip           text,
  facility_name      text,
  facility_room_unit text,
  hospital_name      text,
  hospital_room      text,

  -- Mailing address — SEPARATE from current location (defaults from home, overridable).
  mailing_street  text,
  mailing_city    text,
  mailing_state   text,
  mailing_zip     text,

  archived_at   timestamptz,                 -- status-filter archive (NOT a locked vault; mirrors discerners)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE homebound_recipients DISABLE ROW LEVEL SECURITY;   -- client-gated (roles.js), like discerners
REVOKE ALL ON homebound_recipients FROM anon;
CREATE INDEX IF NOT EXISTS idx_homebound_recipients_parish    ON homebound_recipients (parish_id);
CREATE INDEX IF NOT EXISTS idx_homebound_recipients_personnel ON homebound_recipients (personnel_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. homebound_visits — append visit log (child of recipient; clones
--    discernment_notes). Author-scoped edit/delete is enforced in code later
--    (author_id + edited_at present so the UI can mark/limit edits).
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS homebound_visits (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id uuid NOT NULL REFERENCES homebound_recipients(id) ON DELETE CASCADE,
  parish_id    uuid NOT NULL DEFAULT current_parish_id() REFERENCES parish_settings(id) ON DELETE CASCADE,
  visit_date   date,
  minister     text,                         -- who visited (free text / denormalized name)
  brought      jsonb NOT NULL DEFAULT '[]',  -- multi-select: ['Communion','Anointing','Confession','pastoral_visit']
  author_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  edited_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE homebound_visits DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON homebound_visits FROM anon;
CREATE INDEX IF NOT EXISTS idx_homebound_visits_recipient ON homebound_visits (recipient_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 3. care_requests — durable request channel (the DURABLE surface). Notifications
--    are only the transient delivery ping, NOT this. Pending = resolved_at IS NULL
--    (the pending-requests view reads this; mirrors discernment_followups'
--    done/incomplete queue).
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS care_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id uuid NOT NULL REFERENCES homebound_recipients(id) ON DELETE CASCADE,
  parish_id    uuid NOT NULL DEFAULT current_parish_id() REFERENCES parish_settings(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('confession', 'anointing', 'priest_visit')),
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz                    -- NULL = pending
);
ALTER TABLE care_requests DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON care_requests FROM anon;
CREATE INDEX IF NOT EXISTS idx_care_requests_recipient ON care_requests (recipient_id);
CREATE INDEX IF NOT EXISTS idx_care_requests_pending   ON care_requests (parish_id) WHERE resolved_at IS NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Ministers-to-the-Sick ROSTER — dual-kind membership.
--    LINKED half  → reuses program_coordinators (a single row with
--                   program = 'homebound', coordinator_ids = personnel uuid[]).
--                   No schema change: program_coordinators is free-text keyed by
--                   `program` (sacraments + 'discernment' already live there), so a
--                   'homebound' row drops in as-is. Account-linked members grant
--                   broad access + are notification-routable (resolved in code).
--    INLINE half  → this companion store (record-only: shown on the roster +
--                   selectable in assignment, but NO access, NOT routable).
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS homebound_roster_inline (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parish_id  uuid NOT NULL DEFAULT current_parish_id() REFERENCES parish_settings(id) ON DELETE CASCADE,
  name       text NOT NULL,                  -- display name (no account, no access)
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE homebound_roster_inline DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON homebound_roster_inline FROM anon;
CREATE INDEX IF NOT EXISTS idx_homebound_roster_inline_parish ON homebound_roster_inline (parish_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 5. homebound_assignments — minister → recipient (narrow-tier access source;
--    advocate-model). Multiple rows per recipient (multi-minister). A minister is
--    EITHER a directory person (minister_personnel_id) OR an inline name
--    (minister_inline_name). Access flows ONLY from account-linked assignees
--    (minister_personnel_id → user_profiles); inline assignees are record-only
--    (enforced in code). roles.js loads this at role-load, cached, the way
--    annulment_cases.advocate_id is loaded today.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS homebound_assignments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id          uuid NOT NULL REFERENCES homebound_recipients(id) ON DELETE CASCADE,
  parish_id             uuid NOT NULL DEFAULT current_parish_id() REFERENCES parish_settings(id) ON DELETE CASCADE,
  minister_personnel_id uuid REFERENCES personnel(id) ON DELETE SET NULL,   -- account-linkable half (grants access)
  minister_inline_name  text,                                               -- inline half (record-only)
  role                  text,                                               -- 'sacramental' | 'communion' | 'visitor'
  created_at            timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE homebound_assignments DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON homebound_assignments FROM anon;
CREATE INDEX IF NOT EXISTS idx_homebound_assignments_recipient ON homebound_assignments (recipient_id);
CREATE INDEX IF NOT EXISTS idx_homebound_assignments_personnel ON homebound_assignments (minister_personnel_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 6. parish_settings.pastoral_request_recipient — configurable designated
--    recipient for care requests. Stored as a personnel_id (FK → personnel),
--    matching the coordinator/assignment model and notifications.js
--    getUserIdForPersonnel(); code falls back to pastor/super-admin when NULL.
--    (Existing parish_settings columns — hr_severity_ladder, work_calendar_* —
--    were added the same additive ADD COLUMN IF NOT EXISTS way.)
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE parish_settings
  ADD COLUMN IF NOT EXISTS pastoral_request_recipient uuid REFERENCES personnel(id) ON DELETE SET NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. record_grants CHECK — ADD 'homebound_recipient' so the recipient file is
--    %-grantable (same step taken for 'discerner' in 20260620_discernment.sql).
--    The grants.js registry entry + access-gate wiring come in a later build step.
--    List below = the current authoritative set (20260620_discernment.sql) + the
--    new type. The constraint was auto-named record_grants_record_type_check.
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE record_grants DROP CONSTRAINT IF EXISTS record_grants_record_type_check;
ALTER TABLE record_grants ADD CONSTRAINT record_grants_record_type_check CHECK (record_type IN (
  'annulment', 'marriage', 'confirmation', 'baptism', 'first_communion', 'ocia',
  'review', 'disciplinary', 'incident', 'memo',
  'youth_member', 'adult_volunteer',
  'discerner',
  'homebound_recipient'));

-- Reload the PostgREST schema cache so the new tables + columns resolve immediately.
NOTIFY pgrst, 'reload schema';
