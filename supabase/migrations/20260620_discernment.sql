-- ── Discernment module — private pastor-facing vocations tracker ────────────
-- Run ONCE in the Supabase SQL editor. Additive and idempotent.
--
-- ACCESS MODEL: these tables are CLIENT-GATED in JS (src/roles.js +
-- src/panels/discernment.js), exactly like the sacramental tables — NOT RLS.
-- The app converts to RLS app-wide later (Discernment included). So RLS is
-- DISABLED here, mirroring 20260617_sacramental_bugfixes.sql, and the anon key
-- reads/writes these rows the same way it does couples / sacramental_*.
--
-- Two access axes (both enforced in JS, see roles.js):
--   1. PANEL ACCESS — panel_grants.panel = 'discernment' (super-admin grants it
--      in the Admin Panel) OR super_admin. Collaborators: read + write ALL files.
--   2. % FILE-GRANT — record_grants.record_type = 'discerner' (added below) hands
--      ONE file READ-ONLY to a user WITHOUT panel access (e.g. a diocesan
--      vocations director). Rides the universal % layer.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. discerners — one file per person discerning a vocation.
--    person_id links a directory person (name/contact DERIVE from it); when
--    NULL, the inline identity fields (name/email/phone) are used instead (for
--    a quiet inquirer not in the directory). Neither forces a directory entry.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS discerners (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parish_id     uuid NOT NULL DEFAULT current_parish_id() REFERENCES parish_settings(id) ON DELETE CASCADE,
  person_id     uuid REFERENCES personnel(id) ON DELETE SET NULL,   -- link-existing (NULL → inline identity)
  name          text,                                               -- inline identity (used when person_id NULL)
  email         text,
  phone         text,
  vocation_type text NOT NULL CHECK (vocation_type IN ('priesthood', 'diaconate', 'religious_life')),
  author_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,  -- creator (write/view predicate input)
  archived_at   timestamptz,                                        -- soft-archive (concluded discernment)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE discerners DISABLE ROW LEVEL SECURITY;   -- client-gated (roles.js), like the sacramental tables
CREATE INDEX IF NOT EXISTS idx_discerners_parish ON discerners (parish_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. discernment_notes — accompaniment notes timeline.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS discernment_notes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discerner_id uuid NOT NULL REFERENCES discerners(id) ON DELETE CASCADE,
  parish_id    uuid NOT NULL DEFAULT current_parish_id() REFERENCES parish_settings(id) ON DELETE CASCADE,
  author_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  note_date    date,
  subject      text,
  body         text,
  created_at   timestamptz NOT NULL DEFAULT now()   -- "ts" in the spec
);
ALTER TABLE discernment_notes DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_discernment_notes_discerner ON discernment_notes (discerner_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 3. discernment_stage_transitions — frozen TEXT stage history. The CURRENT
--    stage is DERIVED (to_stage of the most recent transition) — never stored
--    on the discerner. File creation writes the first transition (NULL → start).
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS discernment_stage_transitions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discerner_id    uuid NOT NULL REFERENCES discerners(id) ON DELETE CASCADE,
  parish_id       uuid NOT NULL DEFAULT current_parish_id() REFERENCES parish_settings(id) ON DELETE CASCADE,
  from_stage      text,                                              -- NULL on the first transition
  to_stage        text NOT NULL,                                     -- frozen text — ladder edits never rewrite history
  transitioned_at timestamptz NOT NULL DEFAULT now(),
  transitioned_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  note            text
);
ALTER TABLE discernment_stage_transitions DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_discernment_transitions_discerner ON discernment_stage_transitions (discerner_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 4. discernment_followups — next-contact reminders. "Next contact" is DERIVED
--    (MIN due_date WHERE NOT done), with overdue highlighting in the UI.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS discernment_followups (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discerner_id uuid NOT NULL REFERENCES discerners(id) ON DELETE CASCADE,
  parish_id    uuid NOT NULL DEFAULT current_parish_id() REFERENCES parish_settings(id) ON DELETE CASCADE,
  due_date     date,
  note         text,
  done         boolean NOT NULL DEFAULT false,
  done_at      timestamptz,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE discernment_followups DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_discernment_followups_discerner ON discernment_followups (discerner_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 5. record_grants CHECK — ADD 'discerner' so the universal % layer can hand a
--    single discerner file (READ-ONLY) to someone without panel access. This
--    lights up has_record_grant(), the grantee header, the Admin audit view,
--    and revoke for discerner files. The original CHECK was created inline
--    (auto-named record_grants_record_type_check) in 20260617_hr_module_stage1.
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE record_grants DROP CONSTRAINT IF EXISTS record_grants_record_type_check;
ALTER TABLE record_grants ADD CONSTRAINT record_grants_record_type_check CHECK (record_type IN (
  'annulment', 'marriage', 'confirmation', 'baptism', 'first_communion', 'ocia',
  'review', 'disciplinary', 'incident', 'memo',
  'youth_member', 'adult_volunteer',
  'discerner'));
