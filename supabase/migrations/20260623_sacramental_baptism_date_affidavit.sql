-- ═══════════════════════════════════════════════════════════════════════════
-- Sacramental baptism DATE + "By Affidavit" fields — OCIA (candidate) + Marriage
-- (per party). Mirrors the annulment *_baptism_by_affidavit pattern + a native
-- date column (stored ISO YYYY-MM-DD, displayed MM/DD/YYYY via formatDateMDY).
--
-- OCIA: baptism_by_affidavit already exists (20260619_ocia_baptism_by_affidavit);
--       only the date column is new.
-- Marriage (couples): groom = spouse1, bride = spouse2 (matches groom_*/bride_*).
--
-- Additive · idempotent · default false. After running, the NOTIFY reloads the
-- PostgREST schema cache so the new columns are visible to the client (avoids the
-- "column not found in schema cache" error). Run once in the SQL editor.
-- ═══════════════════════════════════════════════════════════════════════════

-- PART 1 — OCIA candidate baptism date.
ALTER TABLE sacramental_ocia ADD COLUMN IF NOT EXISTS baptism_date date;

-- PART 3 — Marriage per-party baptism date + affidavit. The panel's BAPTISM columns
-- use spouse1_*/spouse2_* (spouse1 = groom, spouse2 = bride — see spouse{n}_baptism_*),
-- so the new fields sit adjacent to spouse{n}_baptism_church/city/state.
ALTER TABLE couples ADD COLUMN IF NOT EXISTS spouse1_baptism_date         date;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS spouse1_baptism_by_affidavit boolean DEFAULT false;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS spouse2_baptism_date         date;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS spouse2_baptism_by_affidavit boolean DEFAULT false;

-- Reload the PostgREST schema cache so the new columns resolve immediately.
NOTIFY pgrst, 'reload schema';
