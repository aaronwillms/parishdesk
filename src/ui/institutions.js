import { sb } from '../supabase.js';
import { store } from '../store.js';

// Create an institution and its single permanent root position in one call.
//
// Factored out of personnel.js saveInstitution (which was DOM-coupled) so the
// Admin → Parish Settings "Add Parish" flow reuses the EXACT same two-insert
// pattern instead of duplicating it:
//   1. insert the institution row
//   2. insert its one root position (parent_position_id NULL, is_administrator)
//
// rootTitle defaults to the directory's 'Root Administrator'; a parish passes
// 'Pastor'. parishId, when given, scopes the institution to a parish
// (institutions.parish_id) — the directory flow omits it (parish_id stays NULL,
// behavior unchanged). Returns { id } on success or { id?, error } on failure so
// callers can surface the message exactly as before.
export async function createInstitutionWithRoot({
  name,
  parishId  = null,
  rootTitle = 'Root Administrator',
  icon      = 'fa-building',
  street    = null,
  city      = null,
  state     = null,
  zip       = null,
} = {}) {
  // Append to the end of the global parish-wide order (same rule as before).
  const nextOrder = (store.institutions || []).reduce((m, i) => Math.max(m, i.sort_order ?? 0), -1) + 1;

  const insertRow = { name, icon, sort_order: nextOrder, street, city, state, zip };
  if (parishId) insertRow.parish_id = parishId;

  const { data, error } = await sb.from('institutions').insert(insertRow).select('id').single();
  if (error) return { error };

  // Every institution gets exactly one permanent root position automatically.
  // positions.parish_id is NOT NULL with DEFAULT current_parish_id() (the CURRENT/
  // admin's parish). For directory institutions that default is correct, so we omit
  // it. But for Add-Parish the root must belong to the NEW parish — so when parishId
  // is given we stamp it explicitly; otherwise the new parish's tree root would be
  // mis-tagged to the admin's parish.
  const posRow = { institution_id: data.id, title: rootTitle, parent_position_id: null, is_administrator: true };
  if (parishId) posRow.parish_id = parishId;
  const { error: posErr } = await sb.from('positions').insert(posRow);
  if (posErr) return { id: data.id, error: posErr };

  return { id: data.id };
}
