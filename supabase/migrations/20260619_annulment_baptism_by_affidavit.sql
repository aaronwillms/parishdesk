-- ═══════════════════════════════════════════════════════════════════════════
-- Annulments — "By Affidavit" flag on the petitioner's baptismal record.
-- When a baptismal certificate can't be obtained, the fact of baptism is attested
-- by affidavit; this boolean records that the petitioner's baptism on file is by
-- affidavit rather than a certificate. All other baptism detail fields reuse the
-- existing petitioner_baptism_* columns — this is the only new column.
--
-- PROPOSED — pause for approval before applying. Additive, idempotent, reversible,
-- default false (no data impact on existing rows). Run once in the Supabase SQL
-- editor.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE annulment_cases ADD COLUMN IF NOT EXISTS petitioner_baptism_by_affidavit boolean DEFAULT false;
