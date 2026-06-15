import { sb } from '../supabase.js';
import { store } from '../store.js';
import { createAvatar } from '../ui/avatar.js';
import { applyParishName } from '../ui/navigation.js';

const SACRAMENTS = ['baptism', 'first_communion', 'confirmation', 'ocia', 'marriage', 'annulments'];
const SACRAMENT_LABELS = { baptism: 'Baptism', first_communion: 'First Communion', confirmation: 'Confirmation', ocia: 'OCIA', marriage: 'Marriage', annulments: 'Annulments' };

// Only non-sacramental, non-auto panels that can be manually granted
const PANEL_LABELS = {
  projects: 'My Projects',
  tasks:    'Tasks',
  school:   'Cathedral School',
};

let _activeTab = 'users';
let _users = [];
let _expandedUserId = null;
let _currentAuthUserId = null;

// ── Public entry point ─────────────────────────────────────────────────────

export async function loadAdmin() {
  const { data: { user } } = await sb.auth.getUser();
  _currentAuthUserId = user?.id || null;
  _activeTab = 'users';
  _render();
  if (_activeTab === 'users') await _loadUsers();
}

// ── Data ───────────────────────────────────────────────────────────────────

async function _loadUsers() {
  // Fetch users via the admin RPC wrapper — falls back to edge function if no admin key
  const [profilesRes, rolesRes, sacramentRes, grantsRes] = await Promise.all([
    sb.from('user_profiles').select('user_id, personnel_id, avatar_url, personnel(id,name,title)'),
    sb.from('user_roles').select('user_id, role'),
    sb.from('sacramental_roles').select('user_id, sacrament'),
    sb.from('panel_grants').select('user_id, panel'),
  ]);

  const profiles  = profilesRes.data  || [];
  const roles     = rolesRes.data     || [];
  const sacraments = sacramentRes.data || [];
  const grants    = grantsRes.data    || [];

  // Build a map keyed by user_id
  const map = {};
  profiles.forEach(p => {
    map[p.user_id] = { userId: p.user_id, profile: p, roles: [], sacraments: [], grants: [] };
  });
  // Include users with roles but no profile yet
  roles.forEach(r => {
    if (!map[r.user_id]) map[r.user_id] = { userId: r.user_id, profile: null, roles: [], sacraments: [], grants: [] };
    map[r.user_id].roles.push(r.role);
  });
  sacraments.forEach(r => {
    if (!map[r.user_id]) map[r.user_id] = { userId: r.user_id, profile: null, roles: [], sacraments: [], grants: [] };
    map[r.user_id].sacraments.push(r.sacrament);
  });
  grants.forEach(r => {
    if (map[r.user_id]) map[r.user_id].grants.push(r.panel);
  });

  _users = Object.values(map).sort((a, b) => {
    const aName = a.profile?.personnel?.name;
    const bName = b.profile?.personnel?.name;
    if (aName && !bName) return -1;
    if (!aName && bName) return 1;
    const aKey = (aName || a.userId).toLowerCase();
    const bKey = (bName || b.userId).toLowerCase();
    return aKey.localeCompare(bKey);
  });
  _renderUsersTab();
}

// ── Render ─────────────────────────────────────────────────────────────────

function _render() {
  const el = document.getElementById('admin-root');
  if (!el) return;

  const TABS = [
    { key: 'users',    label: 'Users' },
    { key: 'settings', label: 'Parish Settings' },
    { key: 'invite',   label: 'Invite User' },
  ];

  el.innerHTML = `
    <div style="max-width:800px;margin:0 auto;">
      <div style="display:flex;gap:0;border-bottom:1.5px solid #E2DDD6;margin-bottom:1.5rem;overflow-x:auto;">
        ${TABS.map(t => `
          <button class="admin-tab" data-tab="${t.key}" style="
            background:none;border:none;border-bottom:2.5px solid ${t.key === _activeTab ? '#8B1A2F' : 'transparent'};
            padding:.55rem 1.1rem;font-size:13px;font-family:'Inter',sans-serif;font-weight:500;
            color:${t.key === _activeTab ? '#1C2B3A' : '#9CA3AF'};cursor:pointer;white-space:nowrap;
            margin-bottom:-1.5px;transition:color .12s,border-color .12s;
          ">${t.label}</button>
        `).join('')}
      </div>
      <div id="admin-tab-content"></div>
    </div>
  `;

  document.querySelectorAll('.admin-tab').forEach(btn => {
    btn.addEventListener('click', async () => {
      _activeTab = btn.dataset.tab;
      _expandedUserId = null;
      document.querySelectorAll('.admin-tab').forEach(b => {
        b.style.borderBottomColor = b.dataset.tab === _activeTab ? '#8B1A2F' : 'transparent';
        b.style.color = b.dataset.tab === _activeTab ? '#1C2B3A' : '#9CA3AF';
      });
      if (_activeTab === 'users')    { _renderUsersTab(); await _loadUsers(); }
      if (_activeTab === 'settings') await _renderSettingsTab();
      if (_activeTab === 'invite')   _renderInviteTab();
    });
  });

  if (_activeTab === 'settings') _renderSettingsTab();
  else if (_activeTab === 'invite') _renderInviteTab();
  else _renderUsersTab();
}

// ── Users tab ──────────────────────────────────────────────────────────────

function _renderUsersTab() {
  const el = document.getElementById('admin-tab-content');
  if (!el) return;

  if (!_users.length) {
    el.innerHTML = '<div style="font-size:13px;color:#9CA3AF;font-style:italic;padding:1rem 0;">Loading users…</div>';
    return;
  }

  el.innerHTML = `<div id="admin-user-list">${_users.map(_userRow).join('')}</div>`;

  // Hydrate avatar placeholders — can't call createAvatar() inside innerHTML strings
  el.querySelectorAll('.admin-avatar-slot').forEach(slot => {
    const { uid, name, url } = slot.dataset;
    slot.innerHTML = '';
    createAvatar({ container: slot, userId: uid, name: name || uid, size: 36 });
  });

  document.querySelectorAll('.admin-user-row').forEach(row => {
    row.addEventListener('click', () => {
      const uid = row.dataset.userId;
      _expandedUserId = _expandedUserId === uid ? null : uid;
      _renderUsersTab();
    });
  });
}

function _userRow(u) {
  const name = u.profile?.personnel?.name || '—';
  const avatarUrl = u.profile?.avatar_url || null;
  const isExpanded = _expandedUserId === u.userId;

  const roleBadges = [
    ...u.roles.map(r => `<span style="font-size:10.5px;font-weight:600;background:${r === 'super_admin' ? '#1C2B3A' : '#F3F4F6'};color:${r === 'super_admin' ? '#F8F7F4' : '#4B5563'};border-radius:20px;padding:2px 8px;">${r === 'super_admin' ? 'Super Admin' : r}</span>`),
    ...u.sacraments.map(s => `<span style="font-size:10.5px;font-weight:600;background:#FDF3D0;color:#7A5C00;border-radius:20px;padding:2px 8px;">${SACRAMENT_LABELS[s] || s}</span>`),
  ].join(' ');

  const avatarWrap = document.createElement('div');
  avatarWrap.style.cssText = 'flex-shrink:0;';
  // We'll inject avatars after innerHTML — use placeholder
  const avatarHtml = `<div class="admin-avatar-slot" data-uid="${u.userId}" data-name="${name}" data-url="${avatarUrl || ''}" style="width:36px;height:36px;border-radius:50%;background:#E2DDD6;flex-shrink:0;"></div>`;

  return `
    <div class="admin-user-row" data-user-id="${u.userId}" style="
      border:.5px solid #E2DDD6;border-radius:8px;margin-bottom:.6rem;
      cursor:pointer;transition:border-color .13s;overflow:hidden;
      ${isExpanded ? 'border-color:#C9A84C;' : ''}
    " onmouseover="if(!this.classList.contains('expanded'))this.style.borderColor='#C9A84C'" onmouseout="this.style.borderColor='${isExpanded ? '#C9A84C' : '#E2DDD6'}'">
      <div style="display:flex;align-items:center;gap:12px;padding:.8rem 1rem;">
        ${avatarHtml}
        <div style="flex:1;min-width:0;">
          <div style="font-size:13.5px;font-weight:500;color:#1C2B3A;">${name}</div>
          <div style="font-size:11.5px;color:#6B7280;">${u.userId}</div>
        </div>
        <div style="display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end;">${roleBadges}</div>
        <span style="color:#C9A84C;font-size:16px;flex-shrink:0;">${isExpanded ? '▾' : '›'}</span>
      </div>
      ${isExpanded ? _userDetail(u) : ''}
    </div>
  `;
}

function _userDetail(u) {
  const isSelf = u.userId === _currentAuthUserId;
  const isSA = u.roles.includes('super_admin');
  const teams = store.teams || [];

  const sacramentChecks = SACRAMENTS.map(s => `
    <div style="display:flex;align-items:center;gap:8px;padding:4px 0;">
      <input type="checkbox" class="au-sac-cb" data-sacrament="${s}" ${u.sacraments.includes(s) ? 'checked' : ''}
        style="width:14px;height:14px;accent-color:#8B1A2F;margin:0;cursor:pointer;flex-shrink:0;" />
      <span style="font-size:13px;color:#1C2B3A;">${SACRAMENT_LABELS[s]}</span>
    </div>`).join('');

  const grantChecks = Object.entries(PANEL_LABELS).map(([p, label]) => `
    <div style="display:flex;align-items:center;gap:8px;padding:4px 0;">
      <input type="checkbox" class="au-grant-cb" data-panel="${p}" ${u.grants.includes(p) ? 'checked' : ''}
        style="width:14px;height:14px;accent-color:#8B1A2F;margin:0;cursor:pointer;flex-shrink:0;" />
      <span style="font-size:13px;color:#1C2B3A;">${label}</span>
    </div>`).join('');

  const teamChecks = teams.map(t => {
    const isMember = (store.currentUserRoles?.teamIds || []).includes(t.id); // placeholder — not per-user
    return `
    <div style="display:flex;align-items:center;gap:8px;padding:4px 0;">
      <input type="checkbox" class="au-team-cb" data-team-id="${t.id}" data-personnel-id="${u.profile?.personnel_id || ''}"
        style="width:14px;height:14px;accent-color:#8B1A2F;margin:0;cursor:pointer;flex-shrink:0;" />
      <span style="font-size:13px;color:#1C2B3A;">${t.name}</span>
    </div>`;
  }).join('');

  return `
    <div class="admin-user-detail" data-user-id="${u.userId}" style="border-top:.5px solid #F0EDE8;padding:1rem 1.1rem;background:#FAFAF8;" onclick="event.stopPropagation()">
      ${u.profile?.personnel ? `
        <div style="margin-bottom:1rem;">
          <div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.4rem;">Directory Entry</div>
          <div style="font-size:13.5px;font-weight:500;color:#1C2B3A;">${u.profile.personnel.name}</div>
          ${u.profile.personnel.title ? `<div style="font-size:12px;color:#6B7280;">${u.profile.personnel.title}</div>` : ''}
        </div>` : ''}

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1.25rem;margin-bottom:1rem;">
        <div>
          <div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.5rem;">System Role</div>
          <div style="display:flex;align-items:center;gap:8px;padding:4px 0;">
            <input type="checkbox" id="au-sa-${u.userId}" class="au-sa-cb" ${isSA ? 'checked' : ''} ${isSelf ? 'disabled title="Cannot remove own super admin role"' : ''}
              style="width:14px;height:14px;accent-color:#1C2B3A;margin:0;cursor:${isSelf ? 'not-allowed' : 'pointer'};flex-shrink:0;" />
            <label for="au-sa-${u.userId}" style="font-size:13px;color:#1C2B3A;cursor:${isSelf ? 'not-allowed' : 'pointer'};margin:0;">Super Admin</label>
          </div>
        </div>
        <div>
          <div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.5rem;">Sacramental Roles</div>
          ${sacramentChecks}
        </div>
        <div>
          <div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.5rem;">Panel Grants</div>
          ${grantChecks}
        </div>
      </div>

      ${teams.length ? `
      <div style="margin-bottom:1rem;">
        <div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.5rem;">Team Memberships</div>
        <div style="display:flex;flex-wrap:wrap;gap:0 1.5rem;">${teamChecks}</div>
      </div>` : ''}

      <div style="display:flex;align-items:center;gap:12px;margin-top:.5rem;">
        <button class="au-save-btn" data-user-id="${u.userId}" style="
          padding:.4rem 1.1rem;background:#1C2B3A;color:#fff;border:none;
          border-radius:5px;font-size:13px;font-family:'Inter',sans-serif;
          cursor:pointer;font-weight:500;
        ">Save</button>
        <div class="au-status" style="font-size:12px;color:#6B7280;min-height:16px;"></div>
      </div>
    </div>
  `;
}

// ── User save ──────────────────────────────────────────────────────────────

async function _saveUser(userId) {
  const detail = document.querySelector(`.admin-user-detail[data-user-id="${userId}"]`);
  if (!detail) return;
  const statusEl = detail.querySelector('.au-status');
  statusEl.textContent = 'Saving…';

  const isSelf = userId === _currentAuthUserId;
  const u = _users.find(x => x.userId === userId);

  // Super admin role
  const wantsSA = detail.querySelector('.au-sa-cb')?.checked;
  if (!isSelf) {
    if (wantsSA && !u.roles.includes('super_admin')) {
      await sb.from('user_roles').upsert({ user_id: userId, role: 'super_admin' }, { onConflict: 'user_id,role' });
    } else if (!wantsSA && u.roles.includes('super_admin')) {
      await sb.from('user_roles').delete().eq('user_id', userId).eq('role', 'super_admin');
    }
  }

  // Sacramental roles
  const checkedSacraments = Array.from(detail.querySelectorAll('.au-sac-cb:checked')).map(cb => cb.dataset.sacrament);
  await sb.from('sacramental_roles').delete().eq('user_id', userId);
  if (checkedSacraments.length) {
    await sb.from('sacramental_roles').insert(checkedSacraments.map(s => ({ user_id: userId, sacrament: s })));
  }

  // Panel grants
  const checkedGrants = Array.from(detail.querySelectorAll('.au-grant-cb:checked')).map(cb => cb.dataset.panel);
  await sb.from('panel_grants').delete().eq('user_id', userId);
  if (checkedGrants.length) {
    await sb.from('panel_grants').insert(checkedGrants.map(p => ({ user_id: userId, panel: p })));
  }

  // Team memberships — only if user has a linked personnel_id
  const personnelId = u?.profile?.personnel_id;
  if (personnelId) {
    const checkedTeams = Array.from(detail.querySelectorAll('.au-team-cb:checked')).map(cb => cb.dataset.teamId);
    const uncheckedTeams = Array.from(detail.querySelectorAll('.au-team-cb:not(:checked)')).map(cb => cb.dataset.teamId);
    for (const teamId of checkedTeams) {
      await sb.from('team_members').upsert({ team_id: teamId, personnel_id: personnelId }, { onConflict: 'team_id,personnel_id' });
    }
    for (const teamId of uncheckedTeams) {
      await sb.from('team_members').delete().eq('team_id', teamId).eq('personnel_id', personnelId);
    }
  }

  statusEl.textContent = 'Saved.';
  setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
  await _loadUsers();
}

// ── Parish Settings tab ────────────────────────────────────────────────────

async function _renderSettingsTab() {
  const el = document.getElementById('admin-tab-content');
  if (!el) return;
  el.innerHTML = '<div style="font-size:13px;color:#9CA3AF;">Loading…</div>';

  const { data, error } = await sb.from('parish_settings').select('*').limit(1).maybeSingle();
  if (error) { el.innerHTML = `<div style="color:#E74C3C;font-size:13px;">Error: ${error.message}</div>`; return; }

  el.innerHTML = `
    <div style="background:#fff;border:.5px solid #E2DDD6;border-radius:8px;padding:1.2rem 1.4rem;max-width:480px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;margin-bottom:1rem;">Parish Settings</div>
      <label style="display:block;font-size:11.5px;color:#6B7280;margin-bottom:3px;">Parish Name</label>
      <input id="ps-name" value="${data?.parish_name || ''}" style="
        width:100%;box-sizing:border-box;padding:.4rem .65rem;border:.5px solid #D1C9BE;
        border-radius:5px;font-size:13px;font-family:'Inter',sans-serif;outline:none;margin-bottom:.5rem;
      " />
      <div style="font-size:11.5px;color:#9CA3AF;margin-bottom:1rem;line-height:1.5;">
        This name appears on the login screen, top of the navigation sidebar, and identifies your parish institution in the Directory.
      </div>
      <div style="display:flex;align-items:center;gap:12px;">
        <button id="ps-save" style="
          padding:.4rem 1.1rem;background:#1C2B3A;color:#fff;border:none;
          border-radius:5px;font-size:13px;font-family:'Inter',sans-serif;cursor:pointer;font-weight:500;
        ">Save</button>
        <div id="ps-status" style="font-size:12px;color:#6B7280;min-height:16px;"></div>
      </div>
    </div>
  `;

  document.getElementById('ps-save').addEventListener('click', async () => {
    const statusEl = document.getElementById('ps-status');
    statusEl.textContent = 'Saving…';
    const name = document.getElementById('ps-name').value.trim();
    if (!name) { statusEl.textContent = 'Parish name is required.'; return; }
    const payload = { parish_name: name, primary_institution: name };
    const { error } = data
      ? await sb.from('parish_settings').update(payload).eq('id', data.id)
      : await sb.from('parish_settings').insert(payload);
    if (error) { statusEl.textContent = 'Error: ' + error.message; return; }
    store.parishSettings = { ...data, ...payload };
    applyParishName(name);
    statusEl.textContent = 'Saved.';
    setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
  });
}

// ── Invite tab ─────────────────────────────────────────────────────────────

function _renderInviteTab() {
  const el = document.getElementById('admin-tab-content');
  if (!el) return;
  el.innerHTML = `
    <div style="background:#fff;border:.5px solid #E2DDD6;border-radius:8px;padding:1.2rem 1.4rem;max-width:420px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;margin-bottom:1rem;">Invite New User</div>
      <label style="display:block;font-size:11.5px;color:#6B7280;margin-bottom:3px;">Email address</label>
      <input id="inv-email" type="email" placeholder="name@parish.org" style="
        width:100%;box-sizing:border-box;padding:.4rem .65rem;border:.5px solid #D1C9BE;
        border-radius:5px;font-size:13px;font-family:'Inter',sans-serif;outline:none;margin-bottom:1rem;
      " />
      <div style="display:flex;align-items:center;gap:12px;">
        <button id="inv-send" style="
          padding:.4rem 1.1rem;background:#1C2B3A;color:#fff;border:none;
          border-radius:5px;font-size:13px;font-family:'Inter',sans-serif;cursor:pointer;font-weight:500;
        ">Send Invite</button>
        <div id="inv-status" style="font-size:12px;color:#6B7280;min-height:16px;"></div>
      </div>
      <div style="font-size:11.5px;color:#9CA3AF;margin-top:.85rem;line-height:1.5;">
        Invited users receive basic access only. Assign roles in the Users tab after they accept.
      </div>
    </div>
  `;

  document.getElementById('inv-send').addEventListener('click', async () => {
    const email = document.getElementById('inv-email').value.trim();
    const statusEl = document.getElementById('inv-status');
    if (!email) { statusEl.textContent = 'Email is required.'; return; }
    statusEl.textContent = 'Sending…';
    const { error } = await sb.auth.admin.inviteUserByEmail(email);
    if (error) { statusEl.textContent = 'Error: ' + error.message; return; }
    statusEl.style.color = '#2E7D32';
    statusEl.textContent = `Invite sent to ${email}`;
    document.getElementById('inv-email').value = '';
  });
}

// ── Expose save handler globally ───────────────────────────────────────────

document.addEventListener('click', e => {
  const btn = e.target.closest('.au-save-btn');
  if (btn) _saveUser(btn.dataset.userId);
});
