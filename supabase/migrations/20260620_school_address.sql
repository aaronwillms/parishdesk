-- ═══════════════════════════════════════════════════════════════════════════
-- School address — First Communion + Confirmation gain school Street/City/State
-- so the new "School" institution dropdown can autofill + persist the selected
-- school's address (via institutionAddressAutofill / getInstitutionAddress). The
-- school NAME already round-trips through the existing `school_name` text column;
-- these add the missing ADDRESS storage. Other church fields (baptism /
-- first-communion church) already have their *_city / *_state columns, so they
-- need NOTHING here — only School genuinely lacked address storage.
--
-- PROPOSED — pause for approval before applying. Additive + idempotent + nullable.
-- Apply this BEFORE using the new School dropdown's address autofill: the FC /
-- Confirmation save writes these columns, so the panels' save will error until
-- they exist (the school NAME alone is unaffected — that's the pre-existing
-- school_name column).
-- ═══════════════════════════════════════════════════════════════════════════

-- First Communion
ALTER TABLE sacramental_firstcomm   ADD COLUMN IF NOT EXISTS school_street text;
ALTER TABLE sacramental_firstcomm   ADD COLUMN IF NOT EXISTS school_city   text;
ALTER TABLE sacramental_firstcomm   ADD COLUMN IF NOT EXISTS school_state  text;

-- Confirmation
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS school_street text;
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS school_city   text;
ALTER TABLE sacramental_confirmation ADD COLUMN IF NOT EXISTS school_state  text;
