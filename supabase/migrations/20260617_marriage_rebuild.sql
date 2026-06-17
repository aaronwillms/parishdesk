-- ── Marriage Preparation rebuild — type-driven cases + templates ───────────
-- Run once in the Supabase SQL editor. Additive and idempotent; existing
-- couples data is preserved and rendered via fallback to the legacy
-- groom / bride / documents / timeline / prior_marriages / notes / fee columns.

-- External toggle
ALTER TABLE couples ADD COLUMN IF NOT EXISTS is_external boolean DEFAULT false;

-- Person responsible
ALTER TABLE couples ADD COLUMN IF NOT EXISTS preparation_responsible_id uuid REFERENCES personnel(id) ON DELETE SET NULL;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS preparation_responsible_override text;

-- Spouse 1 expanded
ALTER TABLE couples ADD COLUMN IF NOT EXISTS spouse1_first text;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS spouse1_middle text;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS spouse1_last text;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS spouse1_dob date;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS spouse1_unbaptized boolean DEFAULT false;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS spouse1_non_catholic boolean DEFAULT false;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS spouse1_in_ocia boolean DEFAULT false;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS spouse1_ocia_id uuid REFERENCES sacramental_ocia(id) ON DELETE SET NULL;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS spouse1_baptism_church text;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS spouse1_baptism_city text;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS spouse1_baptism_state text;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS spouse1_prior_marriages jsonb DEFAULT '[]';

-- Spouse 2 expanded
ALTER TABLE couples ADD COLUMN IF NOT EXISTS spouse2_first text;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS spouse2_middle text;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS spouse2_last text;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS spouse2_dob date;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS spouse2_unbaptized boolean DEFAULT false;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS spouse2_non_catholic boolean DEFAULT false;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS spouse2_in_ocia boolean DEFAULT false;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS spouse2_ocia_id uuid REFERENCES sacramental_ocia(id) ON DELETE SET NULL;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS spouse2_baptism_church text;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS spouse2_baptism_city text;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS spouse2_baptism_state text;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS spouse2_prior_marriages jsonb DEFAULT '[]';

-- Wedding details
ALTER TABLE couples ADD COLUMN IF NOT EXISTS wedding_institution_id uuid REFERENCES institutions(id) ON DELETE SET NULL;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS wedding_church_override text;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS wedding_city text;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS wedding_state text;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS non_church_wedding boolean DEFAULT false;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS officiant_id uuid REFERENCES personnel(id) ON DELETE SET NULL;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS officiant_override text;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS delegation_given boolean DEFAULT false;

-- Convalidation / Sanatio
ALTER TABLE couples ADD COLUMN IF NOT EXISTS civil_marriage_date date;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS sanatio_faculty text;

-- Steps, fees (the legacy `fee` text field is kept untouched)
ALTER TABLE couples ADD COLUMN IF NOT EXISTS steps jsonb DEFAULT '[]';
ALTER TABLE couples ADD COLUMN IF NOT EXISTS fees jsonb DEFAULT '[]';

-- Structured notes log. NOTE: `notes` already exists as TEXT, so the new
-- append-only notes array lives in `notes_log` to avoid a type collision.
-- Legacy `notes` text is still read as a fallback display entry.
ALTER TABLE couples ADD COLUMN IF NOT EXISTS notes_log jsonb DEFAULT '[]';

-- Marriage templates table
CREATE TABLE IF NOT EXISTS marriage_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  marriage_type text NOT NULL CHECK (marriage_type IN ('nuptial_mass','outside_mass','convalidation','sanatio','external')),
  documents jsonb DEFAULT '[]',
  steps jsonb DEFAULT '[{"step":"Initial Meeting","completed":false},{"step":"Ceremony Planned","completed":false}]',
  fees_enabled boolean DEFAULT true,
  fees jsonb DEFAULT '[{"name":"Standard Fee","amount":100,"paid":false}]',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(marriage_type)
);

ALTER TABLE marriage_templates DISABLE ROW LEVEL SECURITY;

INSERT INTO marriage_templates (marriage_type, documents, steps) VALUES
('nuptial_mass', '[]', '[{"step":"Initial Meeting","completed":false},{"step":"Ceremony Planned","completed":false}]'),
('outside_mass', '[]', '[{"step":"Initial Meeting","completed":false},{"step":"Ceremony Planned","completed":false}]'),
('convalidation', '[{"name":"Proof of Civil Marriage","deletable":true}]', '[{"step":"Initial Meeting","completed":false},{"step":"Ceremony Planned","completed":false}]'),
('sanatio', '[]', '[{"step":"Initial Meeting","completed":false}]'),
('external', '[]', '[]')
ON CONFLICT (marriage_type) DO NOTHING;
