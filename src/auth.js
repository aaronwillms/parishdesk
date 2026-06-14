import { sb } from './supabase.js';

function showAuth() {
  document.getElementById('app').style.display = 'none';
  document.getElementById('auth-screen').style.display = 'flex';
}

function showApp(user) {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  const name = user.user_metadata?.display_name || user.email || '';
  document.getElementById('user-display').textContent = name;
  // TODO (multi-tenancy): fetch user_profiles(user_id) here to get parish_id, role, display_name
  // and pass them along to restrict Supabase queries by parish_id.
}

export async function initAuth(onLogin) {
  const { data: { session } } = await sb.auth.getSession();
  if (session?.user) {
    showApp(session.user);
    return session.user;
  }
  showAuth();

  const form = document.getElementById('login-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const errEl = document.getElementById('login-error');
    errEl.textContent = '';
    const btn = form.querySelector('.auth-submit');
    btn.disabled = true;
    btn.textContent = 'Signing in…';

    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    btn.disabled = false;
    btn.textContent = 'Sign in';

    if (error) {
      errEl.textContent = error.message;
      return;
    }
    showApp(data.user);
    onLogin(data.user);
  });

  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') showAuth();
    if (event === 'SIGNED_IN' && session?.user) showApp(session.user);
  });

  document.getElementById('btn-logout').addEventListener('click', async () => {
    await sb.auth.signOut();
  });

  return null;
}
