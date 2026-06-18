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
