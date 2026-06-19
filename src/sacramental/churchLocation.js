// ── Shared church→location model (Cohort manager + Details sections) ────────
// One coherent flow so cohort church pre-fill/lock, listed-vs-"Other" City/State,
// and cohort→student church inheritance compose without conflicting paths. Church
// address always resolves through getInstitutionAddress() (the same resolver the
// marriage file uses; principal → parish_settings). Used by First Communion and
// Confirmation now; OCIA Phase 2 will reuse it (see ARCHITECTURE.md).

import { getInstitutionAddress } from '../ui/directory.js';

// Lock/unlock a field: text input → readOnly, <select> → disabled, with a muted
// read-only cue. (Disabled selects + readonly inputs still expose .value to save.)
export function setFieldLocked(el, locked) {
  if (!el) return;
  if (el.tagName === 'SELECT') el.disabled = locked; else el.readOnly = locked;
  // Theme-safe lock cue (no hardcoded light bg, so it reads correctly in dark mode):
  // dim + not-allowed cursor; the field keeps its own (theme-aware) background.
  el.style.opacity = locked ? '0.6' : '';
  el.style.cursor = locked ? 'not-allowed' : '';
}

// COHORT MANAGER church change. Toggles the "Other" church-name field; for a LISTED
// church that has a stored address, pre-fills + LOCKS city/state (read-only) via
// getInstitutionAddress; a listed church with no address (or "Other"/none) leaves
// them editable. `prefix` = 'coh' (Confirmation) | 'fcoh' (First Communion).
export function cohortChurchLocation(v, prefix) {
  const other = v === '__other';
  const wrap = document.getElementById(`${prefix}-other-wrap`); if (wrap) wrap.style.display = other ? 'block' : 'none';
  const cityEl = document.getElementById(`${prefix}-city`), stateEl = document.getElementById(`${prefix}-state`);
  const a = (!other && v) ? getInstitutionAddress(v) : null;
  if (a && a.has) {
    if (cityEl) cityEl.value = a.city || '';
    if (stateEl) stateEl.value = a.state || '';
    setFieldLocked(cityEl, true); setFieldLocked(stateEl, true);
  } else {
    if (cityEl) cityEl.value = '';
    if (stateEl) stateEl.value = '';
    setFieldLocked(cityEl, false); setFieldLocked(stateEl, false);
  }
}

// DETAILS section church change. City/State live INSIDE `${prefix}-church-other-wrap`
// and therefore show ONLY when "Other" is chosen — a listed church derives its
// location from the institution (not manually entered). `prefix` = 'cf' | 'ff'.
export function detailsChurchToggle(v, prefix) {
  const wrap = document.getElementById(`${prefix}-church-other-wrap`);
  if (wrap) wrap.style.display = v === '__other' ? 'block' : 'none';
}

// Resolve the city/state to STORE for a Details church on save: manual inputs for
// "Other", else derived from the listed institution (so the read view stays correct).
// `cityId`/`stateId` are the "Other" manual-input element ids.
export function detailsCityState(churchSel, cityId, stateId) {
  const val = (id) => (document.getElementById(id)?.value || '').trim() || null;
  if (churchSel === '__other') return { city: val(cityId), state: val(stateId) };
  if (churchSel) { const a = getInstitutionAddress(churchSel); return { city: a.city || null, state: a.state || null }; }
  return { city: null, state: null };
}

// COHORT → DETAILS inheritance: default the Details church dropdown to the cohort's
// church (editable per-student). `prefix` = 'cf' | 'ff'. Fills the "Other" override +
// city/state from the cohort when the cohort church is a non-listed ("Other") one.
export function inheritCohortChurch(coh, prefix) {
  if (!coh) return;
  const sel = document.getElementById(`${prefix}-church`); if (!sel) return;
  if (coh.church_institution_id && [...sel.options].some(o => o.value === coh.church_institution_id)) {
    sel.value = coh.church_institution_id;
    detailsChurchToggle(coh.church_institution_id, prefix);
  } else if (coh.church_override) {
    sel.value = '__other';
    detailsChurchToggle('__other', prefix);
    const ov = document.getElementById(`${prefix}-church-override`); if (ov) ov.value = coh.church_override;
    const ce = document.getElementById(`${prefix}-ccity`), se = document.getElementById(`${prefix}-cstate`);
    if (ce) ce.value = coh.church_city || '';
    if (se) se.value = coh.church_state || '';
  }
}
