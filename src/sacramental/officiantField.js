// ── Shared officiant dropdown (clergy-aware) ────────────────────────────────
// One reusable officiant picker for the per-record-officiant panels (Marriage
// now, Baptism later). Options: institution clergy (from
// directory.getInstitutionClergy, via the shared clergyNames helper) + an
// "Other…" free entry. Stored as a plain display-name string so it renders
// directly in the read view. Unlike the preparer field, there is NO coordinator
// option — an officiant is the minister of the rite, not a program coordinator.

import { clergyNames } from './preparerField.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Build the dropdown. `id` is the base element id; the free-entry input is
// `${id}-other`. `value` is the current saved officiant string. `onOtherChange`
// (optional) is an inline JS expression run on change in addition to toggling
// the free-entry input — e.g. Marriage uses it to show/hide its delegation row.
export function buildOfficiantField(id, value, { institutionId = null, label = 'Officiant', onOtherChange = '' } = {}) {
  const names = clergyNames(institutionId);
  const seen = new Set(names);
  const isOther = !!value && !seen.has(value);        // saved a custom name → "Other…"
  const optionHtml = names.map(n => `<option value="${esc(n)}"${value === n ? ' selected' : ''}>${esc(n)}</option>`).join('');
  return `<label>${esc(label)}</label>
    <select id="${esc(id)}" onchange="window._officiantToggleOther('${esc(id)}');${onOtherChange}">
      <option value="">— Select —</option>
      ${optionHtml}
      <option value="__other"${isOther ? ' selected' : ''}>Other…</option>
    </select>
    <div id="${esc(id)}-other-wrap" style="display:${isOther ? 'block' : 'none'};">
      <input type="text" id="${esc(id)}-other" placeholder="Officiant name" value="${esc(isOther ? value : '')}" />
    </div>`;
}

// Read the chosen officiant value from the DOM (null when blank).
export function readOfficiantValue(id) {
  const sel = document.getElementById(id);
  if (!sel) return null;
  if (sel.value === '__other') return (document.getElementById(`${id}-other`)?.value || '').trim() || null;
  return sel.value || null;
}

// True when the field is currently in "Other…" (free-entry) mode.
export function officiantIsOther(id) { return document.getElementById(id)?.value === '__other'; }

// One global toggle handler shared by every officiant field instance.
if (typeof window !== 'undefined' && !window._officiantToggleOther) {
  window._officiantToggleOther = (id) => {
    const sel = document.getElementById(id);
    const wrap = document.getElementById(`${id}-other-wrap`);
    if (sel && wrap) wrap.style.display = sel.value === '__other' ? 'block' : 'none';
  };
}
