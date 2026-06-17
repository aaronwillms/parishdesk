-- ── Annulments rebuild — type-driven cases + document templates ────────────
-- Run once in the Supabase SQL editor. All additions are additive and
-- idempotent; existing annulment_cases data is preserved and rendered via
-- fallback to the legacy petitioner / respondent / notes / documents / timeline
-- columns when the new fields are null.

-- Annulment type with all 6 types
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS annulment_type text DEFAULT 'formal'
  CHECK (annulment_type IN ('formal', 'lack_of_form', 'petrine', 'pauline', 'ligamen', 'ratum'));

-- Advocate
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS advocate_id uuid REFERENCES personnel(id) ON DELETE SET NULL;
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS advocate_name_override text;

-- Petitioner expanded
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS petitioner_first text;
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS petitioner_middle text;
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS petitioner_last text;
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS petitioner_maiden text;
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS petitioner_street text;
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS petitioner_city text;
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS petitioner_state text;
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS petitioner_zip text;
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS petitioner_cell text;
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS petitioner_email text;
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS petitioner_baptism_church text;
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS petitioner_baptism_city text;
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS petitioner_baptism_state text;

-- Respondent expanded
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS respondent_first text;
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS respondent_middle text;
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS respondent_last text;
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS respondent_maiden text;
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS respondent_baptized boolean DEFAULT false;
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS respondent_catholic boolean DEFAULT false;

-- Previous annulments
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS previous_annulments jsonb DEFAULT '[]';

-- Marriage info
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS marriage_date date;
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS marriage_city text;
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS marriage_state_country text;
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS marriage_ceremony_type text;
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS marriage_church text;

-- Tribunal
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS tribunal_diocese text;
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS date_filed date;

-- Briefer process
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS briefer_process boolean DEFAULT false;

-- Vetitum
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS vetitum boolean DEFAULT false;
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS vetitum_notes text;

-- Linked records
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS linked_marriage_prep_id uuid REFERENCES couples(id) ON DELETE SET NULL;
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS linked_ocia_id uuid REFERENCES sacramental_ocia(id) ON DELETE SET NULL;

-- Advocate case access tracking
ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS preparation_responsible_id uuid REFERENCES personnel(id) ON DELETE SET NULL;

-- Annulment templates table
CREATE TABLE IF NOT EXISTS annulment_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  annulment_type text NOT NULL CHECK (annulment_type IN ('formal', 'lack_of_form', 'petrine', 'pauline', 'ligamen', 'ratum')),
  documents jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(annulment_type)
);

ALTER TABLE annulment_templates DISABLE ROW LEVEL SECURITY;

-- Seed default document templates
INSERT INTO annulment_templates (annulment_type, documents) VALUES
('formal', '[{"name":"Completed Petition","deletable":false},{"name":"Personal Testimony","deletable":true},{"name":"Petitioner Baptismal Certificate or Affidavit","deletable":true},{"name":"Marriage License","deletable":false},{"name":"Divorce Decree","deletable":false}]'),
('lack_of_form', '[{"name":"Completed Petition","deletable":false},{"name":"Petitioner Baptismal Certificate or Affidavit","deletable":true},{"name":"Marriage License","deletable":false},{"name":"Divorce Decree","deletable":false}]'),
('petrine', '[{"name":"Completed Petition","deletable":false},{"name":"Personal Testimony","deletable":true},{"name":"Petitioner Baptismal Certificate or Affidavit","deletable":true},{"name":"Marriage License","deletable":false},{"name":"Divorce Decree","deletable":false}]'),
('pauline', '[{"name":"Completed Petition","deletable":false},{"name":"Personal Testimony","deletable":true},{"name":"Petitioner Baptismal Certificate or Affidavit","deletable":true},{"name":"Marriage License","deletable":false},{"name":"Divorce Decree","deletable":false}]'),
('ligamen', '[{"name":"Completed Petition","deletable":false},{"name":"Personal Testimony","deletable":true},{"name":"Petitioner Baptismal Certificate or Affidavit","deletable":true},{"name":"Marriage License","deletable":false},{"name":"Divorce Decree","deletable":false}]'),
('ratum', '[{"name":"Completed Petition","deletable":false},{"name":"Personal Testimony","deletable":true},{"name":"Petitioner Baptismal Certificate or Affidavit","deletable":true},{"name":"Marriage Certificate","deletable":false},{"name":"Proof of Non-Consummation","deletable":true}]')
ON CONFLICT (annulment_type) DO NOTHING;
