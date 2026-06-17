-- ── First Communion rebuild — cohort system, family linking, templates ─────
-- Run once in the Supabase SQL editor. Additive and idempotent; existing
-- sacramental_firstcomm data is preserved and rendered via fallback to the
-- legacy name / sacrament_date / parent1 / parent2 / phone / email / grade /
-- notes / documents / timeline columns. family_group_id already exists.

-- Status (not in the original spec migration — added so the
-- Enrolled/In Preparation/Preparation Complete/Received/Inactive workflow has a
-- column. No-op if it already exists.)
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS status_code text DEFAULT 'enrolled';

-- Child details
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS first_name text;
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS middle_name text;
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS last_name text;
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS dob date;
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS school_name text;
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS grade_level text;
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS child_street text;
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS child_city text;
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS child_state text;
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS child_zip text;

-- Cohort
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS cohort_id uuid REFERENCES sacramental_cohorts(id) ON DELETE SET NULL;
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS cohort_date date;

-- Parent expanded
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS parent1_first text;
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS parent1_last text;
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS parent1_phone text;
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS parent1_email text;
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS parent1_catholic boolean DEFAULT true;
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS parent2_first text;
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS parent2_last text;
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS parent2_phone text;
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS parent2_email text;
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS parent2_catholic boolean DEFAULT true;

-- Baptism info
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS baptism_church text;
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS baptism_city text;
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS baptism_state text;
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS baptism_country text DEFAULT 'United States of America';

-- First Communion details
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS communion_date date;
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS communion_institution_id uuid REFERENCES institutions(id) ON DELETE SET NULL;
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS communion_church_override text;
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS communion_city text;
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS communion_state text;

-- Preparation
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS preparation_complete boolean DEFAULT false;
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS preparation_complete_date date;
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS preparation_complete_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS preparation_responsible_id uuid REFERENCES personnel(id) ON DELETE SET NULL;
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS preparation_responsible_override text;

-- Notes as jsonb (additive)
ALTER TABLE sacramental_firstcomm ADD COLUMN IF NOT EXISTS notes_log jsonb DEFAULT '[]';

-- First Communion templates
CREATE TABLE IF NOT EXISTS firstcomm_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  documents jsonb DEFAULT '[{"name":"Baptismal Certificate","deletable":false}]',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE firstcomm_templates DISABLE ROW LEVEL SECURITY;

INSERT INTO firstcomm_templates DEFAULT VALUES
ON CONFLICT DO NOTHING;
