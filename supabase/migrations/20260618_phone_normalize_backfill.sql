-- ═══════════════════════════════════════════════════════════════════════════
-- OPTIONAL phone-number cleanup — normalize stored phone values to bare digits.
--
-- NOT REQUIRED for correct display: the app's shared formatter (src/utils/phone.js)
-- re-derives formatting from whatever digits are stored, so existing values
-- already render as "(XXX)-XXX-XXXX". This migration is pure housekeeping so the
-- columns hold a consistent digits-only representation going forward (matching
-- what new saves now write via normalizePhone()).
--
-- PROPOSED — pause for approval before applying. Snapshot first. Idempotent:
-- running it again is a no-op once values are already digits.
--
-- Normalization rule (mirrors normalizePhone): strip every non-digit, then drop a
-- leading US "1" when the result is 11 digits. Values that are not exactly 10/11
-- digits (extensions, intl, free text) are LEFT UNCHANGED so nothing is mangled.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Reusable expression: digits-only with a leading "1" dropped from 11-digit input.
-- Applied per phone column. Only rows where the cleaned value differs AND lands
-- on a clean 10-digit number are touched (guards against mangling odd values).

-- personnel.phone
UPDATE personnel
SET phone = regexp_replace(
      CASE WHEN length(regexp_replace(phone, '\D', '', 'g')) = 11
            AND left(regexp_replace(phone, '\D', '', 'g'), 1) = '1'
           THEN right(regexp_replace(phone, '\D', '', 'g'), 10)
           ELSE regexp_replace(phone, '\D', '', 'g') END,
      '', '', 'g')
WHERE phone IS NOT NULL
  AND length(regexp_replace(phone, '\D', '', 'g')) IN (10, 11)
  AND phone <> CASE WHEN length(regexp_replace(phone, '\D', '', 'g')) = 11
                         AND left(regexp_replace(phone, '\D', '', 'g'), 1) = '1'
                        THEN right(regexp_replace(phone, '\D', '', 'g'), 10)
                        ELSE regexp_replace(phone, '\D', '', 'g') END;

-- NOTE: the sacramental tables (sacramental_baptism parent1_phone/parent2_phone,
-- sacramental_confirmation candidate_phone/parent_phone, sacramental_firstcomm
-- parent1_phone, couples groom_phone/bride_phone, ocia_candidates phone,
-- annulment_cases petitioner_cell) can be normalized the same way if desired —
-- left out here pending confirmation of the exact live column names. Say the word
-- and I'll add an UPDATE per column using the identical expression.

COMMIT;
