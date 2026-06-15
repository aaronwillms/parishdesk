// Cloudflare Pages Function — returns all Supabase auth users merged with user_profiles.
// Set SUPABASE_URL (or VITE_SUPA_URL) and SUPABASE_SERVICE_KEY in Cloudflare Pages env.
export async function onRequestGet(context) {
  const supaUrl = context.env.SUPABASE_URL || context.env.VITE_SUPA_URL;
  const serviceKey = context.env.SUPABASE_SERVICE_KEY;

  if (!serviceKey || !supaUrl) {
    return new Response(JSON.stringify({
      error: 'Server not configured: set SUPABASE_URL and SUPABASE_SERVICE_KEY in Cloudflare Pages environment variables',
    }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }

  const headers = { 'Authorization': `Bearer ${serviceKey}`, 'apikey': serviceKey };

  // Paginate auth users in case there are many
  let allAuthUsers = [];
  let page = 1;
  while (true) {
    const res = await fetch(`${supaUrl}/auth/v1/admin/users?page=${page}&per_page=50`, { headers });
    if (!res.ok) {
      const msg = await res.text();
      return new Response(JSON.stringify({ error: `Auth API error: ${msg}` }), {
        status: res.status, headers: { 'Content-Type': 'application/json' },
      });
    }
    const body = await res.json();
    const batch = body.users || [];
    allAuthUsers.push(...batch);
    if (batch.length < 50) break;  // fewer than per_page means last page
    page++;
  }

  // Fetch all user_profiles (left join in JS)
  const profilesRes = await fetch(
    `${supaUrl}/rest/v1/user_profiles?select=user_id,personnel_id,avatar_url`,
    { headers: { ...headers, 'Accept': 'application/json' } }
  );
  const profiles = profilesRes.ok ? await profilesRes.json() : [];

  const profileMap = {};
  (Array.isArray(profiles) ? profiles : []).forEach(p => { profileMap[p.user_id] = p; });

  // Every auth user appears; profile fields are null when no user_profiles row exists
  const users = allAuthUsers.map(u => {
    const p = profileMap[u.id] || null;
    return {
      id:           u.id,
      email:        u.email || null,
      personnel_id: p?.personnel_id || null,
      avatar_url:   p?.avatar_url   || null,
    };
  });

  return new Response(JSON.stringify({ users }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}
