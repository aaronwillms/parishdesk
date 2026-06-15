// Cloudflare Pages Function — returns all Supabase auth users merged with user_profiles.
// Set SUPABASE_URL (or VITE_SUPA_URL) and SUPABASE_SERVICE_KEY in Cloudflare Pages env variables.
export async function onRequestGet(context) {
  const supaUrl = context.env.SUPABASE_URL || context.env.VITE_SUPA_URL;
  const serviceKey = context.env.SUPABASE_SERVICE_KEY;

  if (!serviceKey || !supaUrl) {
    return new Response(
      JSON.stringify({ error: 'Server not configured: set SUPABASE_URL and SUPABASE_SERVICE_KEY in Cloudflare Pages environment variables' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Fetch all auth users AND all user_profiles in parallel
  const [authRes, profilesRes] = await Promise.all([
    fetch(`${supaUrl}/auth/v1/admin/users?per_page=1000`, {
      headers: { 'Authorization': `Bearer ${serviceKey}`, 'apikey': serviceKey },
    }),
    fetch(`${supaUrl}/rest/v1/user_profiles?select=user_id,personnel_id,avatar_url`, {
      headers: { 'Authorization': `Bearer ${serviceKey}`, 'apikey': serviceKey },
    }),
  ]);

  if (!authRes.ok) {
    const msg = await authRes.text();
    return new Response(JSON.stringify({ error: msg }), {
      status: authRes.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const authBody = await authRes.json();
  const profiles = profilesRes.ok ? (await profilesRes.json()) : [];

  // Build profile lookup by user_id
  const profileMap = {};
  (Array.isArray(profiles) ? profiles : []).forEach(p => { profileMap[p.user_id] = p; });

  // Merge: every auth user appears, with profile fields null if no row exists
  const users = (authBody.users || []).map(u => {
    const p = profileMap[u.id] || null;
    return {
      id: u.id,
      email: u.email || null,
      personnel_id: p?.personnel_id || null,
      avatar_url: p?.avatar_url || null,
    };
  });

  return new Response(JSON.stringify({ users }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
