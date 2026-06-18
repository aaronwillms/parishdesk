// ── Shared preparer dropdown (clergy-aware) ─────────────────────────────────
// One reusable field so every initiation panel (First Communion now,
// Confirmation later) builds its preparer picker the same way. Options:
//   • institution clergy (from directory.getInstitutionClergy)
//   • the panel's sacramental coordinator(s) — supplied by the caller
//   • "Other…" free-entry
// The stored value is a plain display-name string, so it renders directly in the
// read view. The caller supplies its own coordinator source; never hand-rolled.

import { store } from '../store.js';
import { getInstitutionClergy } from '../ui/directory.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Clergy NAMES across one institution, or all institutions (deduped, sorted).
export function clergyNames(institutionId = null) {
  const insts = institutionId ? [{ id: institutionId }] : (store.institutions || []);
  const names = new Set();
  insts.forEach(i => getInstitutionClergy(i.id).forEach(p => { if (p.name) names.add(p.name); }));
  return [...names].sort((a, b) => a.localeCompare(b));
}

// Build the dropdown HTML. `id` is the base element id; the free-entry input is
// `${id}-other`. `value` is the current saved preparer string.
export function buildPreparerField(id, value, { institutionId = null, coordinatorNames = [], label = 'Preparer' } = {}) {
  const opts = [];
  const seen = new Set();
  const add = (n) => { if (n && !seen.has(n)) { seen.add(n); opts.push(n); } };
  clergyNames(institutionId).forEach(add);
  coordinatorNames.forEach(add);

  const isKnown = value && seen.has(value);
  const isOther = !!value && !isKnown;          // saved a custom name → "Other…"
  const optionHtml = opts.map(n => `<option value="${esc(n)}"${value === n ? ' selected' : ''}>${esc(n)}</option>`).join('');
  return `<label>${esc(label)}</label>
    <select id="${esc(id)}" onchange="window._preparerToggleOther('${esc(id)}')">
      <option value="">— Select —</option>
      ${optionHtml}
      <option value="__other"${isOther ? ' selected' : ''}>Other…</option>
    </select>
    <div id="${esc(id)}-other-wrap" style="display:${isOther ? 'block' : 'none'};">
      <input type="text" id="${esc(id)}-other" placeholder="Name" value="${esc(isOther ? value : '')}" />
    </div>`;
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
