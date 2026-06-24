-- ═══════════════════════════════════════════════════════════════════════════
-- SICK & HOMEBOUND — Step 3a-supplement: managed facilities list + location repoint.
-- Run ONCE in the Supabase SQL editor. Additive + idempotent. The recipient table
-- is empty (3a test data was cleaned up), so the free-text → facility_id repoint is
-- a clean drop, not a data migration.
--
-- Hospitals / nursing homes are NOT parish institutions, so they get their own
-- table (homebound_facilities) — they must NOT pollute the institution dropdowns.
-- The facilities list is SHARED by the facility AND hospital care-types; per-person
-- room lives on the recipient. Client-gated like the other homebound tables.
--
-- STANDING RULES (as Step 1): DISABLE RLS + REVOKE anon on the new table; also see
-- the separate re-assert block to run after this, since the project re-enables RLS
-- post-batch.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. homebound_facilities — parish-managed list of hospitals / care facilities.
CREATE TABLE IF NOT EXISTS homebound_facilities (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parish_id  uuid NOT NULL DEFAULT current_parish_id() REFERENCES parish_settings(id) ON DELETE CASCADE,
  name       text NOT NULL,
  street     text,
  city       text,
  state      text,
  zip        text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE homebound_facilities DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON homebound_facilities FROM anon;
CREATE INDEX IF NOT EXISTS idx_homebound_facilities_parish ON homebound_facilities (parish_id);

-- 2. Repoint homebound_recipients location → facility_id + per-person room_unit,
--    with an inline fallback name for the "Other" (not-in-list) case.
ALTER TABLE homebound_recipients ADD COLUMN IF NOT EXISTS facility_id          uuid REFERENCES homebound_facilities(id) ON DELETE SET NULL;
ALTER TABLE homebound_recipients ADD COLUMN IF NOT EXISTS facility_inline_name text;   -- "Other" facility not in the list
ALTER TABLE homebound_recipients ADD COLUMN IF NOT EXISTS room_unit            text;   -- per-person (facility AND hospital)

-- Drop the 3a free-text location columns (empty table → safe). The facility/hospital
-- NAME now comes from facility_id → homebound_facilities (or facility_inline_name);
-- the two separate room columns collapse into the single per-person room_unit.
ALTER TABLE homebound_recipients DROP COLUMN IF EXISTS facility_name;
ALTER TABLE homebound_recipients DROP COLUMN IF EXISTS hospital_name;
ALTER TABLE homebound_recipients DROP COLUMN IF EXISTS facility_room_unit;
ALTER TABLE homebound_recipients DROP COLUMN IF EXISTS hospital_room;

NOTIFY pgrst, 'reload schema';
