// Cloudflare Pages Function — superadmin-only user lifecycle:
//   POST { action: 'deactivate' | 'reactivate' | 'delete', userId }
//
// Authoritative on ALL guards. The caller's Supabase access token is forwarded in
// the Authorization header; we resolve the caller via GET /auth/v1/user, then
// re-verify super_admin / not-self / last-superadmin with the SERVICE key. The
// client gates are UX-only — this function never acts on an id without the checks
// passing.
//
// Env (Cloudflare Pages): SUPABASE_URL (or VITE_SUPA_URL) + SUPABASE_SERVICE_KEY.
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PERMA_BAN = '876000h';   // ≈100 years — effectively permanent

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

// The 11 access columns to CLEAR on hard-delete (from the reference-map recon).
// PRESERVE columns (created_by/author_id/sender_id/etc.) are deliberately untouched
// — authored content orphans to "Unknown User". activity_log.triggered_by is
// SET NULL first (it's the only real FK to user_profiles; NO ACTION would block the
// user_profiles delete otherwise).
const CLEAR = [
  { table: 'panel_grants',             col: 'user_id'    },
  { table: 'sacramental_roles',        col: 'user_id'    },
  { table: 'user_roles',               col: 'user_id'    },
  { table: 'notifications',            col: 'user_id'    },
  { table: 'announcement_dismissals',  col: 'user_id'    },
  { table: 'calendars',                col: 'user_id'    },
  { table: 'discernment_pins',         col: 'user_id'    },
  { table: 'conversation_participants',col: 'user_id'    },
  { table: 'record_grants',            col: 'granted_to' },
  { table: 'record_grants',            col: 'granted_by' },
  // user_profiles is deleted LAST (after activity_log SET NULL) — handled separately.
];

export async function onRequestPost(context) {
  try {
    const { env, request } = context;
    const supaUrl    = env.SUPABASE_URL || env.VITE_SUPA_URL;
    const serviceKey = env.SUPABASE_SERVICE_KEY;
    if (!supaUrl || !serviceKey) {
      return json({ error: 'Server not configured: set SUPABASE_URL and SUPABASE_SERVICE_KEY in Cloudflare Pages environment variables' }, 503);
    }

    const { action, userId } = await request.json();
    if (!action || !userId) return json({ error: 'action and userId are required' }, 400);
    if (!['deactivate', 'reactivate', 'delete'].includes(action)) return json({ error: 'Unknown action' }, 400);

    const svc = { 'Authorization': `Bearer ${serviceKey}`, 'apikey': serviceKey, 'Content-Type': 'application/json' };

    // ── GUARD PREAMBLE — resolve + authorize the caller ──────────────────────
    const callerToken = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!callerToken) return json({ error: 'Not authenticated' }, 401);

    const meRes = await fetch(`${supaUrl}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${callerToken}`, 'apikey': serviceKey },
    });
    if (!meRes.ok) return json({ error: 'Invalid or expired session' }, 401);
    const me = await meRes.json();
    const callerId = me?.id;
    if (!callerId) return json({ error: 'Could not resolve caller' }, 401);

    // Caller must be a super_admin (service-key REST query against user_roles).
    if (!(await hasRole(supaUrl, svc, callerId, 'super_admin'))) {
      return json({ error: 'Forbidden — super admin only' }, 403);
    }

    // ── Per-action guards + execution ────────────────────────────────────────
    if (action === 'deactivate' || action === 'delete') {
      if (userId === callerId) return json({ error: 'You cannot deactivate or delete your own account.' }, 400);
      // Last-superadmin protection: refuse if the target IS a super_admin and they
      // are the only one left.
      if (await hasRole(supaUrl, svc, userId, 'super_admin')) {
        const saCount = await countSuperAdmins(supaUrl, svc);
        if (saCount <= 1) return json({ error: 'Cannot deactivate the last super admin.' }, 400);
      }
    }

    if (action === 'deactivate') {
      const banned = await banUser(supaUrl, svc, userId, PERMA_BAN);
      if (!banned.ok) return json({ error: `Ban failed: ${banned.msg}` }, banned.status);
      const flag = await setDeactivated(supaUrl, svc, userId, true);
      if (!flag.ok) return json({ error: `Flag update failed: ${flag.msg}` }, flag.status);
      return json({ success: true, action, userId });
    }

    if (action === 'reactivate') {
      const unbanned = await banUser(supaUrl, svc, userId, 'none');
      if (!unbanned.ok) return json({ error: `Un-ban failed: ${unbanned.msg}` }, unbanned.status);
      const flag = await setDeactivated(supaUrl, svc, userId, false);
      if (!flag.ok) return json({ error: `Flag update failed: ${flag.msg}` }, flag.status);
      return json({ success: true, action, userId });
    }

    // action === 'delete' — requires an ALREADY-DEACTIVATED (banned) target.
    const target = await getAuthUser(supaUrl, svc, userId);
    if (!target.ok) return json({ error: `Could not load target user: ${target.msg}` }, target.status);
    const isBanned = target.user?.banned_until && new Date(target.user.banned_until) > new Date();
    if (!isBanned) return json({ error: 'Delete requires the account to be deactivated first.' }, 400);

    // Ordered destructive sequence — abort BEFORE the auth delete if any clear fails.
    // 1. SET NULL the only real FK to user_profiles (preserves the log rows).
    const nulled = await restPatch(supaUrl, svc, `activity_log?triggered_by=eq.${userId}`, { triggered_by: null });
    if (!nulled.ok) return json({ error: `Clear failed (activity_log): ${nulled.msg}` }, 500);
    // 2. Clear the access columns.
    for (const { table, col } of CLEAR) {
      const del = await restDelete(supaUrl, svc, `${table}?${col}=eq.${userId}`);
      if (!del.ok) return json({ error: `Clear failed (${table}.${col}): ${del.msg}` }, 500);
    }
    // 3. Delete the profile (now unblocked by the SET NULL above).
    const delProfile = await restDelete(supaUrl, svc, `user_profiles?user_id=eq.${userId}`);
    if (!delProfile.ok) return json({ error: `Clear failed (user_profiles): ${delProfile.msg}` }, 500);
    // 4. Finally, delete the auth account.
    const delAuth = await fetch(`${supaUrl}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: svc });
    if (!delAuth.ok) {
      const msg = await delAuth.text();
      return json({ error: `Auth delete failed: ${msg}` }, delAuth.status);
    }
    return json({ success: true, action, userId });
  } catch (err) {
    return json({ error: err?.message || 'Unexpected error' }, 500);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function hasRole(supaUrl, svc, userId, role) {
  const res = await fetch(`${supaUrl}/rest/v1/user_roles?select=role&user_id=eq.${userId}&role=eq.${role}`, { headers: svc });
  if (!res.ok) return false;
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0;
}

async function countSuperAdmins(supaUrl, svc) {
  // Prefer/HEAD with count header to avoid pulling rows.
  const res = await fetch(`${supaUrl}/rest/v1/user_roles?select=user_id&role=eq.super_admin`, {
    headers: { ...svc, 'Prefer': 'count=exact' },
  });
  const cr = res.headers.get('content-range');           // e.g. "0-2/3"
  if (cr && cr.includes('/')) {
    const n = parseInt(cr.split('/')[1], 10);
    if (!Number.isNaN(n)) return n;
  }
  const rows = res.ok ? await res.json() : [];
  return Array.isArray(rows) ? rows.length : 0;
}

async function getAuthUser(supaUrl, svc, userId) {
  const res = await fetch(`${supaUrl}/auth/v1/admin/users/${userId}`, { headers: svc });
  if (!res.ok) return { ok: false, status: res.status, msg: await res.text() };
  return { ok: true, user: await res.json() };
}

async function banUser(supaUrl, svc, userId, ban_duration) {
  const res = await fetch(`${supaUrl}/auth/v1/admin/users/${userId}`, {
    method: 'PUT', headers: svc, body: JSON.stringify({ ban_duration }),
  });
  if (!res.ok) return { ok: false, status: res.status, msg: await res.text() };
  return { ok: true };
}

async function setDeactivated(supaUrl, svc, userId, value) {
  return restPatch(supaUrl, svc, `user_profiles?user_id=eq.${userId}`, { deactivated: value });
}

async function restPatch(supaUrl, svc, path, body) {
  const res = await fetch(`${supaUrl}/rest/v1/${path}`, {
    method: 'PATCH', headers: { ...svc, 'Prefer': 'return=minimal' }, body: JSON.stringify(body),
  });
  if (!res.ok) return { ok: false, status: res.status, msg: await res.text() };
  return { ok: true };
}

async function restDelete(supaUrl, svc, path) {
  const res = await fetch(`${supaUrl}/rest/v1/${path}`, {
    method: 'DELETE', headers: { ...svc, 'Prefer': 'return=minimal' },
  });
  if (!res.ok) return { ok: false, status: res.status, msg: await res.text() };
  return { ok: true };
}
