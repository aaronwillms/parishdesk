-- ═══════════════════════════════════════════════════════════════════════════
-- DIRECTORY/HR INTEGRATION — Phase 1: add the clergy axis to positions.
--
-- Structurally identical to positions.is_administrator. Defaults false; YOU flag
-- which positions are clergy after applying (do not guess which). Until clergy
-- positions are flagged, is_person_clergy() returns false for everyone and the
-- directory shows all positioned people as Lay (expected).
--
-- employment_type on person_positions is unchanged this stage (clergy
-- occupancies still carry one per the NOT NULL... CHECK schema; the directory
-- simply won't surface/group employment for clergy — see the resolver + render).
--
-- Run once in the Supabase SQL editor. Reversible (DROP COLUMN). Not run against
-- any remote DB from here.
--
-- ── Phase 5 column drops (IRREVERSIBLE) are fenced at the BOTTOM and commented
--    out — apply them ONLY after the repointed client is deployed and builds
--    clean (every reader off the manual columns). They are listed here so the
--    whole schema change lives in one reviewable file.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE positions ADD COLUMN IF NOT EXISTS is_clergy boolean NOT NULL DEFAULT false;


-- ════════════════════════════════════════════════════════════════════════════
-- PHASE 2 — RESOLVER: full directory derivation from HR.
-- One coherent surface: the canonical is_person_clergy() function + two bulk
-- views the client loads (person-level rollup + per-institution entries).
-- ════════════════════════════════════════════════════════════════════════════

-- (A) Person-level clergy rollup: true if the person holds ANY current position
--     (unlinked_at IS NULL) whose position.is_clergy = true.
CREATE OR REPLACE FUNCTION is_person_clergy(p_person_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM person_positions pp
    JOIN positions pos ON pos.id = pp.position_id
    WHERE pp.person_id = p_person_id
      AND pp.unlinked_at IS NULL
      AND pos.is_clergy = true
  )
$$;

-- (B) Person-level placement rollup (one row per personnel) — derived Type:
--       clergy   → is_person_clergy
--       staff    → not clergy AND has ≥1 current position
--       volunteer→ no current position
CREATE OR REPLACE VIEW person_placement AS
SELECT
  p.id AS person_id,
  is_person_clergy(p.id) AS is_clergy,
  EXISTS (SELECT 1 FROM person_positions pp
          WHERE pp.person_id = p.id AND pp.unlinked_at IS NULL) AS has_position,
  CASE
    WHEN is_person_clergy(p.id) THEN 'clergy'
    WHEN EXISTS (SELECT 1 FROM person_positions pp
                 WHERE pp.person_id = p.id AND pp.unlinked_at IS NULL) THEN 'staff'
    ELSE 'volunteer'
  END AS derived_type
FROM personnel p;

-- (C) Per person+institution directory ENTRIES (current occupancies). Within an
--     institution multiple positions collapse into one entry; across
--     institutions, separate entries. Each entry resolves:
--       title              — collapsed titles for that institution (Stage 1 rule)
--       entry_is_clergy     — any clergy position in that institution
--       employment_heading  — strongest LAY commitment: full_time > part_time >
--                             contract (used for grouping lay staff; clergy
--                             entries ignore it at render time)
CREATE OR REPLACE VIEW person_directory AS
SELECT
  pp.person_id,
  pos.institution_id,
  i.name AS institution_name,
  string_agg(DISTINCT pos.title, ' · ' ORDER BY pos.title) AS title,
  bool_or(pos.is_clergy) AS entry_is_clergy,
  CASE
    WHEN bool_or(pp.employment_type = 'full_time') THEN 'full_time'
    WHEN bool_or(pp.employment_type = 'part_time') THEN 'part_time'
    WHEN bool_or(pp.employment_type = 'contract')  THEN 'contract'
    ELSE NULL
  END AS employment_heading
FROM person_positions pp
JOIN positions pos    ON pos.id = pp.position_id
JOIN institutions i   ON i.id   = pos.institution_id
WHERE pp.unlinked_at IS NULL
GROUP BY pp.person_id, pos.institution_id, i.name;

-- person_current_titles (Stage 1) is SUPERSEDED by person_directory (which adds
-- entry_is_clergy + employment_heading). Left in place as harmless; drop later
-- if you wish once nothing references it.


-- ════════════════════════════════════════════════════════════════════════════
-- PHASE 5 — DROP THE MANUAL PLACEMENT COLUMNS (IRREVERSIBLE).
-- HR (positions + person_positions + is_clergy) is now the sole source of
-- organizational placement; these three free-text columns on personnel are
-- retired. UNCOMMENT and run ONLY after the repointed client is live.
-- ════════════════════════════════════════════════════════════════════════════
-- ALTER TABLE personnel DROP COLUMN IF EXISTS institution;
-- ALTER TABLE personnel DROP COLUMN IF EXISTS type;
-- ALTER TABLE personnel DROP COLUMN IF EXISTS employment;
