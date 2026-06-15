import { sb } from './supabase.js';

let _onSignOut = null;
export function setSignOutCallback(fn) { _onSignOut = fn; }

function showAuth() {
  _onSignOut?.();
  document.getElementById('app').style.display = 'none';
  document.getElementById('auth-screen').style.display = 'flex';
}

function showApp(user) {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
}

export async function initAuth(onLogin) {
  // Wire logout and auth state change regardless of session state
  document.getElementById('btn-logout').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Signing out…';
    const { error } = await sb.auth.signOut();
    if (error) { console.error('Sign out error:', error); btn.disabled = false; btn.textContent = 'Sign out'; return; }
    showAuth();
  });

  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') showAuth();
    if (event === 'SIGNED_IN' && session?.user) showApp(session.user);
  });

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

  return null;
}
