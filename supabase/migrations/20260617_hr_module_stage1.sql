-- ═══════════════════════════════════════════════════════════════════════════
-- HR MODULE — STAGE 1: schema foundation, universal %-grant layer,
--                      and personnel.title collapse.
--
-- Run once in the Supabase SQL editor. Self-contained: all helper functions
-- are created before the objects that depend on them.
--
-- DECISIONS (from the Phase 0 audit):
--   • parish_id FOUNDATION — the app was single-tenant with no parish_id
--     anywhere. We introduce current_parish_id() (the single parish_settings
--     row IS the parish) and denormalize parish_id onto every HR table + the
--     institutions table, FK -> parish_settings(id).
--   • RLS — the rest of the app runs with RLS DISABLED (client-side enforced).
--     HR is the FIRST RLS-protected area. is_super_admin()/is_admin()/
--     has_record_grant() are SECURITY DEFINER so policies never re-trigger one
--     another (the no-recursion design).
--   • author_id / creator -> auth.users(id) (matches preparation_complete_by).
--     Domain-person references -> personnel(id) (matches advocate_id).
--   • employment_type uses UNDERSCORE values ('full_time','part_time',
--     'contract') per spec — note this differs from the legacy
--     personnel.employment hyphenated values ('full-time', ...). Intentional;
--     occupancy employment is a fresh field, not a migration of the old one.
--
-- REVERSIBILITY: every CREATE TABLE here is reversible via DROP TABLE. The
-- final `ALTER TABLE personnel DROP COLUMN title` is IRREVERSIBLE (data loss)
-- and is clearly fenced at the bottom — apply it only after the repointed
-- client (this commit) is deployed.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- 0. PARISH FOUNDATION
--    The single parish_settings row is the parish. current_parish_id() returns
--    its id and serves as the DEFAULT for every parish_id column below.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION current_parish_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM parish_settings ORDER BY id LIMIT 1
$$;


-- ───────────────────────────────────────────────────────────────────────────
-- 1. ROLE / ACCESS HELPERS (SECURITY DEFINER — the no-recursion design)
--    Role source mirrors src/roles.js: user_roles(user_id, role).
--    has_record_grant() reads record_grants directly; because it is SECURITY
--    DEFINER it bypasses record_grants' own RLS, so an HR record's SELECT policy
--    can consult it without triggering policy recursion.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION is_super_admin(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles
    WHERE user_id = p_user_id AND role = 'super_admin'
  )
$$;

CREATE OR REPLACE FUNCTION is_admin(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles
    WHERE user_id = p_user_id AND role IN ('admin', 'super_admin')
  )
$$;


-- ───────────────────────────────────────────────────────────────────────────
-- 2. INSTITUTIONS — extend for tabbed per-institution trees.
--    sort_order already exists (display order); only parish_id is missing.
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE institutions ADD COLUMN IF NOT EXISTS parish_id uuid REFERENCES parish_settings(id) ON DELETE CASCADE;
UPDATE institutions SET parish_id = current_parish_id() WHERE parish_id IS NULL;
ALTER TABLE institutions ALTER COLUMN parish_id SET DEFAULT current_parish_id();


-- ───────────────────────────────────────────────────────────────────────────
-- 3. POSITIONS — strict hierarchy, one tree per institution.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS positions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id      uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  parish_id           uuid NOT NULL DEFAULT current_parish_id() REFERENCES parish_settings(id) ON DELETE CASCADE,
  parent_position_id  uuid REFERENCES positions(id) ON DELETE CASCADE,  -- NULL = root of this institution's tree
  title               text NOT NULL,
  duties              text,
  is_administrator    boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_positions_inst_parent ON positions (institution_id, parent_position_id);


-- ───────────────────────────────────────────────────────────────────────────
-- 4. PERSON_POSITIONS — the occupancy join. HR records attach to THIS grain.
--    NEVER hard-delete an occupancy: unlink = set unlinked_at (succession
--    history). unlinked_at IS NULL = current occupant.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS person_positions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id       uuid NOT NULL REFERENCES personnel(id) ON DELETE CASCADE,
  position_id     uuid NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  parish_id       uuid NOT NULL DEFAULT current_parish_id() REFERENCES parish_settings(id) ON DELETE CASCADE,
  employment_type text CHECK (employment_type IN ('full_time', 'part_time', 'contract')),
  linked_at       timestamptz NOT NULL DEFAULT now(),
  unlinked_at     timestamptz,  -- NULL = current; set = soft-ended occupancy
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_person_positions_position ON person_positions (position_id);
CREATE INDEX IF NOT EXISTS idx_person_positions_person   ON person_positions (person_id);


-- ───────────────────────────────────────────────────────────────────────────
-- 5. REVIEW TEMPLATES + assignment join.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS review_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parish_id   uuid NOT NULL DEFAULT current_parish_id() REFERENCES parish_settings(id) ON DELETE CASCADE,
  name        text NOT NULL,
  definition  jsonb NOT NULL DEFAULT '[]'::jsonb,  -- ordered list of field defs
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS review_template_positions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES review_templates(id) ON DELETE CASCADE,
  position_id uuid NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  parish_id   uuid NOT NULL DEFAULT current_parish_id() REFERENCES parish_settings(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, position_id)
);


-- ───────────────────────────────────────────────────────────────────────────
-- 6. THE FOUR HR RECORD TABLES.
--    Shared base: id, person_position_id (position-scoped via the specific
--    occupancy), parish_id, author_id (creator = auth.uid()), record_date,
--    created_at/updated_at.
--    author_id is NOT NULL (it is the access anchor for the SELECT policy) and
--    intentionally NOT ON DELETE SET NULL — records must never orphan their
--    creator.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS performance_reviews (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_position_id  uuid NOT NULL REFERENCES person_positions(id) ON DELETE CASCADE,
  parish_id           uuid NOT NULL DEFAULT current_parish_id() REFERENCES parish_settings(id) ON DELETE CASCADE,
  author_id           uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id),
  record_date         date,
  template_id         uuid REFERENCES review_templates(id) ON DELETE SET NULL,
  frozen_definition   jsonb NOT NULL,  -- SNAPSHOT of the ordered field defs at creation
  answers             jsonb NOT NULL DEFAULT '{}'::jsonb,
  review_period_start date,
  review_period_end   date,
  review_date         date,
  signed_on_file      boolean NOT NULL DEFAULT false,
  signed_date         date,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS disciplinary_records (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_position_id  uuid NOT NULL REFERENCES person_positions(id) ON DELETE CASCADE,
  parish_id           uuid NOT NULL DEFAULT current_parish_id() REFERENCES parish_settings(id) ON DELETE CASCADE,
  author_id           uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id),
  record_date         date,
  narrative           text,
  severity            text,  -- a value from parish_settings.hr_severity_ladder
  corrective_action   text,
  signed_on_file      boolean NOT NULL DEFAULT false,
  signed_date         date,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incident_reports (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_position_id  uuid NOT NULL REFERENCES person_positions(id) ON DELETE CASCADE,
  parish_id           uuid NOT NULL DEFAULT current_parish_id() REFERENCES parish_settings(id) ON DELETE CASCADE,
  author_id           uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id),
  record_date         date,
  description         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memos (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_position_id  uuid NOT NULL REFERENCES person_positions(id) ON DELETE CASCADE,
  parish_id           uuid NOT NULL DEFAULT current_parish_id() REFERENCES parish_settings(id) ON DELETE CASCADE,
  author_id           uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id),
  record_date         date,
  subject             text,
  body                text,
  -- NO attachments this stage (deferred future feature across all record types).
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);


-- ───────────────────────────────────────────────────────────────────────────
-- 7. INCIDENT ↔ DISCIPLINARY LINK (single join, read both directions).
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS incident_disciplinary_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id     uuid NOT NULL REFERENCES incident_reports(id) ON DELETE CASCADE,
  disciplinary_id uuid NOT NULL REFERENCES disciplinary_records(id) ON DELETE CASCADE,
  parish_id       uuid NOT NULL DEFAULT current_parish_id() REFERENCES parish_settings(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (incident_id, disciplinary_id)
);


-- ───────────────────────────────────────────────────────────────────────────
-- 8. RECORD_GRANTS — the universal %-grant table (its UI comes in a later
--    stage). Polymorphic but BOUNDED — never projects/tasks/messages.
--    A grant confers SELECT only on the named record.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS record_grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parish_id   uuid NOT NULL DEFAULT current_parish_id() REFERENCES parish_settings(id) ON DELETE CASCADE,
  record_type text NOT NULL CHECK (record_type IN (
    'annulment', 'marriage', 'confirmation', 'baptism', 'first_communion', 'ocia',
    'review', 'disciplinary', 'incident', 'memo',
    'youth_member', 'adult_volunteer')),
  record_id   uuid NOT NULL,
  granted_to  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  granted_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  note        text,  -- optional reason, editable later
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_record_grants_record  ON record_grants (record_type, record_id);
CREATE INDEX IF NOT EXISTS idx_record_grants_grantee ON record_grants (granted_to);


-- ───────────────────────────────────────────────────────────────────────────
-- 9. THE SHARED GRANT-CHECK FUNCTION (created after record_grants exists).
--    Every file-holding module consults this ONE function. SECURITY DEFINER so
--    it bypasses record_grants' RLS — no policy recursion.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION has_record_grant(p_record_type text, p_record_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM record_grants
    WHERE record_type = p_record_type
      AND record_id   = p_record_id
      AND granted_to  = p_user_id
  )
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 2 — RLS POLICIES
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Structural tables: parish-scoped SELECT, admin-only writes ──────────────
ALTER TABLE institutions ENABLE ROW LEVEL SECURITY;
CREATE POLICY institutions_select ON institutions FOR SELECT TO authenticated
  USING (parish_id = current_parish_id());
CREATE POLICY institutions_admin_write ON institutions FOR ALL TO authenticated
  USING (parish_id = current_parish_id() AND is_admin(auth.uid()))
  WITH CHECK (parish_id = current_parish_id() AND is_admin(auth.uid()));

ALTER TABLE positions ENABLE ROW LEVEL SECURITY;
CREATE POLICY positions_select ON positions FOR SELECT TO authenticated
  USING (parish_id = current_parish_id());
CREATE POLICY positions_admin_write ON positions FOR ALL TO authenticated
  USING (parish_id = current_parish_id() AND is_admin(auth.uid()))
  WITH CHECK (parish_id = current_parish_id() AND is_admin(auth.uid()));

ALTER TABLE person_positions ENABLE ROW LEVEL SECURITY;
CREATE POLICY person_positions_select ON person_positions FOR SELECT TO authenticated
  USING (parish_id = current_parish_id());
CREATE POLICY person_positions_admin_write ON person_positions FOR ALL TO authenticated
  USING (parish_id = current_parish_id() AND is_admin(auth.uid()))
  WITH CHECK (parish_id = current_parish_id() AND is_admin(auth.uid()));

ALTER TABLE review_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY review_templates_select ON review_templates FOR SELECT TO authenticated
  USING (parish_id = current_parish_id());
CREATE POLICY review_templates_admin_write ON review_templates FOR ALL TO authenticated
  USING (parish_id = current_parish_id() AND is_admin(auth.uid()))
  WITH CHECK (parish_id = current_parish_id() AND is_admin(auth.uid()));

ALTER TABLE review_template_positions ENABLE ROW LEVEL SECURITY;
CREATE POLICY review_template_positions_select ON review_template_positions FOR SELECT TO authenticated
  USING (parish_id = current_parish_id());
CREATE POLICY review_template_positions_admin_write ON review_template_positions FOR ALL TO authenticated
  USING (parish_id = current_parish_id() AND is_admin(auth.uid()))
  WITH CHECK (parish_id = current_parish_id() AND is_admin(auth.uid()));

ALTER TABLE incident_disciplinary_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY incident_disciplinary_links_select ON incident_disciplinary_links FOR SELECT TO authenticated
  USING (parish_id = current_parish_id());
CREATE POLICY incident_disciplinary_links_admin_write ON incident_disciplinary_links FOR ALL TO authenticated
  USING (parish_id = current_parish_id() AND is_admin(auth.uid()))
  WITH CHECK (parish_id = current_parish_id() AND is_admin(auth.uid()));

-- ── The four HR record tables: creator-scoped + grant (SELECT) + pastor ─────
-- SELECT: author OR super_admin OR an active grant for that (record_type, id).
-- WRITE : author OR super_admin (a grant confers SELECT only; incoming
--         supervisors start blind — history handoff is an explicit grant row).
ALTER TABLE performance_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY performance_reviews_select ON performance_reviews FOR SELECT TO authenticated
  USING (author_id = auth.uid() OR is_super_admin(auth.uid()) OR has_record_grant('review', id, auth.uid()));
CREATE POLICY performance_reviews_write ON performance_reviews FOR ALL TO authenticated
  USING (author_id = auth.uid() OR is_super_admin(auth.uid()))
  WITH CHECK (author_id = auth.uid() OR is_super_admin(auth.uid()));

ALTER TABLE disciplinary_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY disciplinary_records_select ON disciplinary_records FOR SELECT TO authenticated
  USING (author_id = auth.uid() OR is_super_admin(auth.uid()) OR has_record_grant('disciplinary', id, auth.uid()));
CREATE POLICY disciplinary_records_write ON disciplinary_records FOR ALL TO authenticated
  USING (author_id = auth.uid() OR is_super_admin(auth.uid()))
  WITH CHECK (author_id = auth.uid() OR is_super_admin(auth.uid()));

ALTER TABLE incident_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY incident_reports_select ON incident_reports FOR SELECT TO authenticated
  USING (author_id = auth.uid() OR is_super_admin(auth.uid()) OR has_record_grant('incident', id, auth.uid()));
CREATE POLICY incident_reports_write ON incident_reports FOR ALL TO authenticated
  USING (author_id = auth.uid() OR is_super_admin(auth.uid()))
  WITH CHECK (author_id = auth.uid() OR is_super_admin(auth.uid()));

ALTER TABLE memos ENABLE ROW LEVEL SECURITY;
CREATE POLICY memos_select ON memos FOR SELECT TO authenticated
  USING (author_id = auth.uid() OR is_super_admin(auth.uid()) OR has_record_grant('memo', id, auth.uid()));
CREATE POLICY memos_write ON memos FOR ALL TO authenticated
  USING (author_id = auth.uid() OR is_super_admin(auth.uid()))
  WITH CHECK (author_id = auth.uid() OR is_super_admin(auth.uid()));

-- ── record_grants: super_admin only (audit view consumes SELECT later) ──────
ALTER TABLE record_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY record_grants_select ON record_grants FOR SELECT TO authenticated
  USING (is_super_admin(auth.uid()));
CREATE POLICY record_grants_write ON record_grants FOR ALL TO authenticated
  USING (is_super_admin(auth.uid()))
  WITH CHECK (is_super_admin(auth.uid()));


-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 3 — parish_settings ADDITIONS + SEED
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE parish_settings ADD COLUMN IF NOT EXISTS hr_severity_ladder jsonb
  DEFAULT '["verbal","written","final","termination"]'::jsonb;
ALTER TABLE parish_settings ADD COLUMN IF NOT EXISTS hr_banner_text text
  DEFAULT 'ParishDesk should not replace an employee''s physical personnel file.';
ALTER TABLE parish_settings ADD COLUMN IF NOT EXISTS hr_grant_autoclear boolean
  DEFAULT true;

-- Seed the existing single parish_settings row (defaults only apply to new rows).
UPDATE parish_settings SET
  hr_severity_ladder = COALESCE(hr_severity_ladder, '["verbal","written","final","termination"]'::jsonb),
  hr_banner_text     = COALESCE(hr_banner_text, 'ParishDesk should not replace an employee''s physical personnel file.'),
  hr_grant_autoclear = COALESCE(hr_grant_autoclear, true);


-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 4 — personnel.title COLLAPSE (repoint THEN drop)
-- ═══════════════════════════════════════════════════════════════════════════

-- 4a. Resolver: a person's current title(s) by walking person_positions ->
--     positions.title, grouped by institution. Within an institution multiple
--     positions collapse into one entry (history teacher + football coach =
--     "Football Coach · History Teacher"). Across institutions, one row each.
--     People with no current position resolve to no rows (directory volunteers).
CREATE OR REPLACE FUNCTION get_person_titles(p_person_id uuid)
RETURNS TABLE (institution_id uuid, institution_name text, title text)
LANGUAGE sql
STABLE
AS $$
  SELECT pos.institution_id,
         i.name AS institution_name,
         string_agg(pos.title, ' · ' ORDER BY pos.title) AS title
  FROM person_positions pp
  JOIN positions pos    ON pos.id = pp.position_id
  JOIN institutions i   ON i.id   = pos.institution_id
  WHERE pp.person_id = p_person_id
    AND pp.unlinked_at IS NULL
  GROUP BY pos.institution_id, i.name
$$;

-- 4b. Bulk view for the directory client load (one row per person+institution).
--     Plain (definer-rights) view so directory titles — non-sensitive public
--     directory info — load regardless of the reader's HR record access.
CREATE OR REPLACE VIEW person_current_titles AS
  SELECT pp.person_id,
         pos.institution_id,
         i.name AS institution_name,
         string_agg(pos.title, ' · ' ORDER BY pos.title) AS title
  FROM person_positions pp
  JOIN positions pos    ON pos.id = pp.position_id
  JOIN institutions i   ON i.id   = pos.institution_id
  WHERE pp.unlinked_at IS NULL
  GROUP BY pp.person_id, pos.institution_id, i.name;

-- 4c. ⚠️ IRREVERSIBLE — drop the retired free-standing title field.
--     The client in this commit no longer reads or writes personnel.title;
--     directory titles now derive from person_current_titles. Apply this only
--     after the repointed client is deployed. (Safe per spec: test build only,
--     no production data at risk.)
ALTER TABLE personnel DROP COLUMN IF EXISTS title;
