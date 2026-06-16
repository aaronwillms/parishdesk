// Cloudflare Pages Function — proxies Google Calendar API calls using stored OAuth tokens.
// Set VITE_SUPA_URL and SUPABASE_SERVICE_KEY in Cloudflare Pages env.
async function _refreshToken(tokenData, env) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: tokenData.refresh_token,
      grant_type:    'refresh_token',
    }),
  });
  if (!res.ok) throw new Error('Token refresh failed: ' + await res.text());
  const fresh = await res.json();
  return {
    ...tokenData,
    access_token: fresh.access_token,
    expires_in:   fresh.expires_in,
    expires_at:   Date.now() + (fresh.expires_in || 3600) * 1000,
  };
}

async function _getValidToken(calendarRow, env, supaUrl, serviceKey) {
  let td = calendarRow.token_data;
  if (!td?.access_token) throw new Error('No token data');

  const needsRefresh = !td.expires_at || Date.now() > td.expires_at - 60_000;
  if (needsRefresh && td.refresh_token) {
    td = await _refreshToken(td, env);
    // Persist refreshed token
    await fetch(`${supaUrl}/rest/v1/calendars?id=eq.${calendarRow.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify({ token_data: td }),
    });
  }

  return td.access_token;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { user_id, action, calendarId = 'primary', event } = body;
  if (!user_id || !action) {
    return new Response(JSON.stringify({ error: 'Missing user_id or action', received: { user_id, action } }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const supaUrl = env.VITE_SUPA_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;

  // Fetch calendar row for this user
  const calRes = await fetch(
    `${supaUrl}/rest/v1/calendars?user_id=eq.${user_id}&type=eq.google&scope=eq.personal&limit=1`,
    { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
  );
  if (!calRes.ok) return new Response('Supabase error', { status: 502 });
  const cals = await calRes.json();
  if (!cals?.length) return new Response('No Google Calendar connected', { status: 404 });

  let accessToken;
  try {
    accessToken = await _getValidToken(cals[0], env, supaUrl, serviceKey);
  } catch (e) {
    return new Response('Token error: ' + e.message, { status: 502 });
  }

  if (action === 'list') {
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() + 14 * 86400_000).toISOString();
    const gcalRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events` +
      `?timeMin=${encodeURIComponent(now)}&timeMax=${encodeURIComponent(cutoff)}&singleEvents=true&orderBy=startTime&maxResults=50`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
    if (!gcalRes.ok) return new Response(await gcalRes.text(), { status: gcalRes.status });
    return new Response(await gcalRes.text(), {
      headers: { 'Content-Type': 'application/json' },
    });

  } else if (action === 'create') {
    if (!event) return new Response('Missing event', { status: 400 });
    const gcalRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify(event),
      }
    );
    const text = await gcalRes.text();
    return new Response(text, {
      status: gcalRes.status,
      headers: { 'Content-Type': 'application/json' },
    });

  } else {
    return new Response('Unknown action', { status: 400 });
  }
}
