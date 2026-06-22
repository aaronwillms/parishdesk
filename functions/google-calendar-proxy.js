// Cloudflare Pages Function — proxies Google Calendar API calls using stored OAuth tokens.
// Set VITE_SUPA_URL and SUPABASE_SERVICE_KEY in Cloudflare Pages env.
//
// Two targets:
//   target: 'personal' (default) — the requesting user's own connected Google calendar
//           (calendars row scope='personal', user_id=<user>, calendarId defaults to 'primary').
//   target: 'global'   — the parish's DESIGNATED-WRITER calendar (calendars row scope='parish',
//           type='google', WITH token_data). Read (list) is open to all users; write (create)
//           requires the requesting user to be an admin/super-admin. The chosen calendarId is the
//           writer row's `url`. This reuses the same OAuth client + token-refresh as personal.
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

const _sbHeaders = (serviceKey) => ({ 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` });

// The single designated-writer row: a parish-scope Google calendar that has a token.
async function _globalWriterRow(supaUrl, serviceKey) {
  const res = await fetch(
    `${supaUrl}/rest/v1/calendars?scope=eq.parish&type=eq.google&token_data=not.is.null&limit=1`,
    { headers: _sbHeaders(serviceKey) }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows?.[0] || null;
}

// Server-side guard for GLOBAL WRITES: the requesting user must be an admin/super-admin.
// (Client UI is gated too — this is defense-in-depth for the shared parish token.)
async function _isAdmin(user_id, supaUrl, serviceKey) {
  if (!user_id) return false;
  const res = await fetch(
    `${supaUrl}/rest/v1/user_roles?user_id=eq.${user_id}&select=role`,
    { headers: _sbHeaders(serviceKey) }
  );
  if (!res.ok) return false;
  const rows = await res.json();
  return (rows || []).some(r => r.role === 'admin' || r.role === 'super_admin');
}

// The designated WORK calendar id (on the global-writer's account) — where panel
// events are posted. Stored on parish_settings.
async function _workCalendarId(supaUrl, serviceKey) {
  const res = await fetch(`${supaUrl}/rest/v1/parish_settings?select=work_calendar_id&limit=1`, { headers: _sbHeaders(serviceKey) });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows?.[0]?.work_calendar_id || null;
}

// A real app user (has a user_profiles row). Work-calendar WRITES require this;
// the granular per-panel write gate is enforced client-side (roles.js), consistent
// with this app's client-gated access model.
async function _isAppUser(user_id, supaUrl, serviceKey) {
  if (!user_id) return false;
  const res = await fetch(`${supaUrl}/rest/v1/user_profiles?user_id=eq.${user_id}&select=user_id&limit=1`, { headers: _sbHeaders(serviceKey) });
  if (!res.ok) return false;
  const rows = await res.json();
  return !!rows?.length;
}

const _json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try { body = await request.json(); }
  catch (e) { return _json({ error: 'Invalid JSON body' }, 400); }

  const { user_id, action, target = 'personal', calendarId, event, timeMin, timeMax, panelFilter, calendarName } = body;
  if (!action) return _json({ error: 'Missing action' }, 400);

  const supaUrl = env.VITE_SUPA_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;

  // ── Resolve the calendar row + effective calendarId for this request ────────
  let calRow, effCalendarId;
  if (target === 'global') {
    calRow = await _globalWriterRow(supaUrl, serviceKey);
    if (!calRow) return new Response('No global parish calendar configured', { status: 404 });
    effCalendarId = calendarId || calRow.url || 'primary';
    // Writes (and calendar-list during setup) require an admin; reads are open to all.
    if (action === 'create' || action === 'listCalendars' || action === 'createCalendar') {
      if (!await _isAdmin(user_id, supaUrl, serviceKey)) {
        return new Response('Not authorized to write the parish calendar', { status: 403 });
      }
    }
  } else if (target === 'work') {
    // Application Work Calendar — panel-originated Sacramental/Project/Team events.
    // Uses the global-writer's token (same connected account) targeting the chosen
    // work calendarId. READ is open (the client filters by the user's panel access);
    // WRITE requires a real app user (per-panel write gate is enforced client-side).
    calRow = await _globalWriterRow(supaUrl, serviceKey);
    if (!calRow) return new Response('No global parish calendar configured', { status: 404 });
    const workId = await _workCalendarId(supaUrl, serviceKey);
    if (!workId && action !== 'listCalendars' && action !== 'createCalendar') {
      return new Response('No work calendar configured', { status: 404 });
    }
    effCalendarId = calendarId || workId || calRow.url || 'primary';
    if (action === 'create' || action === 'delete') {
      if (!await _isAppUser(user_id, supaUrl, serviceKey)) return new Response('Not authorized', { status: 403 });
    } else if (action === 'createCalendar') {
      if (!await _isAdmin(user_id, supaUrl, serviceKey)) return new Response('Not authorized', { status: 403 });
    }
  } else {
    if (!user_id) return _json({ error: 'Missing user_id' }, 400);
    const calRes = await fetch(
      `${supaUrl}/rest/v1/calendars?user_id=eq.${user_id}&type=eq.google&scope=eq.personal&limit=1`,
      { headers: _sbHeaders(serviceKey) }
    );
    if (!calRes.ok) return new Response('Supabase error', { status: 502 });
    const cals = await calRes.json();
    if (!cals?.length) return new Response('No Google Calendar connected', { status: 404 });
    calRow = cals[0];
    // Personal WRITE/single target = the user's chosen write calendar (calRow.url),
    // defaulting to 'primary' for connections made before Phase 2 (backward compatible).
    effCalendarId = calendarId || calRow.url || 'primary';
  }

  let accessToken;
  try { accessToken = await _getValidToken(calRow, env, supaUrl, serviceKey); }
  catch (e) { return new Response('Token error: ' + e.message, { status: 502 }); }

  // ── Actions ─────────────────────────────────────────────────────────────────
  if (action === 'listCalendars') {
    // Used by the admin setup flow to let the parish pick which calendar is the global one.
    const r = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250', {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    if (!r.ok) return new Response(await r.text(), { status: r.status });
    const data = await r.json();
    const items = (data.items || []).map(c => ({ id: c.id, summary: c.summary, primary: !!c.primary, accessRole: c.accessRole }));
    return _json({ items });
  }

  if (action === 'list') {
    const timeMinParam = timeMin || new Date().toISOString();
    const timeMaxParam = timeMax || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    // Personal READ overlays MULTIPLE calendars the user selected (calRow.selected_calendars);
    // global reads the single designated calendar. No selection → just the single effCalendarId
    // (= 'primary' for pre-Phase-2 connections) — backward compatible. Merge results, tagging
    // each event with its source calendar so the client can group/colour them.
    const calIds = (target === 'personal' && Array.isArray(calRow.selected_calendars) && calRow.selected_calendars.length)
      ? calRow.selected_calendars
      : [effCalendarId];
    // Work-calendar reads can filter to a single originating panel (the Schedule view);
    // events.list returns extendedProperties so the client can also filter by panel access.
    const pf = panelFilter ? `&privateExtendedProperty=${encodeURIComponent('pd_panel=' + panelFilter)}` : '';
    const fetchOne = async (cid) => {
      const r = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cid)}/events` +
        `?timeMin=${encodeURIComponent(timeMinParam)}&timeMax=${encodeURIComponent(timeMaxParam)}&singleEvents=true&orderBy=startTime&maxResults=250${pf}`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
      );
      if (!r.ok) return [];
      const d = await r.json();
      return (d.items || []).map(it => ({ ...it, _sourceCalendarId: cid }));
    };
    const items = (await Promise.all(calIds.map(fetchOne))).flat();
    return _json({ items });

  } else if (action === 'createCalendar') {
    // Create a brand-new calendar on the writer's account (admin "link a new calendar").
    const r = await fetch('https://www.googleapis.com/calendar/v3/calendars', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: calendarName || 'ParishDesk Work Calendar' }),
    });
    if (!r.ok) return new Response(await r.text(), { status: r.status });
    const c = await r.json();
    return _json({ id: c.id, summary: c.summary });

  } else if (action === 'create') {
    if (!event) return new Response('Missing event', { status: 400 });
    const gcalRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(effCalendarId)}/events`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      }
    );
    return new Response(await gcalRes.text(), { status: gcalRes.status, headers: { 'Content-Type': 'application/json' } });

  } else if (action === 'delete') {
    const eventId = body.eventId;
    if (!eventId) return new Response('Missing eventId', { status: 400 });
    const r = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(effCalendarId)}/events/${encodeURIComponent(eventId)}`,
      { method: 'DELETE', headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
    return new Response('', { status: r.ok || r.status === 410 ? 204 : r.status });

  } else {
    return new Response('Unknown action', { status: 400 });
  }
}
