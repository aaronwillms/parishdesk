-- Backfill the legacy "External" data smell after de-ambiguating External into a
-- pure is_external boolean (status_code now holds only inprogress/complete/inactive;
-- marriage_type holds only a real ceremony type).
--
-- AUDIT (2026-06-18): exactly ONE row is affected — the same row carries both legacy
-- values (Jack Clanton & Kat Claycomb, id 1fdcf837-8a14-448e-a192-39030fd59cfb):
--     marriage_type = 'external'   (1 row)
--     status_code   = 'external'   (1 row)   is_external already = true
--
-- The real ceremony type was never captured (it was collapsed to 'external'), so we
-- default it to 'nuptial_mass' (the app default); correct it in the file's edit
-- dialog if it was actually Outside Mass / Convalidation / Sanatio. status_code
-- becomes 'inprogress' (a real status); is_external stays true so the file still
-- reads as External in the In-Progress slot.
--
-- PAUSED: review, then run in the Supabase SQL editor. The app already self-heals a
-- row on its next save through the edit modal (marriage_type → real type via
-- marTypeReal, status_code → a real status), so this is the bulk one-shot equivalent.

-- marriage_type 'external' → real type (default nuptial_mass)
UPDATE couples
   SET marriage_type = 'nuptial_mass'
 WHERE marriage_type = 'external';

-- status_code 'external' → real status, keeping the External overlay on the boolean
UPDATE couples
   SET status_code = 'inprogress',
       is_external = true
 WHERE status_code = 'external';
