# Pending Migrations

These migrations are written but NOT yet applied. Apply each once in the Supabase
SQL editor, then mark it done here.

## 🚧 BLOCKING — `20260619_annulment_baptismal_status.sql`

Adds, to `annulment_cases`:
- **Petitioner** baptismal-status booleans: `pet_bap_catholic`, `pet_bap_noncatholic`,
  `pet_bap_became_catholic`, `pet_bap_ocia`, `pet_bap_never`, `pet_bap_nonreligious`
- **Respondent** baptismal-status booleans: `resp_bap_catholic`, `resp_bap_noncatholic`,
  `resp_bap_became_catholic`, `resp_bap_ocia`, `resp_bap_never`, `resp_bap_nonreligious`
- **Respondent** baptism location: `respondent_baptism_church`, `respondent_baptism_city`,
  `respondent_baptism_state`, `respondent_baptism_country`, `respondent_baptism_by_affidavit`

All additive / idempotent / nullable or default-false — **no data destroyed**. The
annulment baptismal-status + respondent-baptism form features depend on these columns;
until applied, those checkboxes/fields will read/write columns that don't exist yet.
