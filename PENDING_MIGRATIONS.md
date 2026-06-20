# Pending Migrations

These migrations are written but NOT yet applied. Apply each once in the Supabase
SQL editor, then move it to the "Applied" section below.

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
