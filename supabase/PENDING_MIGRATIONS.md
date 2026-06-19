# Pending migrations — run checklist

Status as of a live schema probe on **2026-06-18**. Run the **Pending** items below
in order in the **Supabase SQL editor** (Project → SQL editor → paste the file's
contents → Run). Each is idempotent (`IF [NOT] EXISTS`), so re-running is safe.

After each, the "Verify" query should return what's noted.

---

## ▶ Pending — run these

### 1. `migrations/20260618_firstcomm_preparer.sql`  ⚠️ BLOCKING
Adds `sacramental_firstcomm.preparer (text)`.
**Why it's urgent:** First Communion **Add/Edit currently FAILS to save** — the
"Person Responsible for Formation" field writes `preparer`, and the column is
missing (`ADD COLUMN IF NOT EXISTS preparer text`).
- Verify: `select column_name from information_schema.columns where table_name='sacramental_firstcomm' and column_name='preparer';` → 1 row.

### 2. `migrations/20260618_couples_notes_log.sql`  ⚠️ BLOCKING
Adds `couples.notes_log (jsonb not null default '[]')`.
**Why:** adding a **note to a Marriage file currently fails** ("Could not find the
'notes_log' column"). Every other sacrament table already has it.
- Verify: `select column_name from information_schema.columns where table_name='couples' and column_name='notes_log';` → 1 row.

### 3. `migrations/20260618_annulments_preparer.sql`  ⚠️ BLOCKING
Adds `annulment_cases.preparer (text)`.
**Why it's urgent:** the Annulments Phase-2 edit form's "Person Responsible for
Formation" field writes `preparer` (shared helper, consolidation standard); the
column is missing, so **an annulment case Save fails** until this runs. The read
view falls back to the legacy `preparation_responsible_id` FK for pre-existing rows.
- Verify: `select column_name from information_schema.columns where table_name='annulment_cases' and column_name='preparer';` → 1 row.

### 4. `migrations/20260618_drop_preparation_responsible.sql`  🧹 cleanup
Drops the now-dead `preparation_responsible_id` + `preparation_responsible_override`
on `couples`, `sacramental_baptism`, `sacramental_firstcomm`,
`sacramental_confirmation`, `sacramental_ocia`. The app no longer reads or writes
them (replaced by the single `preparer` field); audited as 0 non-null. Pure cleanup
— safe any time, not blocking.
- Verify: `select count(*) from information_schema.columns where column_name='preparation_responsible_id';` → 0.

### 4. `migrations/20260618_phone_normalize_backfill.sql`  🔧 data, optional
One-time normalization of stored phone numbers to a consistent format across
personnel + sacramental tables. Idempotent; safe to run (or re-run). Nice-to-have,
not blocking.
- Verify: no error; phone columns read back normalized.

---

## ✅ Already applied / not needed (no action)

Confirmed present in the live DB, or moot:

| File | Status |
|------|--------|
| `20260618_couples_records_placed.sql` | applied (`couples.records_placed` exists) |
| `20260618_couples_wedding_complete.sql` | applied (`couples.wedding_complete` exists) |
| `20260618_couples_officiant_preparer.sql` | applied (`couples.officiant` + `couples.preparer` exist) |
| `20260618_confirmation_preparer.sql` | applied (`sacramental_confirmation.preparer` exists) |
| `20260618_institutions_address.sql` | applied (institution street/city/state/zip in use) |
| `20260618_personnel_clergy.sql` | applied (`personnel.clergy` in use) |
| `20260618_couples_external_backfill.sql` | **moot** — 0 rows match `marriage_type='external'` / `status_code='external'` (already healed) |

Other `20260617*` / `20260618_hr_*` / rebuild files were applied earlier in the build-out.

---

## Quick all-in-one verify

Run this to see the state of the four pending items at a glance:

```sql
select 'firstcomm.preparer'        as item, count(*) as present from information_schema.columns where table_name='sacramental_firstcomm' and column_name='preparer'
union all select 'couples.notes_log',        count(*) from information_schema.columns where table_name='couples' and column_name='notes_log'
union all select 'preparation_responsible (should be 0 after drop)', count(*) from information_schema.columns where column_name='preparation_responsible_id';
```

Expected after running items 1–3: `firstcomm.preparer = 1`, `couples.notes_log = 1`,
`preparation_responsible = 0`.
