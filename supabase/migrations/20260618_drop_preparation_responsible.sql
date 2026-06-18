-- Consolidate the formation-person field across all sacrament panels.
--
-- Every sacrament panel (Baptism, First Communion, Confirmation, Marriage, OCIA)
-- previously had TWO overlapping fields:
--   1. an original "Person Responsible" dropdown sourced from clergy ONLY, stored
--      in preparation_responsible_id (FK) + preparation_responsible_override (text);
--   2. a later "Preparer" dropdown sourced correctly from Clergy + the program's
--      Coordinator(s) + "Other", stored in the `preparer` text column.
--
-- These were merged into ONE field labeled "Person Responsible for Formation",
-- backed by the surviving `preparer` text column (kept, only relabeled in the UI).
-- The original preparation_responsible_* columns are now unused by the app.
--
-- SAFE TO DROP: a read-only audit (2026-06-18) found ZERO non-null values in
-- preparation_responsible_id / preparation_responsible_override across every table
-- (couples 0/9 rows populated; the four sacramental_* tables had 0 rows). No data
-- migration is required.
--
-- PAUSED: run this in the Supabase SQL editor after deploying the app change.
-- The app no longer reads or writes these columns, so it is correct either way —
-- dropping them is pure cleanup.

ALTER TABLE couples                 DROP COLUMN IF EXISTS preparation_responsible_id,
                                    DROP COLUMN IF EXISTS preparation_responsible_override;
ALTER TABLE sacramental_baptism     DROP COLUMN IF EXISTS preparation_responsible_id,
                                    DROP COLUMN IF EXISTS preparation_responsible_override;
ALTER TABLE sacramental_firstcomm   DROP COLUMN IF EXISTS preparation_responsible_id,
                                    DROP COLUMN IF EXISTS preparation_responsible_override;
ALTER TABLE sacramental_confirmation DROP COLUMN IF EXISTS preparation_responsible_id,
                                    DROP COLUMN IF EXISTS preparation_responsible_override;
ALTER TABLE sacramental_ocia        DROP COLUMN IF EXISTS preparation_responsible_id,
                                    DROP COLUMN IF EXISTS preparation_responsible_override;
