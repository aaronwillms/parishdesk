-- ── OCIA rebuild — type-driven cases, family grouping, minor permissions ──
-- Run once in the Supabase SQL editor. Additive and idempotent; existing
-- sacramental_ocia data is preserved and rendered via fallback to the legacy
-- name / baptism_* / sponsor1 / notes / documents / timeline / parental_consent
-- / prior_marriages columns.

-- Candidate type
ALTER TABLE sacramental_ocia ADD COLUMN IF NOT EXISTS candidate_type text DEFAULT 'catechumen'
  CHECK (candidate_type IN ('catechumen', 'candidate'));

-- Family grouping
ALTER TABLE sacramental_ocia ADD COLUMN IF NOT EXISTS family_group_id uuid;

-- Sponsor (single name only)
ALTER TABLE sacramental_ocia ADD COLUMN IF NOT EXISTS sponsor_name text;

-- Baptism expanded
ALTER TABLE sacramental_ocia ADD COLUMN IF NOT EXISTS baptism_city text;
ALTER TABLE sacramental_ocia ADD COLUMN IF NOT EXISTS baptism_state text;
ALTER TABLE sacramental_ocia ADD COLUMN IF NOT EXISTS baptism_country text DEFAULT 'United States of America';

-- Reception details
ALTER TABLE sacramental_ocia ADD COLUMN IF NOT EXISTS reception_is_easter_vigil boolean DEFAULT true;
ALTER TABLE sacramental_ocia ADD COLUMN IF NOT EXISTS reception_church text;
ALTER TABLE sacramental_ocia ADD COLUMN IF NOT EXISTS sacraments_received jsonb DEFAULT '{}';

-- Person responsible
ALTER TABLE sacramental_ocia ADD COLUMN IF NOT EXISTS preparation_responsible_id uuid REFERENCES personnel(id) ON DELETE SET NULL;
ALTER TABLE sacramental_ocia ADD COLUMN IF NOT EXISTS preparation_responsible_override text;

-- Notes as jsonb (additive — existing notes text field preserved)
ALTER TABLE sacramental_ocia ADD COLUMN IF NOT EXISTS notes_log jsonb DEFAULT '[]';

-- Minor permission (additive — existing parental_consent fields preserved)
ALTER TABLE sacramental_ocia ADD COLUMN IF NOT EXISTS minor_guardian_name text;
ALTER TABLE sacramental_ocia ADD COLUMN IF NOT EXISTS minor_permission_date date;

-- OCIA templates
CREATE TABLE IF NOT EXISTS ocia_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_type text NOT NULL CHECK (candidate_type IN ('catechumen', 'candidate')),
  documents jsonb DEFAULT '[]',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(candidate_type)
);

ALTER TABLE ocia_templates DISABLE ROW LEVEL SECURITY;

INSERT INTO ocia_templates (candidate_type, documents) VALUES
('catechumen', '[]'),
('candidate', '[{"name":"Baptismal Certificate","deletable":false}]')
ON CONFLICT (candidate_type) DO NOTHING;
