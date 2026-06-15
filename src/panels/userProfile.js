import { sb } from '../supabase.js';
import { store } from '../store.js';
import { createContactPicker } from '../ui/contactPicker.js';
import { clearUserScope } from '../ui/userScope.js';

let _user = null;
let _profile = null;
let _picker = null;
let _pendingPersonnelId = undefined; // undefined = no change, null = unlink, uuid = link

// ── Public entry point ─────────────────────────────────────────────────────

export async function loadUserProfile() {
  const { data: { user } } = await sb.auth.getUser();
  _user = user;
  if (!user) return;

  const { data } = await sb.from('user_profiles')
    .select('*, personnel(id,name,title,phone,email)')
    .eq('user_id', user.id)
    .maybeSingle();
  _profile = data || null;
  store.currentUserProfile = _profile;

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
        <div id="up-link-display">
          ${linkedPerson
            ? `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                <div>
                  <div style="font-size:14px;font-weight:500;color:#1C2B3A;">${linkedPerson.name}</div>
                  ${linkedPerson.title ? `<div style="font-size:12px;color:#6B7280;margin-top:1px;">${linkedPerson.title}</div>` : ''}
                </div>
                <button id="up-change-link" style="
                  font-size:12px;color:#8B1A2F;background:none;border:.5px solid #E2DDD6;
                  border-radius:5px;padding:.3rem .7rem;cursor:pointer;font-family:'Inter',sans-serif;
                  white-space:nowrap;
                ">Change</button>
              </div>`
            : `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                <span style="font-size:13px;color:#9CA3AF;font-style:italic;">Not linked</span>
                <button id="up-link-btn" style="
                  font-size:12px;color:#8B1A2F;background:none;border:.5px solid #E2DDD6;
                  border-radius:5px;padding:.3rem .7rem;cursor:pointer;font-family:'Inter',sans-serif;
                  white-space:nowrap;
                ">Link to Directory</button>
              </div>`}
        </div>
        <div id="up-picker-area" style="display:none;margin-top:.75rem;">
          <div id="up-picker-cp"></div>
          <div style="display:flex;gap:8px;margin-top:8px;">
            <button id="up-picker-save" style="
              padding:.35rem .85rem;background:#1C2B3A;color:#fff;border:none;
              border-radius:5px;font-size:12.5px;font-family:'Inter',sans-serif;cursor:pointer;
            ">Save link</button>
            <button id="up-picker-cancel" style="
              padding:.35rem .85rem;background:none;color:#6B7280;
              border:.5px solid #D1C9BE;border-radius:5px;font-size:12.5px;
              font-family:'Inter',sans-serif;cursor:pointer;
            ">Cancel</button>
          </div>
        </div>
        <div style="font-size:11.5px;color:#9CA3AF;margin-top:.75rem;">An administrator can also link your account from Admin Settings.</div>
      </div>

      <!-- Contact Information -->
      <div style="background:#fff;border:.5px solid #E2DDD6;border-radius:8px;padding:1.1rem 1.2rem;margin-bottom:1rem;">
        <div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.75rem;">Contact Information</div>
        ${!linkedPerson ? `<div style="font-size:13px;color:#9CA3AF;font-style:italic;">Link a directory entry above to edit contact information.</div>` : `
        <div style="display:flex;flex-direction:column;gap:.65rem;">
          <div>
            <div style="font-size:11.5px;color:#6B7280;margin-bottom:4px;">Phone</div>
            <input id="up-phone" value="${linkedPerson.phone || ''}" placeholder="e.g. (601) 555-0100" style="
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
          <div style="display:flex;align-items:center;gap:12px;margin-top:.25rem;">
            <button id="up-save-contact" style="
              padding:.4rem 1rem;background:#1C2B3A;color:#fff;border:none;
              border-radius:5px;font-size:13px;font-family:'Inter',sans-serif;
              cursor:pointer;font-weight:500;
            ">Save</button>
            <div id="up-contact-status" style="font-size:12px;color:#6B7280;min-height:16px;"></div>
          </div>
        </div>`}
      </div>

      <!-- Account -->
      <div style="background:#fff;border:.5px solid #E2DDD6;border-radius:8px;padding:1.1rem 1.2rem;margin-bottom:1.5rem;">
        <div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.75rem;">Account</div>
        <div style="font-size:13px;color:#6B7280;margin-bottom:.75rem;">${email}</div>
        <button id="up-change-pw" style="
          font-size:12.5px;color:#8B1A2F;background:none;border:.5px solid #E2DDD6;
          border-radius:5px;padding:.35rem .85rem;cursor:pointer;font-family:'Inter',sans-serif;
        ">Change Password</button>
        <div id="up-pw-status" style="font-size:12px;color:#6B7280;margin-top:6px;min-height:16px;"></div>
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

  // Link / Change buttons
  document.getElementById('up-link-btn')?.addEventListener('click', _showPicker);
  document.getElementById('up-change-link')?.addEventListener('click', _showPicker);

  // Picker confirm/cancel
  document.getElementById('up-picker-save')?.addEventListener('click', _saveLink);
  document.getElementById('up-picker-cancel')?.addEventListener('click', _hidePicker);

  // Contact info save
  document.getElementById('up-save-contact')?.addEventListener('click', _saveContactInfo);

  // Change password
  document.getElementById('up-change-pw')?.addEventListener('click', _changePassword);
}

function _showPicker() {
  document.getElementById('up-picker-area').style.display = 'block';
  _picker = createContactPicker({
    container: document.getElementById('up-picker-cp'),
    placeholder: 'Search directory…',
    prefillEmail: _user?.email || '',
    onSelect: () => {},
  });
}

function _hidePicker() {
  document.getElementById('up-picker-area').style.display = 'none';
  _picker = null;
}

async function _saveLink() {
  if (!_picker) return;
  const person = _picker.getValue();
  if (!person) { alert('Please select a person from the directory.'); return; }

  const { error } = await _upsertProfile({ personnel_id: person.id });
  if (error) { alert('Failed to save: ' + error.message); return; }

  // Re-fetch so the profile has the full personnel record (phone, email, etc.)
  const { data } = await sb.from('user_profiles')
    .select('*, personnel(id,name,title,phone,email)')
    .eq('user_id', _user.id)
    .maybeSingle();
  _profile = data || { ..._profile, personnel_id: person.id, personnel: person };
  store.currentUserProfile = _profile;
  clearUserScope();
  _render();
  _notifySidebarWidget();
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
  const statusEl = document.getElementById('up-contact-status');
  statusEl.textContent = 'Saving…';

  const phone = document.getElementById('up-phone')?.value.trim() || null;
  const email = document.getElementById('up-contact-email')?.value.trim() || null;

  const { error } = await sb.from('personnel')
    .update({ phone, email, updated_at: new Date().toISOString() })
    .eq('id', personnelId);

  if (error) { statusEl.textContent = 'Save failed: ' + error.message; return; }

  // Update in-memory personnel store so other panels see the change
  const p = (store.personnel || []).find(p => p.id === personnelId);
  if (p) { p.phone = phone; p.email = email; }
  if (_profile?.personnel) { _profile.personnel.phone = phone; _profile.personnel.email = email; }

  statusEl.textContent = 'Contact information saved.';
  setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
}

async function _changePassword() {
  const statusEl = document.getElementById('up-pw-status');
  statusEl.textContent = 'Sending…';
  const { error } = await sb.auth.resetPasswordForEmail(_user.email);
  if (error) { statusEl.textContent = 'Error: ' + error.message; return; }
  statusEl.textContent = 'Password reset email sent — check your inbox.';
}

async function _upsertProfile(fields) {
  if (!_user) return { error: new Error('No user') };
  const payload = { user_id: _user.id, ...fields, updated_at: new Date().toISOString() };
  return sb.from('user_profiles').upsert(payload, { onConflict: 'user_id' });
}

function _notifySidebarWidget() {
  // Dispatch a custom event so the sidebar widget can re-render
  document.dispatchEvent(new CustomEvent('userProfileUpdated', { detail: _profile }));
}
