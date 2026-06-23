-- ═══════════════════════════════════════════════════════════════════════════
-- HR REDESIGN — PHASE 3: client-enforced permissions + self-report + archive.
--
-- Phase 3 enforces ALL HR access in the app (roles.js / hr.js), consistent with
-- the rest of ParishDesk — NOT via RLS (full server-side RLS is a separate future
-- project). For the JS subtree/supervisor model to work, a SUPERVISOR must be able
-- to READ a subordinate's records, so the four HR record tables move to the app's
-- standard client-enforced model (RLS OFF). This migration also adds storage for
-- the self-report flow, the soft-delete archive, and a per-(person, institution)
-- departure marker.
--
-- ⚠️ APPLY ORDER (matches this project's Supabase workflow):
--   1. Run sections 1–3 (columns + the new table CREATE).
--   2. Run section 4 (every DISABLE ROW LEVEL SECURITY) as its OWN separate
--      execution, LAST — newly created tables get RLS re-enabled post-batch in
--      this project, so the DISABLE must run on its own to stick.
-- Additive · idempotent · reversible. Run once in the Supabase SQL editor.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Soft-delete archive: a deleted record is hidden from the live file and
--       surfaced only in the super-admin archive (never hard-deleted from here). ─
ALTER TABLE performance_reviews  ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE disciplinary_records ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE incident_reports     ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE memos                ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- ── 2. Self-report flow: a self-report IS a performance_review authored by the
--       SUBJECT, editable until a supervisor-above (or super-admin) FINALIZES it.
--       After finalize → locked; the employee still sees it read-only. ──────────
ALTER TABLE performance_reviews ADD COLUMN IF NOT EXISTS is_self_report boolean NOT NULL DEFAULT false;
ALTER TABLE performance_reviews ADD COLUMN IF NOT EXISTS finalized      boolean NOT NULL DEFAULT false;
ALTER TABLE performance_reviews ADD COLUMN IF NOT EXISTS finalized_at   timestamptz;
ALTER TABLE performance_reviews ADD COLUMN IF NOT EXISTS finalized_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- ── 3. Departure marker: when a person leaves an institution entirely, that
--       institution's file archives under their name. One row per (person,
--       institution); delete the row to reverse (re-hire). ─────────────────────
CREATE TABLE IF NOT EXISTS institution_departures (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id      uuid NOT NULL REFERENCES personnel(id)    ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  parish_id      uuid NOT NULL DEFAULT current_parish_id() REFERENCES parish_settings(id) ON DELETE CASCADE,
  departed_at    timestamptz NOT NULL DEFAULT now(),
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (person_id, institution_id)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- ── 4. RUN THIS SECTION SEPARATELY, LAST ──  client-enforced model (RLS OFF).
--       The four record tables were RLS-protected in stage 1; Phase 3 enforces
--       access in JS (subtree + supervisor flag), so the client must be able to
--       read them. institution_departures is a NEW table → DISABLE so it is not
--       left RLS-enabled-with-no-policy (which blocks all access, 42501).
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE performance_reviews    DISABLE ROW LEVEL SECURITY;
ALTER TABLE disciplinary_records   DISABLE ROW LEVEL SECURITY;
ALTER TABLE incident_reports       DISABLE ROW LEVEL SECURITY;
ALTER TABLE memos                  DISABLE ROW LEVEL SECURITY;
ALTER TABLE institution_departures DISABLE ROW LEVEL SECURITY;
