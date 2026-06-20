// ── Shared church→location model (Cohort manager + Details sections) ────────
// One coherent flow so cohort church pre-fill/lock, listed-vs-"Other" City/State,
// and cohort→student church inheritance compose without conflicting paths. Church
// address always resolves through getInstitutionAddress() (the same resolver the
// marriage file uses; principal → parish_settings). Used by First Communion and
// Confirmation now; OCIA Phase 2 will reuse it (see ARCHITECTURE.md).

import { getInstitutionAddress } from '../ui/directory.js';
import { store } from '../store.js';

const _esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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

// ── REUSABLE institution-dropdown → address autofill+grey ───────────────────
// Panel-agnostic primitive: given the selected dropdown value and the target
// address-field elements, it autofills each from the institution's stored address
// (always via getInstitutionAddress — principal resolves to parish_settings) and
// LOCKS it read-only; for "Other"/none/an address-less institution it clears +
// unlocks (editable). This is the shared behavior FC / Confirmation / OCIA consume
// — pass only the fields you have, by element OR id string. NOT hardcoded to any
// panel's markup conventions; the cohort flow below is one caller, not the impl.
//   fields:     { street?, city?, state? }  element or getElementById id (any subset)
//   otherValue: the dropdown sentinel meaning "manual entry" (default '__other')
// Returns { filled, address } so a caller can react (e.g. also fill its own street).
export function institutionAddressAutofill(value, fields = {}, { otherValue = '__other' } = {}) {
  const resolve = (f) => (typeof f === 'string' ? document.getElementById(f) : f) || null;
  const els = { street: resolve(fields.street), city: resolve(fields.city), state: resolve(fields.state) };
  const isOther = !value || value === otherValue;
  const a = isOther ? null : getInstitutionAddress(value);
  const set = (el, val, lock) => { if (!el) return; el.value = lock ? (val || '') : ''; setFieldLocked(el, lock); };
  if (a && a.has) {
    set(els.street, a.street, true);
    set(els.city, a.city, true);
    set(els.state, a.state, true);
    return { filled: true, address: a };
  }
  // "Other" / nothing selected / a listed institution with no stored address →
  // clear + unlock so the fields can be entered manually.
  set(els.street, '', false);
  set(els.city, '', false);
  set(els.state, '', false);
  return { filled: false, address: null };
}

// ── Institution dropdown helpers (text-stored church/school fields) ─────────
// Some sacrament fields store their church/school as TEXT (e.g. baptism_church,
// first_communion_church, school_name) with no institution_id column. These two
// helpers let such a field become an "institution dropdown + Other" while still
// round-tripping through its existing text column — the dropdown's option VALUES
// are institution ids (so institutionAddressAutofill can resolve the address),
// but the stored value is the institution NAME, and reselect-on-reopen matches by
// name. Panels with a real *_institution_id column keep using that id directly.

// Build the <option> list for an institution dropdown, preselecting the one whose
// NAME equals selectedName. Returns { options, isOther } — isOther is true when a
// non-empty stored name matches no institution (→ the caller marks "Other…" selected).
export function institutionOptionsHtml(selectedName) {
  const insts = store.institutions || [];
  const match = selectedName ? insts.find(i => i.name === selectedName) : null;
  const options = insts.map(i => `<option value="${i.id}"${match && match.id === i.id ? ' selected' : ''}>${_esc(i.name)}</option>`).join('');
  return { options, isOther: !!selectedName && !match };
}

// Resolve an institution <select>+Other to the church/school NAME to store in a
// text column: a listed institution → its name; '__other' → the free-text input;
// '' → null. (City/State/Street are read straight from the address fields, which
// institutionAddressAutofill keeps correct for both listed (locked, derived) and
// Other (manual).)
export function institutionSelectedName(selectValue, otherInputId, { otherValue = '__other' } = {}) {
  if (!selectValue) return null;
  if (selectValue === otherValue) return (document.getElementById(otherInputId)?.value || '').trim() || null;
  return (store.institutions || []).find(i => i.id === selectValue)?.name || null;
}

// On (re)load, lock+fill the address fields IF the <select> currently has a listed
// institution selected (the onchange only fires on user interaction, so a
// preselected listed institution needs this to render greyed/derived). No-op for
// '' / '__other' so a stored manual "Other" address is never cleared on reopen.
export function institutionAddressSync(selectId, fields, opts = {}) {
  const sel = document.getElementById(selectId);
  const otherValue = opts.otherValue || '__other';
  if (!sel || !sel.value || sel.value === otherValue) return;
  // Only lock+fill when the listed institution actually HAS an address. A listed
  // institution with no stored address is left untouched on reopen (so any
  // pre-existing manual City/State on the record is preserved, not cleared) — the
  // user's active onchange still clears+unlocks if they re-pick it deliberately.
  const a = getInstitutionAddress(sel.value);
  if (!a || !a.has) return;
  institutionAddressAutofill(sel.value, fields, opts);
}

// COHORT MANAGER church change. Toggles the "Other" church-name field, then
// delegates address autofill/lock to the shared institutionAddressAutofill above
// (city/state only — the cohort form carries no street field). `prefix` =
// 'coh' (Confirmation) | 'fcoh' (First Communion).
export function cohortChurchLocation(v, prefix) {
  const wrap = document.getElementById(`${prefix}-other-wrap`); if (wrap) wrap.style.display = v === '__other' ? 'block' : 'none';
  institutionAddressAutofill(v, { city: `${prefix}-city`, state: `${prefix}-state` });
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

// COHORT → FILE formation inheritance: default the file's "Person Responsible for
// Formation" dropdown to the cohort's preparer (default-but-editable, the same model
// as inheritCohortChurch). `preparerId` is the file form's preparer field id
// ('ff-preparer' | 'cf-preparer' | 'of-preparer'). A preparer not in the option list
// falls back to the "Other…" free-entry input, mirroring buildPreparerField.
export function inheritCohortFormation(coh, preparerId) {
  if (!coh || !coh.preparer) return;
  const sel = document.getElementById(preparerId); if (!sel) return;
  const name = coh.preparer;
  if ([...sel.options].some(o => o.value === name)) {
    sel.value = name;
  } else {
    sel.value = '__other';
    const other = document.getElementById(`${preparerId}-other`); if (other) other.value = name;
  }
  if (typeof window !== 'undefined' && window._preparerToggleOther) window._preparerToggleOther(preparerId);
}
