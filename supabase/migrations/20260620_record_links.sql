-- ═══════════════════════════════════════════════════════════════════════════
-- Cross-panel record linking — direct bidirectional pairs across OCIA / Marriage /
-- Annulment files. (Mechanism B.)
--
-- This is SEPARATE from annulment-to-annulment grouping (mechanism A), which stays on
-- `annulment_cases.case_group_id` + the shared familyLink group logic — unchanged.
--
-- record_links stores ONE row per cross-panel pair, queryable from either side:
--   • type_a / id_a  — one endpoint (panel key + record id)
--   • type_b / id_b  — the other endpoint
--   panel keys: 'ocia' | 'marriage' | 'annulment'
-- The app normalizes endpoint order (by "type:id") before writing, so a pair is stored
-- once and the unique index dedupes it regardless of which side initiated the link.
-- Pairs are NOT transitive (no auto-spreading group) and same-type pairs are never
-- written here — OCIA↔OCIA / Marriage↔Marriage are forbidden, and annulment↔annulment
-- is handled by case_group_id, not this table. (Enforced in the app; a partial CHECK
-- forbidding type_a = type_b is added as a backstop.)
--
-- PROPOSED — pause for approval before applying. Additive (new table only), idempotent,
-- reversible; no existing data is touched. Run once in the Supabase SQL editor.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS record_links (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type_a     text NOT NULL,
  id_a       uuid NOT NULL,
  type_b     text NOT NULL,
  id_b       uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT record_links_not_same_record CHECK (NOT (type_a = type_b AND id_a = id_b))
);

-- One stored row per normalized pair (dedupe; both endpoints unique together).
CREATE UNIQUE INDEX IF NOT EXISTS record_links_pair_uidx
  ON record_links (type_a, id_a, type_b, id_b);

-- Fast lookup of "all links touching record X" from either side.
CREATE INDEX IF NOT EXISTS record_links_a_idx ON record_links (type_a, id_a);
CREATE INDEX IF NOT EXISTS record_links_b_idx ON record_links (type_b, id_b);

-- Access: match the other parish tables (annulment_cases / sacramental_ocia / couples),
-- which the app reads/writes with the anon key. A freshly-created table has RLS enabled
-- with no policy, which blocks all access (42501) — disable it so this table behaves
-- like the rest of the schema.
ALTER TABLE record_links DISABLE ROW LEVEL SECURITY;

-- ── Backfill existing annulment → Marriage / OCIA links ─────────────────────
-- The annulment editor previously stored one-directional links in
-- annulment_cases.linked_marriage_prep_id / linked_ocia_id. Copy them into
-- record_links (normalized by "type:id" so order matches the app) so they become
-- reciprocal — i.e. show up on the Marriage / OCIA side too. Idempotent via
-- ON CONFLICT; the legacy columns are left in place (dead, no data lost).

INSERT INTO record_links (type_a, id_a, type_b, id_b)
SELECT
  CASE WHEN ('annulment:'||id::text) <= ('marriage:'||linked_marriage_prep_id::text) THEN 'annulment' ELSE 'marriage'  END,
  CASE WHEN ('annulment:'||id::text) <= ('marriage:'||linked_marriage_prep_id::text) THEN id        ELSE linked_marriage_prep_id END,
  CASE WHEN ('annulment:'||id::text) <= ('marriage:'||linked_marriage_prep_id::text) THEN 'marriage' ELSE 'annulment' END,
  CASE WHEN ('annulment:'||id::text) <= ('marriage:'||linked_marriage_prep_id::text) THEN linked_marriage_prep_id ELSE id END
FROM annulment_cases
WHERE linked_marriage_prep_id IS NOT NULL
ON CONFLICT (type_a, id_a, type_b, id_b) DO NOTHING;

INSERT INTO record_links (type_a, id_a, type_b, id_b)
SELECT
  CASE WHEN ('annulment:'||id::text) <= ('ocia:'||linked_ocia_id::text) THEN 'annulment' ELSE 'ocia'      END,
  CASE WHEN ('annulment:'||id::text) <= ('ocia:'||linked_ocia_id::text) THEN id        ELSE linked_ocia_id END,
  CASE WHEN ('annulment:'||id::text) <= ('ocia:'||linked_ocia_id::text) THEN 'ocia'      ELSE 'annulment' END,
  CASE WHEN ('annulment:'||id::text) <= ('ocia:'||linked_ocia_id::text) THEN linked_ocia_id ELSE id END
FROM annulment_cases
WHERE linked_ocia_id IS NOT NULL
ON CONFLICT (type_a, id_a, type_b, id_b) DO NOTHING;
