// ── Shared parish picker for the CREATE forms (orphan guard) ────────────────
// One reusable field so every prep panel's create modal injects the same parish
// <select> + Save-lockout. Shown ONLY when the user is on the "All" tab with >1
// accessible parish (the caller ANDs in create-not-edit). When shown, Save stays
// disabled until a parish is chosen; when hidden, the record stamps the resolved
// parish silently. Mirrors preparerField.js (a labeled control styled by .modal CSS).
import { accessibleParishesForSacrament } from '../roles.js';
import { getActiveParishTab } from './panelShell.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Show the field iff the user can see >1 parish AND is on the "All" tab. The caller
// adds (!isEdit && !inline) so it only ever appears in the create modal.
export function shouldShowParishField(keys, panelKey) {
  return accessibleParishesForSacrament(keys).length > 1
      && getActiveParishTab(panelKey) === 'all';
}

// The labeled <select> markup (field only — the caller decides whether to include it).
// First option is an unselectable placeholder so the lockout holds until a real pick.
export function parishCreateFieldHtml(keys, { selectId, onChange }) {
  const opts = accessibleParishesForSacrament(keys)
    .map(p => `<option value="${esc(p.id)}">${esc(p.display_name || p.parish_name || 'Parish')}</option>`).join('');
  return `<label>Parish <span style="color:var(--cardinal);">*</span></label>
    <select id="${esc(selectId)}"${onChange ? ` onchange="${onChange}"` : ''}>
      <option value="" selected disabled>Select a parish…</option>
      ${opts}
    </select>`;
}

// Single source of truth for the create stamp. Keyed off the field's DOM presence:
//   field present (shown) → the chosen value (null only if unchosen — lockout prevents save)
//   specific parish tab   → that parish id
//   else (single parish)  → the one accessible parish — NOT getSelectedParish's home-fallback
//                           (correct for a single-parish user whose parish != home).
export function resolveCreateParish(keys, panelKey, selectId) {
  const el = document.getElementById(selectId);
  if (el) return el.value || null;
  const tab = getActiveParishTab(panelKey);
  if (tab && tab !== 'all') return tab;
  return accessibleParishesForSacrament(keys)[0]?.id ?? null;
}

// Lockout predicate. Keyed off DOM presence so it governs ONLY the parish field:
//   field not present (hidden / edit / single-parish) → true (nothing to pick)
//   field present → a parish chosen?
export function parishFieldValid(_keys, _panelKey, selectId) {
  const el = document.getElementById(selectId);
  if (!el) return true;
  return !!el.value;
}
