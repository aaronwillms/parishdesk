-- ═══════════════════════════════════════════════════════════════════════════
-- OCIA — "By Affidavit" flag on a Candidate's baptismal record (mirrors the
-- annulment petitioner_baptism_by_affidavit pattern). When a baptismal certificate
-- can't be obtained, baptism is attested by affidavit; this boolean records that.
-- Candidates only (catechumens are unbaptized). All other baptism detail fields
-- reuse existing baptism_* columns.
--
-- PROPOSED — pause for approval before applying. Additive, idempotent, default
-- false (no data impact). Run once in the Supabase SQL editor.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE sacramental_ocia ADD COLUMN IF NOT EXISTS baptism_by_affidavit boolean DEFAULT false;
