-- Baptism templates: replace fees with documents + steps configuration.
ALTER TABLE baptism_templates ADD COLUMN IF NOT EXISTS documents jsonb DEFAULT '[]';
ALTER TABLE baptism_templates ADD COLUMN IF NOT EXISTS steps jsonb DEFAULT '[{"step":"Parent Preparation Complete","deletable":true}]';
UPDATE baptism_templates SET steps = '[{"step":"Parent Preparation Complete","deletable":true}]' WHERE steps IS NULL;
