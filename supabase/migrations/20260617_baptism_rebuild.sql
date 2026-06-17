-- ── Baptism rebuild — age gate, godparent validation, adoption, delegation ──
-- Run once in the Supabase SQL editor. Additive and idempotent; existing
-- sacramental_baptism data is preserved and rendered via fallback to the legacy
-- name / sacrament_date / father / mother / phone / email / godfather /
-- godmother / notes / documents / timeline columns.

-- Status (not in the original spec migration — added so the
-- Scheduled/Complete/Inactive workflow has a column. No-op if it exists.)
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS status_code text DEFAULT 'scheduled';

-- Child details
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS first_name text;
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS middle_name text;
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS last_name text;
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS baptism_date date;
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS child_street text;
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS child_city text;
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS child_state text;
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS child_zip text;

-- Baptism location
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS baptism_institution_id uuid REFERENCES institutions(id) ON DELETE SET NULL;
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS baptism_church_override text;
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS baptism_city text;
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS baptism_state text;

-- Parent 1 expanded
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS parent1_first text;
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS parent1_last text;
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS parent1_phone text;
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS parent1_email text;
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS parent1_catholic boolean DEFAULT true;

-- Parent 2 expanded
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS parent2_first text;
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS parent2_last text;
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS parent2_phone text;
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS parent2_email text;
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS parent2_catholic boolean DEFAULT true;

-- Adoption
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS is_adopted boolean DEFAULT false;
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS birth_father_name text;
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS birth_mother_name text;

-- Godparents expanded
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS godparent1_name text;
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS godparent1_catholic boolean DEFAULT true;
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS godparent1_gender text CHECK (godparent1_gender IN ('male','female'));
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS godparent2_name text;
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS godparent2_catholic boolean DEFAULT true;
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS godparent2_gender text CHECK (godparent2_gender IN ('male','female'));

-- Officiant
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS officiant_id uuid REFERENCES personnel(id) ON DELETE SET NULL;
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS officiant_override text;
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS delegation_given boolean DEFAULT false;

-- Preparation
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS preparation_complete boolean DEFAULT false;
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS preparation_complete_date date;
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS preparation_complete_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS preparation_responsible_id uuid REFERENCES personnel(id) ON DELETE SET NULL;
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS preparation_responsible_override text;

-- Notes as jsonb (additive)
ALTER TABLE sacramental_baptism ADD COLUMN IF NOT EXISTS notes_log jsonb DEFAULT '[]';

-- Baptism templates
CREATE TABLE IF NOT EXISTS baptism_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fees_enabled boolean DEFAULT false,
  fees jsonb DEFAULT '[]',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE baptism_templates DISABLE ROW LEVEL SECURITY;

INSERT INTO baptism_templates (fees_enabled) VALUES (false);
