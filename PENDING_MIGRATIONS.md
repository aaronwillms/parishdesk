# Pending Migrations

These migrations are written but NOT yet applied. Apply each once in the Supabase
SQL editor, then move it to the "Applied" section below.

## 🚧 BLOCKING — `20260620_record_links.sql` (table created; RLS fix still needed)

Creates `record_links` (cross-panel direct bidirectional pairs: OCIA / Marriage /
Annulment) + indexes + self-link CHECK, backfills legacy annulment links, and
**disables RLS** so the anon key can read/write it like the other parish tables.

The table was created, but RLS was left ON with no policy → all access blocked (42501).
**Run the one remaining line:** `ALTER TABLE record_links DISABLE ROW LEVEL SECURITY;`
(re-running the whole migration is safe — everything is idempotent). Until then,
cross-panel link/unlink/list silently fail. Annulment↔annulment grouping is unaffected.

## Applied

### ✅ `20260620_annulment_case_group.sql` — APPLIED

Adds `case_group_id uuid` (nullable) to `annulment_cases` for annulment-to-annulment
linking (shared case group, mirroring `family_group_id`). Verified live on 2026-06-20:
column exists, and a real link round-trip works — link A-B then B-C → all three share
one group (transitive); unlink a member drops it; a group dropping to one member is
retired (lone member cleared). Linked cases display with their [Status][Type] chips.

### ✅ `20260619_annulment_baptismal_status.sql` — APPLIED

Verified live against `annulment_cases` on 2026-06-19 (information_schema-style column
probe + a real insert/read/delete round-trip through PostgREST). All 17 columns exist
and round-trip correctly:

- **Petitioner** booleans: `pet_bap_catholic`, `pet_bap_noncatholic`,
  `pet_bap_became_catholic`, `pet_bap_ocia`, `pet_bap_never`, `pet_bap_nonreligious`
- **Respondent** booleans: `resp_bap_catholic`, `resp_bap_noncatholic`,
  `resp_bap_became_catholic`, `resp_bap_ocia`, `resp_bap_never`, `resp_bap_nonreligious`
- **Respondent** baptism location: `respondent_baptism_church`, `respondent_baptism_city`,
  `respondent_baptism_state`, `respondent_baptism_country`, `respondent_baptism_by_affidavit`

The annulment baptismal-status + respondent-baptism form/viewer features are fully live.
