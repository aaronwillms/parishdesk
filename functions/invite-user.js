// Cloudflare Pages Function — sends a Supabase invite email to a new user.
// Set VITE_SUPA_URL and SUPABASE_SERVICE_KEY in Cloudflare Pages env.
export async function onRequestPost(context) {
  const { env, request } = context;
  const { email } = await request.json();

  if (!email) {
    return new Response(JSON.stringify({ error: 'Email required' }), { status: 400 });
  }

  const response = await fetch(`${env.VITE_SUPA_URL}/auth/v1/admin/invite`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email }),
  });

  const data = await response.json();

  if (!response.ok) {
    return new Response(JSON.stringify({ error: data.message || 'Invite failed' }), { status: response.status });
  }

  // GoTrue's admin/invite returns the new auth user object at the top level — the
  // auth.users row exists NOW (invited_at set), so the caller can write
  // link/place/grant rows against this id immediately (no holding mechanism).
  const userId = data?.id || data?.user?.id || null;
  return new Response(JSON.stringify({ success: true, userId }), { status: 200 });
}
