-- ═══════════════════════════════════════════════════════════════════════════
-- SICK & HOMEBOUND — visit log: optional free-text note on a full "Log a Visit"
-- entry. Additive + idempotent. homebound_visits already exists (Step 1) with RLS
-- DISABLED + anon REVOKED — a column add inherits the table's grants, so NO new
-- anon revoke is needed. The RLS line is re-asserted defensively (the project has
-- been observed to re-enable RLS post-batch). Run once in the SQL editor.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE homebound_visits ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE homebound_visits DISABLE ROW LEVEL SECURITY;   -- re-assert (no new table → no anon change)

NOTIFY pgrst, 'reload schema';
