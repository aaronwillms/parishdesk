-- ═══════════════════════════════════════════════════════════════════════════
-- Discernment module — comprehensive revision. Extends the `discerners` file with
-- the new inline person model (linking is removed in code; person_id is KEPT but
-- no longer written), and adds `created_at` to the stage-transition log to fix the
-- stuck-stage-chip bug (current stage now derives by RECORDED order, not the
-- human-entered effective date).
--
-- PROPOSED — pause for approval before applying. All additive + idempotent +
-- nullable; no existing data is lost. `discerners.name` is retained (the card +
-- the % grantable-record search still read it) and kept in sync with the split
-- first/middle/last on every save. person_id is retained but unused — drop later
-- if desired (kept now so existing rows / any linked file are not broken).
-- ═══════════════════════════════════════════════════════════════════════════

-- Name split (name kept as the denormalized combined value)
ALTER TABLE discerners ADD COLUMN IF NOT EXISTS first_name  text;
ALTER TABLE discerners ADD COLUMN IF NOT EXISTS middle_name text;
ALTER TABLE discerners ADD COLUMN IF NOT EXISTS last_name   text;

-- Gender (mutually-exclusive male/female toggle in the UI)
ALTER TABLE discerners ADD COLUMN IF NOT EXISTS gender text CHECK (gender IN ('male', 'female'));

-- Mailing address
ALTER TABLE discerners ADD COLUMN IF NOT EXISTS street text;
ALTER TABLE discerners ADD COLUMN IF NOT EXISTS city   text;
ALTER TABLE discerners ADD COLUMN IF NOT EXISTS state  text;
ALTER TABLE discerners ADD COLUMN IF NOT EXISTS zip    text;

-- Date of birth (age is auto-derived in the UI, not stored)
ALTER TABLE discerners ADD COLUMN IF NOT EXISTS dob date;

-- School — institution dropdown + Other, with City/State (name round-trips via
-- school_name; no street needed, mirroring the sacramental school field)
ALTER TABLE discerners ADD COLUMN IF NOT EXISTS school_name  text;
ALTER TABLE discerners ADD COLUMN IF NOT EXISTS school_city  text;
ALTER TABLE discerners ADD COLUMN IF NOT EXISTS school_state text;

-- Parent contacts (1–2): jsonb array of { first, last, phone, email }
ALTER TABLE discerners ADD COLUMN IF NOT EXISTS parents jsonb DEFAULT '[]';

-- "Parent aware of discernment?" boolean (null = not set)
ALTER TABLE discerners ADD COLUMN IF NOT EXISTS parent_aware boolean;

-- Spiritual director (clergy display-name string; Clergy + Other dropdown)
ALTER TABLE discerners ADD COLUMN IF NOT EXISTS spiritual_director text;

-- ── Stuck-stage-chip fix ────────────────────────────────────────────────────
-- Add a RECORDED-ORDER timestamp to the transition log. Current-stage derivation
-- orders by this (monotonic, DB-stamped) instead of the human-entered
-- transitioned_at, so a backdated/noon-of-day effective date can no longer make an
-- older transition out-rank a newer one. Backfill existing rows to their
-- transitioned_at to preserve effective order for legacy data.
ALTER TABLE discernment_stage_transitions ADD COLUMN IF NOT EXISTS created_at timestamptz;
UPDATE discernment_stage_transitions SET created_at = transitioned_at WHERE created_at IS NULL;
ALTER TABLE discernment_stage_transitions ALTER COLUMN created_at SET DEFAULT now();
