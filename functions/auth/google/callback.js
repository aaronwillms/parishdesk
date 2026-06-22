// Cloudflare Pages Function — handles Google OAuth callback and stores tokens in Supabase.
// Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, VITE_SUPA_URL, SUPABASE_SERVICE_KEY in Cloudflare Pages env.
export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state'); // "<user_id>" (personal) or "parishwriter:<user_id>"

    console.log('[google/callback] received — code present:', !!code, '| state present:', !!state);

    if (!code || !state) {
      console.error('[google/callback] missing code or state — code:', code, 'state:', state);
      return Response.redirect('https://parishdesk.pages.dev/?google_error=missing_code', 302);
    }

    // Parse the connection purpose from state. parishwriter → designate the connected
    // account as the parish's GLOBAL CALENDAR writer (parish-level, not tied to a person).
    const isParishWriter = state.startsWith('parishwriter:');
    const stateUserId    = isParishWriter ? state.slice('parishwriter:'.length) : state;

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

    console.log('[google/callback] supabase URL present:', !!supaUrl, '| service key present:', !!serviceKey, '| parishWriter:', isParishWriter);

    let upsertRes;
    if (isParishWriter) {
      // Designated GLOBAL parish writer — a singleton parish-level row (user_id null).
      // Replace any existing writer (re-designation by any admin re-points it). The
      // chosen calendarId is set later by the admin's calendar picker (defaults to primary).
      await fetch(`${supaUrl}/rest/v1/calendars?scope=eq.parish&type=eq.google`, {
        method: 'DELETE',
        headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}`, 'Prefer': 'return=minimal' },
      });
      upsertRes = await fetch(`${supaUrl}/rest/v1/calendars`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'apikey':        serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
          'Prefer':        'return=minimal',
        },
        body: JSON.stringify({
          user_id:    null,
          type:       'google',
          name:       'Parish Google Calendar',
          url:        'primary',
          scope:      'parish',
          active:     true,
          color:      '#8B1A2F',
          token_data: tokenData,
        }),
      });
    } else {
      upsertRes = await fetch(`${supaUrl}/rest/v1/calendars?on_conflict=user_id,type`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'apikey':        serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
          'Prefer':        'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({
          user_id:    stateUserId,
          type:       'google',
          name:       'Google Calendar',
          url:        'primary',
          scope:      'personal',
          active:     true,
          color:      '#1565C0',
          token_data: tokenData,
        }),
      });
    }

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

    console.log('[google/callback] upsert succeeded — redirecting');
    return Response.redirect(
      isParishWriter
        ? 'https://parishdesk.pages.dev/?parish_writer_connected=true'
        : 'https://parishdesk.pages.dev/?google_connected=true',
      302
    );

  } catch (e) {
    console.error('[google/callback] unexpected error:', e?.message ?? e);
    return Response.redirect(
      `https://parishdesk.pages.dev/?google_error=unexpected&detail=${encodeURIComponent(String(e?.message ?? e).slice(0, 120))}`,
      302
    );
  }
}
