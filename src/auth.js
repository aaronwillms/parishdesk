import { sb } from './supabase.js';

let _onSignOut = null;
let _appStarted = false;

export function setSignOutCallback(fn) { _onSignOut = fn; }

function showAuth() {
  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}

function showApp() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
}

export async function initAuth(onLogin) {
  // Both elements start hidden (also set in HTML). Nothing is visible until
  // we know the session state — eliminates the flash of both elements.
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app').style.display = 'none';

  // Explicit initial check — onAuthStateChange INITIAL_SESSION is not guaranteed
  // to fire synchronously in all Supabase/browser environments.
  const { data: { session: initialSession } } = await sb.auth.getSession();
  if (initialSession?.user) {
    showApp();
    _appStarted = true;
    onLogin(initialSession.user);
  } else {
    showAuth();
  }

  // Handle subsequent transitions (login, logout, token refresh).
  // INITIAL_SESSION is already handled above, so only act on SIGNED_IN / SIGNED_OUT.
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') {
      _appStarted = false;
      _onSignOut?.();
      showAuth();
      return;
    }

    if (event === 'SIGNED_IN' && session?.user && !_appStarted) {
      _appStarted = true;
      showApp();
      onLogin(session.user);
    }
  });

  // Logout button
  document.getElementById('btn-logout').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Signing out…';
    const { error } = await sb.auth.signOut();
    if (error) {
      console.error('Sign out error:', error);
      btn.disabled = false;
      btn.textContent = 'Sign out';
    }
    // onAuthStateChange SIGNED_OUT handles showAuth and store clear
  });

  // Login form
  const loginBtn = document.querySelector('#login-form .auth-submit');
  const errEl = document.getElementById('login-error');

  async function doLogin() {
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    errEl.textContent = '';
    if (!email || !password) { errEl.textContent = 'Email and password are required.'; return; }
    loginBtn.disabled = true;
    loginBtn.textContent = 'Signing in…';
    const { error } = await sb.auth.signInWithPassword({ email, password });
    loginBtn.disabled = false;
    loginBtn.textContent = 'Sign in';
    if (error) { errEl.textContent = error.message; }
    // On success: onAuthStateChange fires SIGNED_IN → showApp + onLogin
  }

  loginBtn.addEventListener('click', doLogin);
  document.getElementById('login-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });
}
