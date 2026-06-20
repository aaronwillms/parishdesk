import { createClient } from '@supabase/supabase-js';
export const sb = createClient(import.meta.env.VITE_SUPA_URL, import.meta.env.VITE_SUPA_KEY);

// ── Write retry (transport-layer failures only) ─────────────────────────────
// Supabase WRITES bypass the service worker (its Supabase cache route is GET
// only), so a transient network blip surfaces as a WebKit "TypeError: Load
// failed" with the request never completing. This wraps a write and retries
// ONLY such transport failures.
//
// SAFETY BOUNDARY (the whole point of this helper):
//   • transport failure → the request never got an HTTP answer: a thrown fetch
//     error (TypeError "Load failed" / "Failed to fetch") or a result with no
//     HTTP status (status 0) and no PostgREST error code. The server never
//     processed it, so re-sending is safe → RETRY.
//   • real error → HTTP 4xx/5xx with a PostgREST/Postgres error (a status ≥ 400
//     is present, or error.code is set). The server answered → surface
//     IMMEDIATELY, NEVER retry (must not re-fire validation/constraint errors).
//   • when ambiguous → treated as a REAL error (no retry), to avoid duplicates.
//
// INSERT CAUTION: retrying an UPDATE (.update().eq(id)) is idempotent — same row,
// same values. A naive INSERT retry would create a DUPLICATE row, since a "Load
// failed" can NOT prove the row never landed. `kind:'insert'` on withWriteRetry
// therefore DISABLES retries. For a duplicate-SAFE retryable insert use
// insertWithRetry() below, which makes the insert idempotent via a client-generated
// primary key (a landed-then-lost first attempt becomes a 23505 we treat as success).

function _isTransportFailure(error, status) {
  if (!error) return false;
  if (typeof status === 'number' && status >= 400) return false;   // server answered → real
  if (error.code) return false;                                     // PostgREST/PG code → answered → real
  const msg = String(error.message || error || '');
  if (/load failed|failed to fetch|network\s?error|networkrequestfailed|the network connection was lost|connection (was )?(lost|refused|reset)|timed?\s?out|err_network|err_connection|err_internet/i.test(msg)) return true;
  if (status === 0) return true;                                    // postgrest-js sets status 0 on fetch failure
  return false;                                                     // ambiguous → treat as REAL (do not retry)
}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `runQuery` MUST be a thunk that builds a FRESH query on each call — a Supabase
// builder executes once when awaited, so a retry needs a new builder. Returns the
// Supabase result `{ data, error, status, … }` (the error is surfaced as today).
export async function withWriteRetry(runQuery, { kind = 'update', attempts = 3, baseDelay = 300 } = {}) {
  const maxAttempts = kind === 'insert' ? 1 : attempts;            // inserts never retry (dup-write risk)
  let result;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      result = await runQuery();
    } catch (thrown) {
      result = { data: null, error: thrown, status: 0 };           // a thrown/rejected fetch = transport
    }
    if (!result.error) return result;                              // success
    if (attempt >= maxAttempts) return result;                    // out of attempts → surface
    if (!_isTransportFailure(result.error, result.status)) return result;   // real error → surface now
    await _sleep(baseDelay * attempt);                            // 300ms, 600ms, 900ms…
  }
  return result;
}

// Is this a unique-violation (23505) on OUR client-generated primary key? After a
// transport retry, that can only mean the EARLIER attempt actually landed the row
// (a fresh random uuid can't collide with a pre-existing row), so it is a success.
function _isOwnPkViolation(error, id) {
  if (!error || error.code !== '23505') return false;
  const blob = `${error.message || ''} ${error.details || ''}`;
  return /pkey|primary key/i.test(blob) || (!!id && blob.includes(id));
}

const _uuid = () => (typeof crypto !== 'undefined' && crypto.randomUUID)
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;

// Duplicate-SAFE retryable INSERT (single row). Generates a client-side primary key
// so every retry re-sends the SAME id; thus a transient transport blip is retried
// transparently and AT MOST ONE row ever lands:
//   • transport failure (Load failed / status 0) → retry with the same id
//   • success → return the row (data is the selected row object)
//   • 23505 on our own PK after a retry → the first attempt landed → return success
//   • any other real error (incl. a genuine first-attempt unique violation) → surface
// Returns a Supabase-shaped { data, error, status } where data is the row (or null).
export async function insertWithRetry(table, payload, { attempts = 3, baseDelay = 300, select = 'id' } = {}) {
  const row = { ...payload };
  if (!row.id) row.id = _uuid();              // fixed across retries → idempotent
  const id = row.id;
  let result;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      result = await sb.from(table).insert(row).select(select).maybeSingle();
    } catch (thrown) {
      result = { data: null, error: thrown, status: 0 };   // thrown fetch = transport
    }
    if (!result.error) return result;                                   // success
    if (attempt > 1 && _isOwnPkViolation(result.error, id)) {           // our row already landed
      const back = await sb.from(table).select(select).eq('id', id).maybeSingle();
      return { data: back.data || { id }, error: null, status: 200, idempotentRecovery: true };
    }
    if (attempt >= attempts) return result;                            // out of attempts → surface
    if (!_isTransportFailure(result.error, result.status)) return result;  // real error → surface now
    await _sleep(baseDelay * attempt);
  }
  return result;
}

// Serialize writes per logical key so rapid checkbox toggles don't fire
// overlapping PATCHes (last-write-wins; keeps requests in order). Minimal, opt-in.
const _writeChains = new Map();
export function serializeWrite(key, fn) {
  const prev = _writeChains.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  _writeChains.set(key, next.finally(() => { if (_writeChains.get(key) === next) _writeChains.delete(key); }));
  return next;
}
