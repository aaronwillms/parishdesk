// ── Shared per-user card pins (card_pins) ───────────────────────────────────
// One module every shell panel uses to pin record cards to the top of its list.
// Pins are PER-USER (user_id is always the current user). Backed by card_pins
// (id, parish_id, user_id, record_type, record_id, created_at; UNIQUE(user_id,
// record_type, record_id)). parish_id defaults at the DB (current_parish_id()) —
// never passed from the client. Discernment keeps its own discernment_pins.
import { sb, deleteWithRetry, insertWithRetry } from '../supabase.js';
import { store } from '../store.js';

// record_type → Set<record_id> of the current user's pins for that type.
const _cache = new Map();

function _me() { return store.currentUserProfile?.user_id || null; }
function _set(recordType) {
  let s = _cache.get(recordType);
  if (!s) { s = new Set(); _cache.set(recordType, s); }
  return s;
}

// Load the current user's pins for a record_type into the cache (fail-safe: no user
// → empty, no pins shown). Called by the shell before rendering a pinnable list.
export async function loadPins(recordType) {
  const me = _me();
  const set = _set(recordType);
  set.clear();
  if (!me || !recordType) return;
  const { data } = await sb.from('card_pins')
    .select('record_id').eq('user_id', me).eq('record_type', recordType);
  (data || []).forEach(r => r.record_id && set.add(r.record_id));
}

export function isPinned(recordType, id) {
  return !!(recordType && id && _cache.get(recordType)?.has(id));
}

// Toggle a pin (delete/insert, mirroring discernment). Updates the cache so the
// caller can re-render immediately. No-op without a signed-in user.
export async function togglePin(recordType, id) {
  const me = _me();
  if (!me || !recordType || !id) return;
  const set = _set(recordType);
  if (set.has(id)) {
    const { error } = await deleteWithRetry(() => sb.from('card_pins').delete()
      .eq('user_id', me).eq('record_type', recordType).eq('record_id', id));
    if (error) { console.error('[pins] unpin failed:', error); return; }
    set.delete(id);
  } else {
    const { error } = await insertWithRetry('card_pins', { user_id: me, record_type: recordType, record_id: id });
    if (error) { console.error('[pins] pin failed:', error); return; }
    set.add(id);
  }
}
