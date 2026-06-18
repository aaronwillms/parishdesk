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
// same values. Retrying an INSERT that actually reached the server would create a
// DUPLICATE row, and a "Load failed" can NOT prove the row never landed. So
// `kind:'insert'` DISABLES retries (single attempt; any error surfaces). Our
// inserts use DB-generated ids, so they are not duplicate-safe under retry; do
// not enable insert retries unless the insert is made idempotent (client id /
// upsert on a unique key) — out of scope here (no schema changes).

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

// Serialize writes per logical key so rapid checkbox toggles don't fire
// overlapping PATCHes (last-write-wins; keeps requests in order). Minimal, opt-in.
const _writeChains = new Map();
export function serializeWrite(key, fn) {
  const prev = _writeChains.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  _writeChains.set(key, next.finally(() => { if (_writeChains.get(key) === next) _writeChains.delete(key); }));
  return next;
}
