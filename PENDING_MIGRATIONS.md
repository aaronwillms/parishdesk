# Pending Migrations

These migrations are written but NOT yet applied. Apply each once in the Supabase
SQL editor, then move it to the "Applied" section below.

## 🚧 BLOCKING — `20260620_school_address.sql` (apply before FC/Confirmation saves)

Adds `school_street` / `school_city` / `school_state` to **`sacramental_firstcomm`**
and **`sacramental_confirmation`** so the new School institution-dropdown can
autofill + persist the selected school's address. Additive, idempotent, nullable.

**Why BLOCKING:** the FC and Confirmation save payloads now always include these
three keys, so until the columns exist PostgREST rejects EVERY First Communion and
Confirmation insert/update ("column not found"). The school NAME, baptism church,
and first-communion church conversions need NOTHING new (they round-trip through
the existing `school_name` / `baptism_church` / `first_communion_church` text
columns + their existing `*_city`/`*_state` columns) — only the School ADDRESS
genuinely lacked storage. Apply this, then FC/Confirmation save again.

## 🚧 BLOCKING — `20260620_record_links.sql` (table created; RLS fix still needed)

Creates `record_links` (cross-panel direct bidirectional pairs: OCIA / Marriage /
Annulment) + indexes + self-link CHECK, backfills legacy annulment links, and
**disables RLS** so the anon key can read/write it like the other parish tables.

The table was created, but RLS was left ON with no policy → all access blocked (42501).
**Run the one remaining line:** `ALTER TABLE record_links DISABLE ROW LEVEL SECURITY;`
(re-running the whole migration is safe — everything is idempotent). Until then,
cross-panel link/unlink/list silently fail. Annulment↔annulment grouping is unaffected.

## ✅ APPLIED — `20260620_discernment.sql` (verified live 2026-06-20)

Stands up the entire **Discernment** module (private, pastor-facing vocations
tracker). Creates 4 tables + adds `'discerner'` to the `record_grants` CHECK.

**Verified live 2026-06-20 via PostgREST round-trips (anon key):** all 4 tables +
every column present; a full insert→read→delete cycle works (discerner + first
transition → derived current stage = "Inquiry"; note; follow-up); the
`vocation_type` CHECK rejects an invalid value (23514); deleting the discerner
cascades to its children. The `record_grants` `'discerner'` CHECK shipped in this
same committed migration but could NOT be exercised from the script because
`record_grants` is correctly RLS-restricted to super-admins
(`is_super_admin(auth.uid())`) — its live exercise is the in-app `%`-grant flow as
a super-admin, still pending the parallel `%` fix.

Creates (all with `parish_id DEFAULT current_parish_id()`, **RLS DISABLED** — these
are CLIENT-GATED in JS via `roles.js`/`discernment.js`, exactly like the
sacramental tables; the app converts to RLS app-wide later):
- `discerners` — id, parish_id, `person_id` FK→personnel NULL (link-existing;
  NULL → inline `name`/`email`/`phone`), `vocation_type` CHECK
  (priesthood/diaconate/religious_life), `author_id` (creator), `archived_at`, ts.
- `discernment_notes` — discerner_id, parish_id, author_id, note_date, subject, body, created_at.
- `discernment_stage_transitions` — discerner_id, parish_id, `from_stage` NULL,
  `to_stage`, transitioned_at, transitioned_by, note. (Current stage is DERIVED
  from the latest row — never stored; stages are frozen TEXT.)
- `discernment_followups` — discerner_id, parish_id, due_date, note, done, done_at, created_by, created_at.

Also: `ALTER TABLE record_grants ... CHECK (... 'discerner')` — the single
integration point that lights up the universal `%` layer (has_record_grant,
grantee header, Admin audit view, revoke) for discerner files. This rebuilds the
auto-named `record_grants_record_type_check` constraint (drop-if-exists + re-add).

**Depends on nothing new**, but the `%`-grant path also depends on the in-flight
`record_links` RLS fix above being settled — the `%` layer is being fixed in
parallel, so the discerner `%`-grant flow can't be fully verified until BOTH this
migration AND that `%` fix land. Idempotent (IF NOT EXISTS / drop-then-add); safe to re-run.

⚠️ **RLS GOTCHA (same as `record_links`):** this project re-enables RLS on newly
created tables, so the `DISABLE ROW LEVEL SECURITY` lines in the migration do NOT
stick when run in the same script — the tables come up RLS-ON with no policy and
ALL writes are rejected ("new row violates row-level security policy"), reads
return empty. After creating the tables, run these as a SEPARATE step:
```sql
ALTER TABLE discerners                     DISABLE ROW LEVEL SECURITY;
ALTER TABLE discernment_notes              DISABLE ROW LEVEL SECURITY;
ALTER TABLE discernment_stage_transitions  DISABLE ROW LEVEL SECURITY;
ALTER TABLE discernment_followups          DISABLE ROW LEVEL SECURITY;
```
This was hit and resolved on 2026-06-20 — the four lines above were run as a
separate step, after which all writes succeeded (see verification note above).

## 🧹 CLEANUP (optional) — `20260620_drop_legacy_annulment_link_columns.sql`

Drops the dead `annulment_cases.linked_marriage_prep_id` / `linked_ocia_id` columns.
They predate `record_links`, were backfilled into it by `20260620_record_links.sql`,
and are no longer written or rendered by the app (cross-panel links live in
`record_links` + the unified "Linked Records" section). The migration first does an
idempotent re-backfill of any un-mirrored legacy link (so no link can be lost), then
drops the columns. **Apply AFTER `20260620_record_links.sql`.** Safe to re-run.

Companion code cleanup (do when/after applying — currently inert, safe to leave):
the dead JS in `src/panels/annulments.js` that reads these columns — `_coupleLabel`,
`_ociaLabel`, `renderLinkedChip`, `anlLinkSearch`, `anlSelectLinked`, `anlRemoveLinked`,
and the `linkedMarriage`/`linkedOcia` fields in the two modal-state builders. After the
column drop they resolve to `undefined → null` (no-op), so removal is non-urgent.

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
