# Pending migrations

## ▶ Pending — run this

### `migrations/20260619_ocia_baptism_by_affidavit.sql`  proposed — awaiting approval
Adds `sacramental_ocia.baptism_by_affidavit` (boolean default false), mirroring the
annulment by-affidavit flag, for the OCIA Candidate baptism-document pattern. **Not
blocking** the rest of OCIA Phase 2 (the editor + church/city/state/country work
without it); needed only to wire the "By Affidavit" toggle/suffix in the viewer
baptism-doc pattern. Additive, idempotent, default false — no data impact.
- Verify: `select column_name from information_schema.columns where table_name='sacramental_ocia' and column_name='baptism_by_affidavit';` → 1 row.

### `migrations/20260619_confirmation_church_city_state.sql`  ⚠️ BLOCKING (proposed — awaiting approval)
Adds `sacramental_confirmation.confirmation_city` + `confirmation_state` (text),
matching First Communion's `communion_city/state`. The Confirmation Details section
now writes these (manual for an "Other" church; derived from the institution for a
listed one). **Blocking:** until applied, saving a Confirmation candidate fails
("column … does not exist"). Additive, idempotent, nullable — no data impact.
- Verify: `select count(*) from information_schema.columns where table_name='sacramental_confirmation' and column_name in ('confirmation_city','confirmation_state');` → 2.

### `migrations/20260619_ocia_cohort.sql`  ⚠️ RE-RUN needed (columns applied; CHECK relax pending)
Adds `sacramental_ocia.cohort_id` (uuid FK sacramental_cohorts) + `cohort_date`
(date), mirroring `sacramental_confirmation`, **and widens the
`sacramental_cohorts.panel` CHECK** from `('firstcomm','confirmation')` to include
`'ocia'` (without it, no OCIA cohort can be created). The column-adds already ran;
the CHECK relaxation was added after and still needs to run. The whole file is
idempotent (IF NOT EXISTS / DROP CONSTRAINT IF EXISTS + ADD), so **re-running it is
safe**. No data impact (sacramental_ocia empty).
- Verify cols: `select count(*) from information_schema.columns where table_name='sacramental_ocia' and column_name in ('cohort_id','cohort_date');` → 2.
- Verify CHECK: inserting `sacramental_cohorts(panel='ocia', cohort_date=…)` succeeds.

## ✅ Applied

### `migrations/20260619_annulment_marriage_location.sql`  ✅ applied (per user)
Adds `annulment_cases.marriage_state`, `marriage_country`, `marriage_county` (text)
and `non_church_wedding` (boolean default false). Verified: columns exist + full
create→save→viewer round-trip passed.

### `migrations/20260619_annulment_baptism_by_affidavit.sql`  ✅ applied (per user)
Adds `annulment_cases.petitioner_baptism_by_affidavit (boolean default false)`.
**Why it's blocking:** the Add/Edit save and the viewer's inline "By Affidavit" toggle
write this column. Until it exists, **every annulment case save fails** ("column …
does not exist"). Additive, idempotent, default false — no data impact.
- Verify: `select column_name from information_schema.columns where table_name='annulment_cases' and column_name='petitioner_baptism_by_affidavit';` → 1 row.

---

# Previously applied — ✅ all clear

Verified against the live schema on **2026-06-18**. Every earlier proposed/paused
migration has been applied (or was moot).

## Applied & verified

| Migration | Status |
|-----------|--------|
| `20260618_firstcomm_preparer.sql` | ✅ applied — `sacramental_firstcomm.preparer` exists |
| `20260618_couples_notes_log.sql` | ✅ applied — `couples.notes_log` exists |
| `20260618_annulments_preparer.sql` | ✅ applied — `annulment_cases.preparer` exists |
| `20260618_drop_preparation_responsible.sql` | ✅ applied — dropped on couples + all 4 `sacramental_*` |
| (annulments legacy column) | ✅ also dropped — `annulment_cases.preparation_responsible_id` gone; config fallback removed |
| `20260618_couples_records_placed.sql` | ✅ applied — `couples.records_placed` exists |
| `20260618_couples_wedding_complete.sql` | ✅ applied — `couples.wedding_complete` exists |
| `20260618_couples_officiant_preparer.sql` | ✅ applied — `couples.officiant` + `preparer` exist |
| `20260618_confirmation_preparer.sql` | ✅ applied — `sacramental_confirmation.preparer` exists |
| `20260618_institutions_address.sql` | ✅ applied — institution street/city/state/zip in use |
| `20260618_personnel_clergy.sql` | ✅ applied — `personnel.clergy` in use |
| `20260618_phone_normalize_backfill.sql` | ✅ run — stored phones normalized (idempotent; safe to re-run) |
| `20260618_couples_external_backfill.sql` | ✅ moot — 0 rows ever matched `marriage_type/status_code = 'external'` |

## Verify (should match the above)

```sql
select 'firstcomm.preparer' item, count(*) present from information_schema.columns where table_name='sacramental_firstcomm' and column_name='preparer'
union all select 'couples.notes_log',         count(*) from information_schema.columns where table_name='couples' and column_name='notes_log'
union all select 'annulment_cases.preparer',  count(*) from information_schema.columns where table_name='annulment_cases' and column_name='preparer'
union all select 'preparation_responsible (expect 0)', count(*) from information_schema.columns where column_name='preparation_responsible_id';
```

Expected: `firstcomm.preparer = 1`, `couples.notes_log = 1`,
`annulment_cases.preparer = 1`, `preparation_responsible = 0`.
