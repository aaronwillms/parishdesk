import { sb } from '../supabase.js';
import { store } from '../store.js';
import { formatPhone, normalizePhone } from '../utils/phone.js';

let _user = null;
let _profile = null;
let _googleCal = null; // calendars row for type='google'

// ── Public entry point ─────────────────────────────────────────────────────

export async function loadUserProfile() {
  const { data: { user } } = await sb.auth.getUser();
  _user = user;
  if (!user) return;

  const { data } = await sb.from('user_profiles')
    .select('*, personnel(id,name,phone,email,date_of_birth)')
    .eq('user_id', user.id)
    .maybeSingle();
  _profile = data || null;
  store.currentUserProfile = _profile;

  console.log('[userProfile] querying calendars — auth user.id:', user.id);
  // Broad query first: no type filter, to isolate whether user_id itself matches
  const { data: allCalRows, error: allCalErr } = await sb.from('calendars')
    .select('id, user_id, type, scope')
    .eq('user_id', user.id);
  console.log('[userProfile] calendars (user_id only) — rows:', allCalRows, '| error:', allCalErr);
  const { data: gcalRows, error: gcalErr } = await sb.from('calendars')
    .select('*')
    .eq('user_id', user.id)
    .eq('type', 'google');
  console.log('[userProfile] calendars (user_id + type=google) — rows:', gcalRows, '| error:', gcalErr);
  const gcal = gcalRows?.[0] ?? null;
  _googleCal = gcal;

  // Handle redirect back from Google OAuth
  const params = new URLSearchParams(window.location.search);
  if (params.get('gcal') === 'connected') {
    _googleCal = { id: 'pending' };
    history.replaceState(null, '', window.location.pathname);
  } else if (params.get('gcal') === 'error') {
    history.replaceState(null, '', window.location.pathname);
  }

  _render();
}

// ── Render ─────────────────────────────────────────────────────────────────

function _render() {
  const el = document.getElementById('user-profile-root');
  if (!el) return;

  const avatarUrl = _profile?.avatar_url || null;
  const linkedPerson = _profile?.personnel || null;
  const email = _user?.email || '';

  el.innerHTML = `
    <div style="max-width:560px;margin:0 auto;">

      <!-- Avatar -->
      <div style="text-align:center;margin-bottom:2rem;">
        <div id="up-avatar-wrap" style="
          width:80px;height:80px;border-radius:50%;overflow:hidden;
          display:inline-flex;align-items:center;justify-content:center;
          background:#1C2B3A;margin-bottom:.75rem;
        ">
          ${avatarUrl
            ? `<img id="up-avatar-img" src="${avatarUrl}" style="width:100%;height:100%;object-fit:cover;" />`
            : `<span id="up-avatar-initials" style="color:#fff;font-size:28px;font-weight:600;font-family:'Inter',sans-serif;">${_initials(linkedPerson?.name || email)}</span>`}
        </div>
        <div style="display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;">
          <label id="up-upload-label" style="
            font-size:12.5px;color:#8B1A2F;cursor:pointer;font-weight:500;
            font-family:'Inter',sans-serif;margin:0;display:inline;
          ">
            Upload Photo
            <input type="file" id="up-file-input" accept="image/*" style="display:none;" />
          </label>
          ${avatarUrl ? `<button id="up-remove-photo" style="
            font-size:12.5px;color:#9CA3AF;background:none;border:none;
            cursor:pointer;font-family:'Inter',sans-serif;padding:0;
          ">Remove photo</button>` : ''}
        </div>
        <div id="up-upload-status" style="font-size:12px;color:#6B7280;margin-top:6px;min-height:16px;"></div>
      </div>

      <!-- Directory link -->
      <div style="background:#fff;border:.5px solid #E2DDD6;border-radius:8px;padding:1.1rem 1.2rem;margin-bottom:1rem;">
        <div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.75rem;">Linked Directory Entry</div>
        ${linkedPerson
          ? `<div>
              <div style="font-size:14px;font-weight:500;color:#1C2B3A;">${linkedPerson.name}</div>
              ${linkedPerson.title ? `<div style="font-size:12px;color:#6B7280;margin-top:1px;">${linkedPerson.title}</div>` : ''}
              <div style="font-size:11.5px;color:#9CA3AF;margin-top:.6rem;">Your account has been linked to your directory entry by an administrator.</div>
            </div>`
          : `<div style="font-size:13px;color:#9CA3AF;font-style:italic;">Your account has not yet been linked to a directory entry. Please contact an administrator.</div>`}
      </div>

      <!-- Contact Information -->
      <div style="background:#fff;border:.5px solid #E2DDD6;border-radius:8px;padding:1.1rem 1.2rem;margin-bottom:1rem;">
        <div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.75rem;">Contact Information</div>
        ${!linkedPerson ? `<div style="font-size:13px;color:#9CA3AF;font-style:italic;">Link a directory entry above to edit contact information.</div>` : `
        <div style="display:flex;flex-direction:column;gap:.65rem;">
          <div>
            <div style="font-size:11.5px;color:#6B7280;margin-bottom:4px;">Phone</div>
            <input type="tel" id="up-phone" value="${formatPhone(linkedPerson.phone || '')}" placeholder="e.g. (601) 555-0100" style="
              width:100%;box-sizing:border-box;padding:.4rem .65rem;
              border:.5px solid #D1C9BE;border-radius:5px;font-size:13px;
              font-family:'Inter',sans-serif;outline:none;background:#fff;
            " />
          </div>
          <div>
            <div style="font-size:11.5px;color:#6B7280;margin-bottom:4px;">Contact Email</div>
            <input id="up-contact-email" type="email" value="${linkedPerson.email || ''}" placeholder="e.g. name@parish.org" style="
              width:100%;box-sizing:border-box;padding:.4rem .65rem;
              border:.5px solid #D1C9BE;border-radius:5px;font-size:13px;
              font-family:'Inter',sans-serif;outline:none;background:#fff;
            " />
          </div>
          <div>
            <div style="font-size:11.5px;color:#6B7280;margin-bottom:4px;">Date of Birth</div>
            <input type="date" id="up-dob" value="${linkedPerson.date_of_birth || ''}" style="
              width:100%;box-sizing:border-box;padding:.4rem .65rem;
              border:.5px solid #D1C9BE;border-radius:5px;font-size:13px;
              font-family:'Inter',sans-serif;outline:none;background:#fff;
            " />
          </div>
          <div style="display:flex;align-items:center;gap:12px;margin-top:.25rem;">
            <button onclick="window._upSaveContact()" style="
              padding:.4rem 1rem;background:#1C2B3A;color:#fff;border:none;
              border-radius:5px;font-size:13px;font-family:'Inter',sans-serif;
              cursor:pointer;font-weight:500;
            ">Save</button>
            <div id="up-contact-status" style="font-size:12px;color:#6B7280;min-height:16px;"></div>
          </div>
        </div>`}
      </div>

      <!-- Account -->
      <div style="background:#fff;border:.5px solid #E2DDD6;border-radius:8px;padding:1.1rem 1.2rem;margin-bottom:1rem;">
        <div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.75rem;">Account</div>
        <div style="font-size:13px;color:#6B7280;margin-bottom:.75rem;">${email}</div>
        <button id="up-change-pw" style="
          font-size:12.5px;color:#8B1A2F;background:none;border:.5px solid #E2DDD6;
          border-radius:5px;padding:.35rem .85rem;cursor:pointer;font-family:'Inter',sans-serif;
        ">Change Password</button>
        <div id="up-pw-status" style="font-size:12px;color:#6B7280;margin-top:6px;min-height:16px;"></div>
      </div>

      <!-- Google Calendar -->
      <div style="background:#fff;border:.5px solid #E2DDD6;border-radius:8px;padding:1.1rem 1.2rem;margin-bottom:1.5rem;">
        <div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.75rem;">Google Calendar</div>
        ${_googleCal
          ? `<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
              <span style="font-size:13px;color:#166534;font-weight:500;">
                <i class="fa-solid fa-circle-check" style="margin-right:5px;"></i>Connected
              </span>
              <button id="up-gcal-disconnect" style="
                font-size:12.5px;color:#9CA3AF;background:none;border:.5px solid #E2DDD6;
                border-radius:5px;padding:.3rem .75rem;cursor:pointer;font-family:'Inter',sans-serif;
              ">Disconnect</button>
            </div>`
          : `<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
              <span style="font-size:13px;color:#6B7280;">Not connected</span>
              <button id="up-gcal-connect" style="
                font-size:12.5px;color:#fff;background:#1C2B3A;border:none;
                border-radius:5px;padding:.35rem .85rem;cursor:pointer;font-family:'Inter',sans-serif;font-weight:500;
              ">Connect Google Calendar</button>
            </div>`}
        <div id="up-gcal-status" style="font-size:12px;color:#6B7280;margin-top:6px;min-height:16px;"></div>
      </div>

      <!-- Mobile Settings (mobile only) -->
      <div id="up-mobile-settings" style="background:#fff;border:.5px solid #E2DDD6;border-radius:8px;padding:1.1rem 1.2rem;margin-bottom:1rem;display:none;">
        <div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.75rem;">Mobile Settings</div>
        <label style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;">
          <div>
            <div style="font-size:13px;font-weight:500;color:#1C2B3A;">Dark Mode</div>
            <div style="font-size:12px;color:#9CA3AF;margin-top:2px;">Easier reading in low light</div>
          </div>
          <input type="checkbox" id="up-dark-mode-toggle" ${_profile?.dark_mode ? 'checked' : ''} style="
            width:36px;height:20px;appearance:none;-webkit-appearance:none;
            background:${_profile?.dark_mode ? '#1C2B3A' : '#D1C9BE'};
            border-radius:10px;position:relative;cursor:pointer;transition:background .2s;flex-shrink:0;
          " />
        </label>
        <div id="up-dark-mode-status" style="font-size:12px;color:#6B7280;margin-top:6px;min-height:14px;"></div>
      </div>

      <!-- Calendar Color -->
      <div style="background:#fff;border:.5px solid #E2DDD6;border-radius:8px;padding:1.1rem 1.2rem;margin-bottom:1.5rem;">
        <div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.75rem;">Calendar Color</div>
        <div style="font-size:12.5px;color:#6B7280;margin-bottom:.65rem;">Color used for your personal Google Calendar events on the dashboard.</div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:.65rem;">
          ${['#C9A84C','#8B1A2F','#1C2B3A','#2D6A4F','#1D4ED8','#7C3AED','#DB2777','#6B7280'].map(col => `
            <label style="margin:0;cursor:pointer;" title="${col}">
              <input type="radio" name="cal-color-pick" value="${col}" ${(_profile?.calendar_color || '#C9A84C') === col ? 'checked' : ''}
                style="display:none;" />
              <span class="cal-color-swatch" style="
                display:block;width:22px;height:22px;border-radius:50%;background:${col};
                outline:${(_profile?.calendar_color || '#C9A84C') === col ? '2.5px solid #1C2B3A' : '2.5px solid transparent'};
                outline-offset:2px;cursor:pointer;transition:outline .12s;
              " onclick="
                this.previousElementSibling.click();
                document.querySelectorAll('.cal-color-swatch').forEach(s=>{
                  s.style.outline=s.previousElementSibling.checked?'2.5px solid #1C2B3A':'2.5px solid transparent';
                });
              "></span>
            </label>`).join('')}
        </div>
        <button id="up-cal-color-save" style="
          font-size:12.5px;color:#fff;background:#1C2B3A;border:none;
          border-radius:5px;padding:.35rem .85rem;cursor:pointer;font-family:'Inter',sans-serif;font-weight:500;
        ">Save Color</button>
        <span id="up-cal-color-status" style="font-size:12px;color:#6B7280;margin-left:10px;"></span>
      </div>

    </div>
  `;

  _bindEvents();
}

function _initials(str) {
  if (!str) return '?';
  const parts = str.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ── Events ─────────────────────────────────────────────────────────────────

function _bindEvents() {
  // File upload
  document.getElementById('up-file-input')?.addEventListener('change', _handleUpload);

  // Remove photo
  document.getElementById('up-remove-photo')?.addEventListener('click', _removePhoto);

  // Change password
  document.getElementById('up-change-pw')?.addEventListener('click', _changePassword);

  // Google Calendar
  document.getElementById('up-gcal-connect')?.addEventListener('click', _connectGoogle);
  document.getElementById('up-gcal-disconnect')?.addEventListener('click', _disconnectGoogle);

  // Mobile Settings: show only on narrow viewports
  const mobileSection = document.getElementById('up-mobile-settings');
  if (mobileSection && window.innerWidth < 768) mobileSection.style.display = 'block';

  // Dark mode toggle
  document.getElementById('up-dark-mode-toggle')?.addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    e.target.style.background = enabled ? '#1C2B3A' : '#D1C9BE';
    if (window.innerWidth < 768) {
      document.body.classList.toggle('dark-mode', enabled);
    }
    const statusEl = document.getElementById('up-dark-mode-status');
    const { error } = await _upsertProfile({ dark_mode: enabled });
    if (error) { statusEl.textContent = 'Failed to save.'; return; }
    _profile = { ..._profile, dark_mode: enabled };
    store.currentUserProfile = _profile;
    statusEl.textContent = 'Saved.';
    setTimeout(() => { statusEl.textContent = ''; }, 1500);
  });

  // Calendar color
  document.getElementById('up-cal-color-save')?.addEventListener('click', async () => {
    const statusEl = document.getElementById('up-cal-color-status');
    const selected = document.querySelector('input[name="cal-color-pick"]:checked')?.value;
    if (!selected) return;
    statusEl.textContent = 'Saving…';
    statusEl.style.color = '#6B7280';
    const { error } = await _upsertProfile({ calendar_color: selected });
    if (error) { statusEl.textContent = 'Failed.'; statusEl.style.color = '#E74C3C'; return; }
    _profile = { ..._profile, calendar_color: selected };
    store.currentUserProfile = _profile;
    statusEl.textContent = 'Saved.';
    statusEl.style.color = '#2D6A4F';
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
  });
}

async function _handleUpload(e) {
  const file = e.target.files?.[0];
  if (!file || !_user) return;

  const statusEl = document.getElementById('up-upload-status');
  statusEl.textContent = 'Uploading…';

  const path = `${_user.id}/avatar.png`;
  const { error: upErr } = await sb.storage.from('avatars').upload(path, file, {
    upsert: true,
    contentType: file.type,
  });
  if (upErr) { statusEl.textContent = 'Upload failed: ' + upErr.message; return; }

  const { data: urlData } = sb.storage.from('avatars').getPublicUrl(path);
  if (!urlData?.publicUrl) { statusEl.textContent = 'Upload succeeded but could not get public URL.'; return; }
  // Bust cache so the browser fetches the new image
  const avatarUrl = urlData.publicUrl + '?t=' + Date.now();

  const { error } = await _upsertProfile({ avatar_url: avatarUrl });
  if (error) { statusEl.textContent = 'Save failed: ' + error.message; return; }

  _profile = { ..._profile, avatar_url: avatarUrl };
  store.currentUserProfile = _profile;
  statusEl.textContent = '';
  _render();
  _notifySidebarWidget();
}

async function _removePhoto() {
  if (!confirm('Remove your profile photo?')) return;
  const { error } = await _upsertProfile({ avatar_url: null });
  if (error) { alert('Failed to remove photo: ' + error.message); return; }

  if (_user) {
    await sb.storage.from('avatars').remove([`${_user.id}/avatar.png`]);
  }

  _profile = { ..._profile, avatar_url: null };
  store.currentUserProfile = _profile;
  _render();
  _notifySidebarWidget();
}

async function _saveContactInfo() {
  const personnelId = _profile?.personnel_id;
  if (!personnelId) {
    alert('Please link a directory entry first before saving contact information.');
    return;
  }
  const btn = document.getElementById('up-save-contact');
  const statusEl = document.getElementById('up-contact-status');
  if (btn) btn.disabled = true;
  statusEl.style.color = '#6B7280';
  statusEl.textContent = 'Saving…';

  try {
    const phone = normalizePhone(document.getElementById('up-phone')?.value.trim()) || null;
    const email = document.getElementById('up-contact-email')?.value.trim() || null;
    const date_of_birth = document.getElementById('up-dob')?.value || null;

    const { error } = await sb.from('personnel')
      .update({ phone, email, date_of_birth, updated_at: new Date().toISOString() })
      .eq('id', personnelId);

    if (error) throw error;

    // Update in-memory personnel store so other panels see the change
    const p = (store.personnel || []).find(p => p.id === personnelId);
    if (p) { p.phone = phone; p.email = email; p.date_of_birth = date_of_birth; }
    if (_profile?.personnel) { _profile.personnel.phone = phone; _profile.personnel.email = email; _profile.personnel.date_of_birth = date_of_birth; }

    statusEl.style.color = '#166534';
    statusEl.textContent = 'Saved successfully.';
    setTimeout(() => { if (statusEl) { statusEl.textContent = ''; statusEl.style.color = '#6B7280'; } }, 3000);
  } catch (err) {
    statusEl.style.color = '#8B1A2F';
    statusEl.textContent = 'Save failed: ' + (err.message || 'unknown error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function _changePassword() {
  const statusEl = document.getElementById('up-pw-status');
  statusEl.textContent = 'Sending…';
  const { error } = await sb.auth.resetPasswordForEmail(_user.email);
  if (error) { statusEl.textContent = 'Error: ' + error.message; return; }
  statusEl.textContent = 'Password reset email sent — check your inbox.';
}

async function _connectGoogle() {
  const statusEl = document.getElementById('up-gcal-status');
  statusEl.textContent = 'Loading…';
  try {
    const res = await fetch('/config');
    if (!res.ok) {
      throw new Error(`/config returned ${res.status} ${res.statusText} — is it deployed?`);
    }
    let cfg;
    try {
      cfg = await res.json();
    } catch (jsonErr) {
      throw new Error(`/config response is not valid JSON (status ${res.status}) — body may be an HTML error page`);
    }
    const { googleClientId } = cfg;
    if (!googleClientId) { statusEl.textContent = 'Google Calendar is not configured — set GOOGLE_CLIENT_ID in Cloudflare env vars.'; return; }

    const params = new URLSearchParams({
      client_id:     googleClientId,
      redirect_uri:  'https://parishdesk.pages.dev/auth/google/callback',
      response_type: 'code',
      scope:         'https://www.googleapis.com/auth/calendar',
      access_type:   'offline',
      prompt:        'consent',
      state:         _user.id,
    });
    const oauthUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
    console.log('[connectGoogle] redirecting to:', oauthUrl);
    window.location.href = oauthUrl;
  } catch (e) {
    console.error('[connectGoogle] failed:', e);
    statusEl.textContent = 'Error: ' + e.message;
  }
}

async function _disconnectGoogle() {
  if (!confirm('Disconnect Google Calendar? You can reconnect at any time.')) return;
  const statusEl = document.getElementById('up-gcal-status');
  statusEl.textContent = 'Disconnecting…';

  const { error } = await sb.from('calendars')
    .delete()
    .eq('user_id', _user.id)
    .eq('type', 'google')
    .eq('scope', 'personal');

  if (error) { statusEl.textContent = 'Error: ' + error.message; return; }
  _googleCal = null;
  _render();
}

async function _upsertProfile(fields) {
  if (!_user) return { error: new Error('No user') };
  const payload = { user_id: _user.id, ...fields, updated_at: new Date().toISOString() };
  return sb.from('user_profiles').upsert(payload, { onConflict: 'user_id' });
}

// Exposed for inline onclick
window._upSaveContact = _saveContactInfo;

function _notifySidebarWidget() {
  // Dispatch a custom event so the sidebar widget can re-render
  document.dispatchEvent(new CustomEvent('userProfileUpdated', { detail: _profile }));
}
