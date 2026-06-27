// Cloudflare Pages Function — sends a Supabase invite email to a new user.
// Set VITE_SUPA_URL and SUPABASE_SERVICE_KEY in Cloudflare Pages env.
const JSON_HEADERS = { 'Content-Type': 'application/json' };

export async function onRequestPost(context) {
  // Wrap everything so any unexpected throw returns a JSON error (never an opaque
  // unhandled 500). The original crash was response.json() throwing on a non-JSON
  // GoTrue error body, which masked GoTrue's real complaint.
  try {
    const { env, request } = context;
    const { email } = await request.json();

    if (!email) {
      return new Response(JSON.stringify({ error: 'Email required' }), { status: 400, headers: JSON_HEADERS });
    }

    const response = await fetch(`${env.VITE_SUPA_URL}/auth/v1/invite`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'apikey': env.SUPABASE_SERVICE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email }),
    });

    // Read the body as TEXT first so a non-JSON error body can never crash the parse.
    const raw = await response.text();
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }

    if (!response.ok) {
      // Surface GoTrue's ACTUAL error: prefer structured fields when the body parsed
      // as JSON, else fall back to the raw text (trimmed + truncated) so the real
      // reason reaches the UI/logs instead of an opaque "Network error".
      const errorMsg = (parsed && (parsed.message || parsed.msg || parsed.error_description || parsed.error))
        || (raw && raw.trim().slice(0, 500))
        || 'Invite failed';
      return new Response(JSON.stringify({ error: errorMsg }), { status: response.status, headers: JSON_HEADERS });
    }

    // On success the body is valid JSON: GoTrue's admin/invite returns the new auth
    // user object at the top level — the auth.users row exists NOW (invited_at set),
    // so the caller can write link/place/grant rows against this id immediately.
    const userId = parsed?.id || parsed?.user?.id || null;
    return new Response(JSON.stringify({ success: true, userId }), { status: 200, headers: JSON_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err?.message || 'Unexpected error' }), { status: 500, headers: JSON_HEADERS });
  }
}
