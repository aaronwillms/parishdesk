-- ─────────────────────────────────────────────────────────────────────────────
-- DRAFT — drop the redundant legacy annulment cross-panel link columns.
--
-- annulment_cases.linked_marriage_prep_id / linked_ocia_id predate the
-- record_links table. 20260620_record_links.sql already backfilled them into
-- record_links, and the app no longer writes OR renders these columns (all
-- cross-panel links now live in record_links + the unified "Linked Records"
-- section). So the columns are dead weight.
--
-- ORDER: apply this ONCE, in the Supabase SQL editor, AFTER
-- 20260620_record_links.sql (and after its `ALTER TABLE record_links DISABLE
-- ROW LEVEL SECURITY;` line). Everything here is idempotent and safe to re-run.
--
-- Step 1 is a belt-and-suspenders re-backfill: it copies any legacy link that is
-- somehow not yet mirrored in record_links, so dropping the columns can never
-- lose a link. In a fully-backfilled DB it inserts nothing.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1a. Safety re-backfill: annulment → marriage legacy links.
INSERT INTO record_links (type_a, id_a, type_b, id_b)
SELECT
  CASE WHEN ('annulment:'||a.id::text) <= ('marriage:'||a.linked_marriage_prep_id::text) THEN 'annulment' ELSE 'marriage'  END,
  CASE WHEN ('annulment:'||a.id::text) <= ('marriage:'||a.linked_marriage_prep_id::text) THEN a.id       ELSE a.linked_marriage_prep_id END,
  CASE WHEN ('annulment:'||a.id::text) <= ('marriage:'||a.linked_marriage_prep_id::text) THEN 'marriage' ELSE 'annulment' END,
  CASE WHEN ('annulment:'||a.id::text) <= ('marriage:'||a.linked_marriage_prep_id::text) THEN a.linked_marriage_prep_id ELSE a.id END
FROM annulment_cases a
WHERE a.linked_marriage_prep_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM record_links r
    WHERE (r.type_a = 'annulment' AND r.id_a = a.id AND r.type_b = 'marriage' AND r.id_b = a.linked_marriage_prep_id)
       OR (r.type_b = 'annulment' AND r.id_b = a.id AND r.type_a = 'marriage' AND r.id_a = a.linked_marriage_prep_id)
  );

-- 1b. Safety re-backfill: annulment → OCIA legacy links.
INSERT INTO record_links (type_a, id_a, type_b, id_b)
SELECT
  CASE WHEN ('annulment:'||a.id::text) <= ('ocia:'||a.linked_ocia_id::text) THEN 'annulment' ELSE 'ocia'      END,
  CASE WHEN ('annulment:'||a.id::text) <= ('ocia:'||a.linked_ocia_id::text) THEN a.id       ELSE a.linked_ocia_id END,
  CASE WHEN ('annulment:'||a.id::text) <= ('ocia:'||a.linked_ocia_id::text) THEN 'ocia'      ELSE 'annulment' END,
  CASE WHEN ('annulment:'||a.id::text) <= ('ocia:'||a.linked_ocia_id::text) THEN a.linked_ocia_id ELSE a.id END
FROM annulment_cases a
WHERE a.linked_ocia_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM record_links r
    WHERE (r.type_a = 'annulment' AND r.id_a = a.id AND r.type_b = 'ocia' AND r.id_b = a.linked_ocia_id)
       OR (r.type_b = 'annulment' AND r.id_b = a.id AND r.type_a = 'ocia' AND r.id_a = a.linked_ocia_id)
  );

-- 2. Drop the now-redundant columns.
ALTER TABLE annulment_cases
  DROP COLUMN IF EXISTS linked_marriage_prep_id,
  DROP COLUMN IF EXISTS linked_ocia_id;
