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

// Build-time (no DOM) resolved parish for a CREATE modal — used to seed the preparer
// field's Coordinators group before the parish <select> exists in the DOM:
//   • picker shown (create-on-All) → null (the user must choose; coords empty until then)
//   • else → the specific active tab, or the single accessible parish.
export function initialCreateParish(keys, panelKey) {
  if (shouldShowParishField(keys, panelKey)) return null;
  const tab = getActiveParishTab(panelKey);
  return (tab && tab !== 'all') ? tab : (accessibleParishesForSacrament(keys)[0]?.id ?? null);
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

// ── EDIT variant (reassign an existing record's parish) ─────────────────────
// Edit is NOT tab-scoped — the record already has a real parish, so the field shows
// whenever the user can see >1 parish (no 'all'-tab condition). NO placeholder and NO
// lockout: the record can be REASSIGNED but never blanked.
export function shouldShowParishFieldEdit(keys) {
  return accessibleParishesForSacrament(keys).length > 1;
}

// All accessible parishes; the record's current parish preselected. Uses its OWN id
// (distinct from the create field) so the create lockout/validate never watches it.
export function parishEditFieldHtml(keys, { selectId, currentParishId, onChange }) {
  const opts = accessibleParishesForSacrament(keys)
    .map(p => `<option value="${esc(p.id)}"${p.id === currentParishId ? ' selected' : ''}>${esc(p.display_name || p.parish_name || 'Parish')}</option>`).join('');
  return `<label>Parish</label>
    <select id="${esc(selectId)}"${onChange ? ` onchange="${onChange}"` : ''}>${opts}</select>`;
}

// Read the edit field's chosen parish on save → the (possibly reassigned) id. Returns
// null when the field isn't present (single-parish) so the caller leaves parish_id as-is.
export function readEditParish(selectId) {
  const el = document.getElementById(selectId);
  return el ? (el.value || null) : null;
}
