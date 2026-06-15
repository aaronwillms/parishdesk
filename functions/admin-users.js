// Cloudflare Pages Function — returns all Supabase auth users (id + email).
// Set VITE_SUPA_URL and SUPABASE_SERVICE_KEY in Cloudflare Pages → Settings → Environment Variables.
export async function onRequestGet(context) {
  const supaUrl = context.env.VITE_SUPA_URL;
  const serviceKey = context.env.SUPABASE_SERVICE_KEY;

  if (!serviceKey || !supaUrl) {
    return new Response(JSON.stringify({ error: 'Server not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const res = await fetch(`${supaUrl}/auth/v1/admin/users?per_page=1000`, {
    headers: {
      'Authorization': `Bearer ${serviceKey}`,
      'apikey': serviceKey,
    },
  });

  if (!res.ok) {
    const msg = await res.text();
    return new Response(JSON.stringify({ error: msg }), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = await res.json();
  const users = (body.users || []).map(u => ({ id: u.id, email: u.email || null }));

  return new Response(JSON.stringify({ users }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
