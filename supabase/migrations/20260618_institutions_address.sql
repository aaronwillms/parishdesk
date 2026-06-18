-- ═══════════════════════════════════════════════════════════════════════════
-- Institution address — the single source of truth for an institution's mailing
-- address (street / city / state / zip), edited in the Directory's institution
-- create/settings dialog and read via getInstitutionAddress(). Sacrament file
-- address display (next task) consumes this.
--
-- Every institution gets the same fields — the principal "The Basilica of Saint
-- Mary" is not special-cased.
--
-- PROPOSED — pause for approval before applying. Additive + idempotent +
-- reversible. Apply this BEFORE (or together with) the Directory UI change:
-- the create/settings save writes these columns, so institution create/edit
-- needs them present.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE institutions ADD COLUMN IF NOT EXISTS street text;
ALTER TABLE institutions ADD COLUMN IF NOT EXISTS city   text;
ALTER TABLE institutions ADD COLUMN IF NOT EXISTS state  text;
ALTER TABLE institutions ADD COLUMN IF NOT EXISTS zip    text;
