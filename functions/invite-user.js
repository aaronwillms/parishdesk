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

  return new Response(JSON.stringify({ success: true }), { status: 200 });
}
