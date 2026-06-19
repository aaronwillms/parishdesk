-- ═══════════════════════════════════════════════════════════════════════════
-- Annulments — baptismal-status booleans (Petitioner + Respondent) and the
-- respondent baptism-location columns.
--
--  • Six baptismal-status booleans PER PARTY (identical set both parties):
--      *_bap_catholic         — Baptized Catholic
--      *_bap_noncatholic      — Baptized in a non-Catholic Christian Community
--      *_bap_became_catholic  — Became Catholic after Baptism
--      *_bap_ocia             — Enrolled in OCIA
--      *_bap_never            — Never Been Baptized
--      *_bap_nonreligious     — Non-Religious Person
--    (prefix pet_ for the Petitioner, resp_ for the Respondent.)
--
--  • Respondent baptism-location columns, mirroring the existing petitioner_baptism_*
--    set: church / city / state / country + a by-affidavit flag. (The respondent
--    baptism section is surfaced only when the petitioner is unbaptized — pet_bap_never
--    or pet_bap_nonreligious — see the form logic.)
--
-- The legacy respondent_baptized / respondent_catholic booleans are SUPERSEDED by the
-- six-boolean set and are no longer written; they are left in place (dead) so no data
-- is touched. The legacy co_petitioner text column is also left in place — the form
-- stops surfacing a co-petitioner input and now derives the co-petitioner from the
-- respondent's name (Briefer Process), so this column simply goes dead for new writes.
--
-- PROPOSED — pause for approval before applying. Additive, idempotent, reversible;
-- every column is nullable / default false, so existing rows are unaffected and NO
-- data is destroyed. Run once in the Supabase SQL editor.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE annulment_cases
  -- Petitioner baptismal-status booleans
  ADD COLUMN IF NOT EXISTS pet_bap_catholic         boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS pet_bap_noncatholic      boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS pet_bap_became_catholic  boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS pet_bap_ocia             boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS pet_bap_never            boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS pet_bap_nonreligious     boolean DEFAULT false,
  -- Respondent baptismal-status booleans
  ADD COLUMN IF NOT EXISTS resp_bap_catholic        boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS resp_bap_noncatholic     boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS resp_bap_became_catholic boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS resp_bap_ocia            boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS resp_bap_never           boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS resp_bap_nonreligious    boolean DEFAULT false,
  -- Respondent baptism location (mirrors petitioner_baptism_*)
  ADD COLUMN IF NOT EXISTS respondent_baptism_church       text,
  ADD COLUMN IF NOT EXISTS respondent_baptism_city         text,
  ADD COLUMN IF NOT EXISTS respondent_baptism_state        text,
  ADD COLUMN IF NOT EXISTS respondent_baptism_country      text,
  ADD COLUMN IF NOT EXISTS respondent_baptism_by_affidavit boolean DEFAULT false;
