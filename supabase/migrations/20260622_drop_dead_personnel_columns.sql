-- ═══════════════════════════════════════════════════════════════════════════
-- Cleanup: drop the dead personnel columns left over from the HR Stage 1 collapse.
--   personnel.institution  (name-link → replaced by HR positions.institution_id)
--   personnel.type         (clergy/pastor logic → replaced by personnel.clergy + the
--                           HR org tree's Pastor/Rector position)
--   personnel.employment   (→ replaced by person_positions.employment_type)
--
-- PROPOSED — pause for approval before applying. Not a new table → no RLS-disable step.
--
-- DIAGNOSIS (confirmed by codebase search): after this cleanup NOTHING reads or
-- writes these three columns. The former readers were migrated off them:
--   • navigation.renderMinistryNav + institutionDashboard  → store.personnelByInstitutionId
--     (HR-derived person→institution, built in loadPersonnel from person_positions)
--   • hr.resolveEffectiveSupervisor pastor backstop          → Pastor/Rector position occupant
--   • baptism/ocia clergyPersonnel                           → personnel.clergy only
--   • coordinator subtitle / contactPicker subtitle          → personTitle() (HR titles)
--   • directory.getInstitutionClergy, marriage.clergyPersonnel → removed (dead code)
--   • teamDashboard._isAutoSyncedMember                      → is_protected only
-- The writers were removed too: contactPicker quick-add, personnel-add (the type='staff'
-- seed), and the institution-rename/delete cascades in hr.js / personnel.js.
--
-- ⚠️ ORDERING: apply this BEFORE (or together with) deploying the code that stops
-- seeding personnel.type. `type` may be NOT NULL, and the add-person path no longer
-- supplies it — so without this migration a new-person insert would fail. The DROP
-- NOT NULL below makes inserts safe immediately on apply; the DROP COLUMNs then remove
-- the columns entirely.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE personnel ALTER COLUMN type DROP NOT NULL;       -- safety for the deploy window
ALTER TABLE personnel DROP COLUMN IF EXISTS type;
ALTER TABLE personnel DROP COLUMN IF EXISTS institution;
ALTER TABLE personnel DROP COLUMN IF EXISTS employment;
