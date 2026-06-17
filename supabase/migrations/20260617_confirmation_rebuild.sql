-- ── Confirmation rebuild — cohort system, type-driven form, templates ──────
-- Run once in the Supabase SQL editor. Additive and idempotent; existing
-- sacramental_confirmation data is preserved and rendered via fallback to the
-- legacy name / sacrament_date / parent1 / parent2 / phone / email / grade /
-- sponsor / notes / documents / timeline columns.

-- Status (NOT in the original spec migration — added here so the new
-- Enrolled/In Preparation/Preparation Complete/Confirmed/Inactive workflow has
-- a column. No-op if it already exists.)
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS status_code text DEFAULT 'enrolled';

-- Template type
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS template_type text DEFAULT 'youth'
  CHECK (template_type IN ('youth', 'adult'));

-- Cohort
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS cohort_id uuid;
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS cohort_date date;

-- Candidate details
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS first_name text;
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS middle_name text;
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS last_name text;
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS dob date;
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS candidate_phone text;
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS candidate_email text;
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS school_name text;
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS grade_level text;

-- Parent/Guardian
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS parent_name text;
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS parent_phone text;
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS parent_email text;
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS parent_permission_granted boolean DEFAULT false;
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS parent_permission_date date;

-- Confirmation details
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS confirmation_name text;
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS sponsor_name text;
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS confirmation_date date;
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS confirmation_location text;
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS confirmation_institution_id uuid REFERENCES institutions(id) ON DELETE SET NULL;

-- Baptism info
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS baptism_church text;
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS baptism_city text;
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS baptism_state text;
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS baptism_country text DEFAULT 'United States of America';

-- First Communion info
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS first_communion_church text;
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS first_communion_city text;
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS first_communion_state text;
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS first_communion_country text DEFAULT 'United States of America';

-- Service hours
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS service_hours_completed int DEFAULT 0;
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS service_hours_required int DEFAULT 20;

-- Family grouping
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS family_group_id uuid;

-- Person responsible
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS preparation_responsible_id uuid REFERENCES personnel(id) ON DELETE SET NULL;
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS preparation_responsible_override text;

-- Notes as jsonb (additive)
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS notes_log jsonb DEFAULT '[]';

-- Cohort table
CREATE TABLE IF NOT EXISTS sacramental_cohorts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  panel text NOT NULL CHECK (panel IN ('firstcomm', 'confirmation')),
  cohort_date date NOT NULL,
  church_institution_id uuid REFERENCES institutions(id) ON DELETE SET NULL,
  church_override text,
  church_city text,
  church_state text,
  created_at timestamptz DEFAULT now(),
  UNIQUE(panel, cohort_date)
);

ALTER TABLE sacramental_cohorts DISABLE ROW LEVEL SECURITY;

-- Confirmation templates
CREATE TABLE IF NOT EXISTS confirmation_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_type text NOT NULL CHECK (template_type IN ('youth', 'adult')),
  documents jsonb DEFAULT '[]',
  service_hours_enabled boolean DEFAULT false,
  service_hours_required int DEFAULT 20,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(template_type)
);

ALTER TABLE confirmation_templates DISABLE ROW LEVEL SECURITY;

INSERT INTO confirmation_templates (template_type, documents, service_hours_enabled) VALUES
('youth', '[{"name":"Baptismal Certificate","deletable":false},{"name":"Petition to Bishop","deletable":true}]', false),
('adult', '[{"name":"Baptismal Certificate","deletable":false},{"name":"Petition to Bishop","deletable":true}]', false)
ON CONFLICT (template_type) DO NOTHING;
