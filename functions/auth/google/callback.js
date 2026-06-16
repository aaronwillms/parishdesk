export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state'); // user_id passed through state param

    console.log('[google/callback] received — code present:', !!code, '| state present:', !!state);

    if (!code || !state) {
      console.error('[google/callback] missing code or state — code:', code, 'state:', state);
      return Response.redirect('https://parishdesk.pages.dev/?google_error=missing_code', 302);
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

    console.log('[google/callback] token exchange status:', tokenRes.status);

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error('[google/callback] token exchange failed:', err);
      return Response.redirect('https://parishdesk.pages.dev/?google_error=token_exchange_failed', 302);
    }

    const tokenData = await tokenRes.json();
    tokenData.expires_at = Date.now() + (tokenData.expires_in || 3600) * 1000;
    console.log('[google/callback] token exchange succeeded — has refresh_token:', !!tokenData.refresh_token);

    // Upsert into calendars table via Supabase REST
    const supaUrl = env.VITE_SUPA_URL;
    const serviceKey = env.SUPABASE_SERVICE_KEY;

    console.log('[google/callback] supabase URL present:', !!supaUrl, '| service key present:', !!serviceKey);

    const upsertRes = await fetch(`${supaUrl}/rest/v1/calendars?on_conflict=user_id,type`, {
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
        url:        'primary',
        scope:      'personal',
        active:     true,
        color:      '#1565C0',
        token_data: tokenData,
      }),
    });

    console.log('[google/callback] supabase upsert status:', upsertRes.status);

    if (!upsertRes.ok) {
      const errBody = await upsertRes.text();
      console.error('[google/callback] supabase upsert failed — status:', upsertRes.status, '| body:', errBody);
      const detail = encodeURIComponent(errBody.slice(0, 120));
      return Response.redirect(
        `https://parishdesk.pages.dev/?google_error=supabase_insert_failed&detail=${detail}`,
        302
      );
    }

    console.log('[google/callback] upsert succeeded — redirecting with google_connected=true');
    return Response.redirect('https://parishdesk.pages.dev/?google_connected=true', 302);

  } catch (e) {
    console.error('[google/callback] unexpected error:', e?.message ?? e);
    return Response.redirect(
      `https://parishdesk.pages.dev/?google_error=unexpected&detail=${encodeURIComponent(String(e?.message ?? e).slice(0, 120))}`,
      302
    );
  }
}
