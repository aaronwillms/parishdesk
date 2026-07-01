// ── Shared preparer dropdown (clergy-aware) ─────────────────────────────────
// One reusable field so every initiation panel builds its preparer picker the same
// way. Options:
//   • institution clergy (from personnel.clergy) — parish-wide, unchanged
//   • the panel's sacramental coordinator(s) — scoped to the SELECTED parish, and
//     live-repopulated when the parish selection changes (window._preparerRepopulateCoords)
//   • "Other…" free-entry, with a native <datalist> typeahead over directory names
// The stored value is a plain display-name string, so it renders directly in the read view.

import { store } from '../store.js';
import { coordinatorNamesForParish } from '../ui/coordinator.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const _dedupe = (arr) => [...new Set((arr || []).filter(Boolean))];

// Clergy NAMES for the dropdowns. Clergy is a parish-wide, person-level boolean
// (personnel.clergy). `institutionId` kept for signature stability but unused.
export function clergyNames(_institutionId = null) {
  return _dedupe((store.personnel || []).filter(p => p.clergy && p.name).map(p => p.name))
    .sort((a, b) => a.localeCompare(b));
}

// Directory NAMES for the "+ Other" typeahead datalist (all personnel, deduped).
function _directoryNames() {
  return _dedupe((store.personnel || []).map(p => p.name)).sort((a, b) => a.localeCompare(b));
}

// The Coordinators <optgroup> inner HTML for a parish — deduped and excluding names
// already offered under Clergy. `value` marks the current selection.
function _coordOptionsHtml(prog, parishId, value) {
  const clergy = new Set(clergyNames());
  const coords = _dedupe(prog ? coordinatorNamesForParish(prog, parishId) : []).filter(n => !clergy.has(n));
  return coords.map(n => `<option value="${esc(n)}"${value === n ? ' selected' : ''}>${esc(n)}</option>`).join('');
}

// Build the dropdown HTML. `id` is the base element id; the free-entry input is
// `${id}-other`. `value` is the current saved preparer string.
//   prog             — coordinator.js program key (scopes the Coordinators group)
//   initialParishId  — the parish to populate coordinators for at build time (edit:
//                      the record's parish; create-specific/single: the resolved parish;
//                      create-on-All: null → empty until the user picks)
export function buildPreparerField(id, value, { institutionId = null, coordinatorNames = [], label = 'Preparer', prog = null, initialParishId = null } = {}) {
  const clergy = clergyNames(institutionId);
  const coords = _dedupe(prog ? coordinatorNamesForParish(prog, initialParishId) : coordinatorNames)
    .filter(n => !clergy.includes(n));

  const known = new Set([...clergy, ...coords]);
  const isKnown = value && known.has(value);
  const isOther = !!value && !isKnown;          // saved a custom name → "Other…"

  const optOf = (n) => `<option value="${esc(n)}"${value === n ? ' selected' : ''}>${esc(n)}</option>`;
  const clergyOpts = clergy.map(optOf).join('');
  const coordOpts = coords.map(optOf).join('');
  const dirOpts = _directoryNames().map(n => `<option value="${esc(n)}"></option>`).join('');

  return `<label>${esc(label)}</label>
    <select id="${esc(id)}" onchange="window._preparerToggleOther('${esc(id)}')">
      <option value="">— Select —</option>
      ${clergyOpts ? `<optgroup label="Clergy">${clergyOpts}</optgroup>` : ''}
      <optgroup label="Coordinators" id="${esc(id)}-coord-group">${coordOpts}</optgroup>
      <option value="__other"${isOther ? ' selected' : ''}>Other…</option>
    </select>
    <div id="${esc(id)}-other-wrap" style="display:${isOther ? 'block' : 'none'};">
      <input type="text" id="${esc(id)}-other" list="${esc(id)}-dir" placeholder="Name" value="${esc(isOther ? value : '')}" autocomplete="off" />
    </div>
    <datalist id="${esc(id)}-dir">${dirOpts}</datalist>`;
}

// Read the chosen preparer value from the DOM (null when blank).
export function readPreparerValue(id) {
  const sel = document.getElementById(id);
  if (!sel) return null;
  if (sel.value === '__other') return (document.getElementById(`${id}-other`)?.value || '').trim() || null;
  return sel.value || null;
}

// One global toggle handler shared by every preparer field instance.
if (typeof window !== 'undefined' && !window._preparerToggleOther) {
  window._preparerToggleOther = (id) => {
    const sel = document.getElementById(id);
    const wrap = document.getElementById(`${id}-other-wrap`);
    if (sel && wrap) wrap.style.display = sel.value === '__other' ? 'block' : 'none';
  };
}

// Live re-population of ONLY the Coordinators <optgroup> when the parish changes.
// Clergy, "Other…", the -other input, and the datalist are left untouched. The current
// selection is preserved: if the previously-selected name is no longer among the rebuilt
// options (e.g. it was the old parish's coordinator, or an edited record's saved
// preparer), it is re-added as a selected option so the value is never wiped.
if (typeof window !== 'undefined' && !window._preparerRepopulateCoords) {
  window._preparerRepopulateCoords = (id, prog, parishId) => {
    const sel = document.getElementById(id);
    const group = document.getElementById(`${id}-coord-group`);
    if (!sel || !group) return;
    const prev = sel.value;                       // preserve current selection
    group.innerHTML = _coordOptionsHtml(prog, parishId, prev);
    if (prev && prev !== '__other' && !Array.from(sel.options).some(o => o.value === prev)) {
      // Orphaned selection (old-parish coord / record's saved preparer) → keep it.
      group.insertAdjacentHTML('beforeend', `<option value="${esc(prev)}">${esc(prev)}</option>`);
    }
    sel.value = prev;                             // re-assert (option now exists)
    window._preparerToggleOther(id);              // keep the -other wrap in sync
  };
}
