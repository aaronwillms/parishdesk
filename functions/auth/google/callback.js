export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state'); // user_id passed through state param

  if (!code || !state) {
    return new Response('Missing code or state', { status: 400 });
  }

  // Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri:  'https://parishdesk.pages.dev/auth/google/callback',
      grant_type:    'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    console.error('[google/callback] token exchange failed:', err);
    return Response.redirect('https://parishdesk.pages.dev/?gcal=error', 302);
  }

  const tokenData = await tokenRes.json();
  // Add expires_at so proxy can detect expiry without a clock call
  tokenData.expires_at = Date.now() + (tokenData.expires_in || 3600) * 1000;

  // Upsert into calendars table via Supabase REST
  const supaUrl = env.VITE_SUPA_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;

  const upsertRes = await fetch(`${supaUrl}/rest/v1/calendars`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Prefer':        'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({
      user_id:    state,
      type:       'google',
      name:       'Google Calendar',
      scope:      'personal',
      active:     true,
      color:      '#1565C0',
      token_data: tokenData,
    }),
  });

  if (!upsertRes.ok) {
    const err = await upsertRes.text();
    console.error('[google/callback] supabase upsert failed:', err);
    return Response.redirect('https://parishdesk.pages.dev/?gcal=error', 302);
  }

  return Response.redirect('https://parishdesk.pages.dev/?gcal=connected', 302);
}
