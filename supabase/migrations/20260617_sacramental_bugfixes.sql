-- ── Sacramental bug-fix batch ─────────────────────────────────────────────
-- Run once in the Supabase SQL editor.

-- Fix 3 — Disable RLS on all sacramental record + template + cohort tables
ALTER TABLE sacramental_baptism      DISABLE ROW LEVEL SECURITY;
ALTER TABLE sacramental_firstcomm    DISABLE ROW LEVEL SECURITY;
ALTER TABLE sacramental_confirmation DISABLE ROW LEVEL SECURITY;
ALTER TABLE sacramental_ocia         DISABLE ROW LEVEL SECURITY;
ALTER TABLE couples                  DISABLE ROW LEVEL SECURITY;
ALTER TABLE annulment_cases          DISABLE ROW LEVEL SECURITY;
ALTER TABLE annulment_templates      DISABLE ROW LEVEL SECURITY;
ALTER TABLE marriage_templates       DISABLE ROW LEVEL SECURITY;
ALTER TABLE ocia_templates           DISABLE ROW LEVEL SECURITY;
ALTER TABLE confirmation_templates   DISABLE ROW LEVEL SECURITY;
ALTER TABLE baptism_templates        DISABLE ROW LEVEL SECURITY;
ALTER TABLE firstcomm_templates      DISABLE ROW LEVEL SECURITY;
ALTER TABLE sacramental_cohorts      DISABLE ROW LEVEL SECURITY;

-- Fix 4 — Country for the petitioner's Church of Baptism (annulments)
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS petitioner_baptism_country text DEFAULT 'United States of America';

-- Fix 6 — Add 'planning' to the projects status check constraint
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_code_check;
ALTER TABLE projects ADD CONSTRAINT projects_status_code_check
  CHECK (status_code IN ('planning','not_started','in_progress','blocked','complete','inactive'));
