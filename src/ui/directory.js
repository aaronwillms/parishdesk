// ── Directory utilities ─────────────────────────────────────────────────────
import { store } from '../store.js';

// Parse the parish_settings single-string address ("Street, City, ST 12345")
// into parts — same regex the Admin > Parish Settings editor uses to round-trip it.
function _parseParishAddress(addr) {
  if (!addr) return { street: '', city: '', state: '', zip: '' };
  const m = String(addr).match(/^(.*?),\s*(.*?),\s*([A-Z]{2})\s*(\d{5})?$/);
  if (m) return { street: m[1].trim(), city: m[2].trim(), state: m[3].trim(), zip: (m[4] || '').trim() };
  return { street: String(addr).trim(), city: '', state: '', zip: '' };
}

// True when this institution is the parish's PRINCIPAL institution. Identified
// structurally via parish_settings.primary_institution (a configured name), not a
// hardcoded literal — matched against the institution's name.
function _isPrincipalInstitution(inst) {
  return !!inst?.name && inst.name === store.parishSettings?.primary_institution;
}

// Single source of truth for an institution's mailing ADDRESS. Resolution is
// encapsulated here so callers stay agnostic:
//   • PRINCIPAL institution → the canonical parish address from parish_settings
//     (set in Admin > Parish Settings). parish_settings ALWAYS wins for it, even
//     if its own institution row has address columns populated.
//   • every OTHER institution → its own row's street/city/state/zip.
// Returns the parts plus convenience `cityStateZip` / one-line `full`; `has` is
// true when any part is set. Unknown id → all-empty (has:false).
export function getInstitutionAddress(institutionId) {
  const inst = (store.institutions || []).find(i => i.id === institutionId) || {};
  const principal = _isPrincipalInstitution(inst);
  const a = principal
    ? _parseParishAddress(store.parishSettings?.address || '')
    : { street: inst.street || '', city: inst.city || '', state: inst.state || '', zip: inst.zip || '' };
  const cityStateZip = [[a.city, a.state].filter(Boolean).join(', '), a.zip].filter(Boolean).join(' ').trim();
  const full = [a.street, cityStateZip].filter(Boolean).join(', ');
  return { street: a.street, city: a.city, state: a.state, zip: a.zip, cityStateZip, full,
    has: !!(a.street || a.city || a.state || a.zip), source: principal ? 'parish_settings' : 'institution' };
}

// Whether an institution's address is the (read-only) parish address.
export function isPrincipalInstitution(institutionId) {
  return _isPrincipalInstitution((store.institutions || []).find(i => i.id === institutionId) || {});
}
