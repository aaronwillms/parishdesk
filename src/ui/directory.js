// ── Directory utilities ─────────────────────────────────────────────────────
import { store } from '../store.js';

// Single source of truth for an institution's CLERGY contacts, driven by the
// manual personnel.clergy boolean (set in the Add/Edit Person dialog).
// The sacramental panels' clergy-aware dropdowns (e.g. Officiant) will consume
// this in a later task — it is intentionally NOT wired into any dropdown yet.
//
// `institutionId` is an institutions.id; personnel.institution stores the
// institution NAME, so we resolve id → name first. Returns name-sorted contacts.
export function getInstitutionClergy(institutionId) {
  const inst = (store.institutions || []).find(i => i.id === institutionId);
  if (!inst) return [];
  return (store.personnel || [])
    .filter(p => p.clergy && p.institution === inst.name)
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

// Single source of truth for an institution's mailing ADDRESS (street/city/state
// /zip), stored on the institution record and edited in the Directory's
// institution create/settings dialog. Sacrament file address display reads this.
// Returns the address parts plus convenience `cityStateZip` / one-line `full`
// strings; `has` is true when any part is set. Unknown id → all-empty (has:false).
export function getInstitutionAddress(institutionId) {
  const inst = (store.institutions || []).find(i => i.id === institutionId) || {};
  const street = inst.street || '';
  const city   = inst.city   || '';
  const state  = inst.state  || '';
  const zip    = inst.zip    || '';
  const cityStateZip = [[city, state].filter(Boolean).join(', '), zip].filter(Boolean).join(' ').trim();
  const full = [street, cityStateZip].filter(Boolean).join(', ');
  return { street, city, state, zip, cityStateZip, full, has: !!(street || city || state || zip) };
}
