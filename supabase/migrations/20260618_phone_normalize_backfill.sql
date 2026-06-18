-- ═══════════════════════════════════════════════════════════════════════════
-- OPTIONAL phone-number cleanup — normalize stored phone values to bare digits.
--
-- NOT REQUIRED for correct display: the app's shared formatter (src/utils/phone.js)
-- re-derives formatting from whatever digits are stored, so existing values
-- already render as "(XXX)-XXX-XXXX". This migration is pure housekeeping so the
-- columns hold a consistent digits-only representation going forward (matching
-- what new saves now write via normalizePhone()).
--
-- APPROVED for application — run yourself in the Supabase SQL editor AFTER taking
-- a snapshot. Idempotent: running it again is a no-op once values are digits.
--
-- Normalization rule (mirrors normalizePhone, conservatively): strip non-digits,
-- drop a leading US "1" when the result is 11 digits, keep a clean 10-digit
-- result. Values that are not exactly 10/11 digits (extensions, intl, free text)
-- are LEFT UNCHANGED so nothing is mangled.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Session-temp helper (auto-dropped at COMMIT/session end). Encapsulates the
-- rule so every column update is identical and obviously correct.
CREATE FUNCTION pg_temp._norm_phone(v text) RETURNS text AS $$
  SELECT CASE
    WHEN v IS NULL THEN NULL
    WHEN length(regexp_replace(v, '\D', '', 'g')) = 11
         AND left(regexp_replace(v, '\D', '', 'g'), 1) = '1'
      THEN right(regexp_replace(v, '\D', '', 'g'), 10)
    WHEN length(regexp_replace(v, '\D', '', 'g')) = 10
      THEN regexp_replace(v, '\D', '', 'g')
    ELSE v               -- non-standard: leave untouched
  END;
$$ LANGUAGE sql IMMUTABLE;

-- Directory
UPDATE personnel
   SET phone = pg_temp._norm_phone(phone)
 WHERE phone IS DISTINCT FROM pg_temp._norm_phone(phone);

-- Sacramental records
UPDATE sacramental_baptism
   SET parent1_phone = pg_temp._norm_phone(parent1_phone)
 WHERE parent1_phone IS DISTINCT FROM pg_temp._norm_phone(parent1_phone);
UPDATE sacramental_baptism
   SET parent2_phone = pg_temp._norm_phone(parent2_phone)
 WHERE parent2_phone IS DISTINCT FROM pg_temp._norm_phone(parent2_phone);

UPDATE sacramental_firstcomm
   SET parent1_phone = pg_temp._norm_phone(parent1_phone)
 WHERE parent1_phone IS DISTINCT FROM pg_temp._norm_phone(parent1_phone);

UPDATE sacramental_confirmation
   SET candidate_phone = pg_temp._norm_phone(candidate_phone)
 WHERE candidate_phone IS DISTINCT FROM pg_temp._norm_phone(candidate_phone);
UPDATE sacramental_confirmation
   SET parent_phone = pg_temp._norm_phone(parent_phone)
 WHERE parent_phone IS DISTINCT FROM pg_temp._norm_phone(parent_phone);

UPDATE couples
   SET groom_phone = pg_temp._norm_phone(groom_phone)
 WHERE groom_phone IS DISTINCT FROM pg_temp._norm_phone(groom_phone);
UPDATE couples
   SET bride_phone = pg_temp._norm_phone(bride_phone)
 WHERE bride_phone IS DISTINCT FROM pg_temp._norm_phone(bride_phone);

UPDATE sacramental_ocia
   SET phone = pg_temp._norm_phone(phone)
 WHERE phone IS DISTINCT FROM pg_temp._norm_phone(phone);

UPDATE annulment_cases
   SET petitioner_cell = pg_temp._norm_phone(petitioner_cell)
 WHERE petitioner_cell IS DISTINCT FROM pg_temp._norm_phone(petitioner_cell);

COMMIT;
