import { sb } from '../supabase.js';
import { store } from '../store.js';
import { createAvatar } from '../ui/avatar.js';
import { applyParishName } from '../ui/navigation.js';
import { createContactPicker } from '../ui/contactPicker.js';

const SACRAMENTS = ['baptism', 'first_communion', 'confirmation', 'ocia', 'marriage', 'annulments'];
const SACRAMENT_LABELS = { baptism: 'Baptism', first_communion: 'First Communion', confirmation: 'Confirmation', ocia: 'OCIA', marriage: 'Marriage', annulments: 'Annulments' };

// Only non-sacramental, non-auto panels that can be manually granted
// (projects and tasks are always available — no grant needed)
const PANEL_LABELS = {
  school: 'Cathedral School',
};

let _activeTab = 'users';
let _users = [];
let _expandedUserId = null;
let _currentAuthUserId = null;

const CAL_PRESETS = ['#1C2B3A', '#8B1A2F', '#2E7D32', '#1565C0', '#6A1B9A', '#E65100'];

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
  const [profilesRes, rolesRes, sacramentRes, grantsRes, teamMembersRes, authRes] = await Promise.all([
    sb.from('user_profiles').select('user_id, personnel_id, avatar_url, personnel(id,name,title)'),
    sb.from('user_roles').select('user_id, role'),
    sb.from('sacramental_roles').select('user_id, sacrament'),
    sb.from('panel_grants').select('user_id, panel'),
    sb.from('team_members').select('team_id, personnel_id'),
    fetch('/functions/admin-users').then(r => r.ok ? r.json() : { users: [] }).catch(() => ({ users: [] })),
  ]);

  const profiles   = profilesRes.data  || [];
  const roles      = rolesRes.data     || [];
  const sacraments = sacramentRes.data || [];
  const grants     = grantsRes.data    || [];
  const authUsers  = authRes.users     || [];

  // Build personnel_id → team_id[] index
  const teamsByPersonnel = {};
  (teamMembersRes.data || []).forEach(tm => {
    if (!teamsByPersonnel[tm.personnel_id]) teamsByPersonnel[tm.personnel_id] = [];
    teamsByPersonnel[tm.personnel_id].push(tm.team_id);
  });

  // Build email lookup from auth users
  const emailById = {};
  authUsers.forEach(u => { emailById[u.id] = u.email || null; });

  // Build a map keyed by user_id
  const map = {};
  profiles.forEach(p => {
    const pid = p.personnel_id;
    map[p.user_id] = { userId: p.user_id, email: emailById[p.user_id] || null, profile: p, roles: [], sacraments: [], grants: [], teamIds: pid ? (teamsByPersonnel[pid] || []) : [] };
  });
  roles.forEach(r => {
    if (!map[r.user_id]) map[r.user_id] = { userId: r.user_id, email: emailById[r.user_id] || null, profile: null, roles: [], sacraments: [], grants: [], teamIds: [] };
    map[r.user_id].roles.push(r.role);
  });
  sacraments.forEach(r => {
    if (!map[r.user_id]) map[r.user_id] = { userId: r.user_id, email: emailById[r.user_id] || null, profile: null, roles: [], sacraments: [], grants: [], teamIds: [] };
    map[r.user_id].sacraments.push(r.sacrament);
  });
  grants.forEach(r => {
    if (map[r.user_id]) map[r.user_id].grants.push(r.panel);
  });
  // Include auth users not yet in map (invited but no profile/roles yet)
  authUsers.forEach(au => {
    if (!map[au.id]) map[au.id] = { userId: au.id, email: au.email || null, profile: null, roles: [], sacraments: [], grants: [], teamIds: [] };
  });

  const lastName = name => {
    if (!name) return '';
    const parts = name.trim().split(/\s+/);
    return (parts.length > 1 ? parts[parts.length - 1] : parts[0]).toLowerCase();
  };

  _users = Object.values(map).sort((a, b) => {
    const aName = a.profile?.personnel?.name;
    const bName = b.profile?.personnel?.name;
    // Linked (have personnel name) sort before unlinked
    if (aName && !bName) return -1;
    if (!aName && bName) return 1;
    const aKey = aName ? lastName(aName) : (a.email || a.userId).toLowerCase();
    const bKey = bName ? lastName(bName) : (b.email || b.userId).toLowerCase();
    return aKey.localeCompare(bKey);
  });
  _renderUsersTab();
}

// ── Render ─────────────────────────────────────────────────────────────────

function _render() {
  const el = document.getElementById('admin-root');
  if (!el) return;

  const TABS = [
    { key: 'users',     label: 'Users' },
    { key: 'calendars', label: 'Calendars' },
    { key: 'settings',  label: 'Parish Settings' },
    { key: 'invite',    label: 'Invite User' },
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
      if (_activeTab === 'users')     { _renderUsersTab(); await _loadUsers(); }
      if (_activeTab === 'calendars') await _renderCalendarsTab();
      if (_activeTab === 'settings')  await _renderSettingsTab();
      if (_activeTab === 'invite')    _renderInviteTab();
    });
  });

  if (_activeTab === 'calendars')     _renderCalendarsTab();
  else if (_activeTab === 'settings') _renderSettingsTab();
  else if (_activeTab === 'invite')   _renderInviteTab();
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
    const { uid, name } = slot.dataset;
    slot.innerHTML = '';
    createAvatar({ container: slot, userId: uid, name: name || uid, size: 36 });
  });

  // Hydrate directory link pickers for unlinked users
  el.querySelectorAll('[id^="au-link-picker-"]').forEach(slot => {
    const userId = slot.id.replace('au-link-picker-', '');
    createContactPicker({
      container: slot,
      placeholder: 'Search directory…',
      onSelect: async (personnelId) => {
        if (!personnelId) return;
        const { error } = await sb.from('user_profiles').update({ personnel_id: personnelId }).eq('user_id', userId);
        if (error) { alert('Link failed: ' + error.message); return; }
        await _loadUsers();
      },
    });
  });

  // Change / Remove link buttons for already-linked users
  el.querySelectorAll('.au-link-change').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); _changeLinkUser(btn.dataset.userId, btn.closest('.admin-user-detail')); });
  });
  el.querySelectorAll('.au-link-remove').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); _unlinkUser(btn.dataset.userId); });
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
  const name = u.profile?.personnel?.name || u.email || u.userId;
  const avatarUrl = u.profile?.avatar_url || null;
  const isExpanded = _expandedUserId === u.userId;
  const isUnlinked = !u.profile?.personnel_id;

  const parishStaffTeam = (store.teams || []).find(t => t.name === 'Parish Staff');
  const isParishStaff = parishStaffTeam && (u.teamIds || []).includes(parishStaffTeam.id);

  const roleBadges = [
    ...u.roles.map(r => `<span style="font-size:10.5px;font-weight:600;background:${r === 'super_admin' ? '#1C2B3A' : '#F3F4F6'};color:${r === 'super_admin' ? '#F8F7F4' : '#4B5563'};border-radius:20px;padding:2px 8px;">${r === 'super_admin' ? 'Super Admin' : r}</span>`),
    ...u.sacraments.map(s => `<span style="font-size:10.5px;font-weight:600;background:#FDF3D0;color:#7A5C00;border-radius:20px;padding:2px 8px;">${SACRAMENT_LABELS[s] || s}</span>`),
    isParishStaff ? `<span style="font-size:10.5px;font-weight:600;background:#F3F4F6;color:#6B7280;border-radius:20px;padding:2px 8px;">🔒 Parish Staff</span>` : '',
    isUnlinked ? `<span style="font-size:10.5px;font-weight:600;background:#FDEAED;color:#8B1A2F;border-radius:20px;padding:2px 8px;border:.5px solid #F5C2CB;">Unlinked</span>` : '',
  ].filter(Boolean).join(' ');

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

async function _unlinkUser(userId) {
  if (!confirm('Remove this directory link?')) return;
  const { error } = await sb.from('user_profiles').update({ personnel_id: null }).eq('user_id', userId);
  if (error) { alert('Remove failed: ' + error.message); return; }
  await _loadUsers();
}

function _changeLinkUser(userId, detailEl) {
  if (!detailEl) return;
  const currentBlock = detailEl.querySelector('[data-link-block]');
  if (!currentBlock) return;
  currentBlock.innerHTML = '<div id="au-change-picker-' + userId + '"></div>';
  const slot = document.getElementById('au-change-picker-' + userId);
  if (!slot) return;
  createContactPicker({
    container: slot,
    placeholder: 'Search directory…',
    onSelect: async (personnelId) => {
      if (!personnelId) return;
      const { error } = await sb.from('user_profiles').update({ personnel_id: personnelId }).eq('user_id', userId);
      if (error) { alert('Link failed: ' + error.message); return; }
      await _loadUsers();
    },
  });
}

function _userDetail(u) {
  const isSelf = u.userId === _currentAuthUserId;
  const isSA = u.roles.includes('super_admin');
  const isAdminRole = u.roles.includes('admin');
  const teams = store.teams || [];

  const sacramentChecks = SACRAMENTS.map(s => {
    const isGranted = u.sacraments.includes(s);
    return `
    <div style="display:flex;flex-direction:column;padding:4px 0;">
      <div style="display:flex;align-items:center;gap:8px;">
        <input type="checkbox" class="au-sac-cb" data-sacrament="${s}" ${isGranted ? 'checked disabled' : ''}
          style="width:14px;height:14px;accent-color:#8B1A2F;margin:0;cursor:${isGranted ? 'not-allowed' : 'pointer'};flex-shrink:0;${isGranted ? 'opacity:0.45;' : ''}" />
        <span style="font-size:13px;color:#1C2B3A;">${SACRAMENT_LABELS[s]}</span>
      </div>
      ${isGranted ? '<div style="font-size:11px;color:#9CA3AF;font-style:italic;margin-left:22px;">Granted via Sacramental Roles</div>' : ''}
    </div>`;
  }).join('');

  const grantChecks = Object.entries(PANEL_LABELS).map(([p, label]) => {
    const lockedBySA = isSA;
    const isChecked = u.grants.includes(p) || lockedBySA;
    const note = lockedBySA ? 'Granted via Super Admin' : null;
    return `
    <div style="display:flex;flex-direction:column;padding:4px 0;">
      <div style="display:flex;align-items:center;gap:8px;">
        <input type="checkbox" class="au-grant-cb" data-panel="${p}" ${isChecked ? 'checked' : ''} ${lockedBySA ? 'disabled' : ''}
          style="width:14px;height:14px;accent-color:#8B1A2F;margin:0;cursor:${lockedBySA ? 'not-allowed' : 'pointer'};flex-shrink:0;${lockedBySA ? 'opacity:0.45;' : ''}" />
        <span style="font-size:13px;color:#1C2B3A;">${label}</span>
      </div>
      ${note ? `<div style="font-size:11px;color:#9CA3AF;font-style:italic;margin-left:22px;">${note}</div>` : ''}
    </div>`;
  }).join('');

  const teamChecks = teams.map(t => {
    const isMember = (u.teamIds || []).includes(t.id);
    return `
    <div style="display:flex;flex-direction:column;padding:4px 0;">
      <div style="display:flex;align-items:center;gap:8px;">
        <input type="checkbox" class="au-team-cb" data-team-id="${t.id}" data-personnel-id="${u.profile?.personnel_id || ''}"
          ${isMember ? 'checked disabled' : ''}
          style="width:14px;height:14px;accent-color:#8B1A2F;margin:0;cursor:${isMember ? 'not-allowed' : 'pointer'};flex-shrink:0;${isMember ? 'opacity:0.45;' : ''}" />
        <span style="font-size:13px;color:#1C2B3A;">${t.name}</span>
      </div>
      ${isMember ? '<div style="font-size:11px;color:#9CA3AF;font-style:italic;margin-left:22px;">Access via team membership</div>' : ''}
    </div>`;
  }).join('');

  return `
    <div class="admin-user-detail" data-user-id="${u.userId}" style="border-top:.5px solid #F0EDE8;padding:1rem 1.1rem;background:#FAFAF8;" onclick="event.stopPropagation()">
      <div style="margin-bottom:1rem;">
        <div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.5rem;">Directory Entry</div>
        <div data-link-block>
          ${u.profile?.personnel ? `
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
              <div>
                <div style="font-size:13.5px;font-weight:500;color:#1C2B3A;">${u.profile.personnel.name}</div>
                ${u.profile.personnel.title ? `<div style="font-size:12px;color:#6B7280;">${u.profile.personnel.title}</div>` : ''}
              </div>
              <div style="display:flex;gap:6px;margin-left:auto;">
                <button class="au-link-change" data-user-id="${u.userId}" style="
                  padding:.3rem .75rem;background:none;border:.5px solid #D1C9BE;border-radius:5px;
                  font-size:12px;font-family:'Inter',sans-serif;cursor:pointer;color:#1C2B3A;
                ">Change</button>
                <button class="au-link-remove" data-user-id="${u.userId}" style="
                  padding:.3rem .75rem;background:none;border:.5px solid #FDEAED;border-radius:5px;
                  font-size:12px;font-family:'Inter',sans-serif;cursor:pointer;color:#8B1A2F;
                ">Remove link</button>
              </div>
            </div>` : `
            <div id="au-link-picker-${u.userId}"></div>`}
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1.25rem;margin-bottom:1rem;">
        <div>
          <div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.5rem;">System Role</div>
          <div style="display:flex;align-items:center;gap:8px;padding:4px 0;">
            <input type="checkbox" id="au-sa-${u.userId}" class="au-sa-cb" ${isSA ? 'checked' : ''} ${isSelf ? 'disabled title="Cannot remove own super admin role"' : ''}
              style="width:14px;height:14px;accent-color:#1C2B3A;margin:0;cursor:${isSelf ? 'not-allowed' : 'pointer'};flex-shrink:0;" />
            <label for="au-sa-${u.userId}" style="font-size:13px;color:#1C2B3A;cursor:${isSelf ? 'not-allowed' : 'pointer'};margin:0;">Super Admin</label>
          </div>
          <div style="display:flex;align-items:center;gap:8px;padding:4px 0;">
            <input type="checkbox" id="au-admin-${u.userId}" class="au-admin-cb" ${(isAdminRole || isSA) ? 'checked' : ''} ${isSA ? 'disabled title="Included via Super Admin"' : ''}
              style="width:14px;height:14px;accent-color:#8B1A2F;margin:0;cursor:${isSA ? 'not-allowed' : 'pointer'};flex-shrink:0;${isSA ? 'opacity:0.45;' : ''}" />
            <label for="au-admin-${u.userId}" style="font-size:13px;color:#1C2B3A;cursor:${isSA ? 'not-allowed' : 'pointer'};margin:0;">Admin</label>
          </div>
          ${isSA ? '<div style="font-size:11px;color:#9CA3AF;font-style:italic;margin-left:22px;">Admin included via Super Admin</div>' : ''}
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

      <div style="display:flex;align-items:center;gap:12px;margin-top:.5rem;flex-wrap:wrap;">
        <button class="au-save-btn" data-user-id="${u.userId}" style="
          padding:.4rem 1.1rem;background:#1C2B3A;color:#fff;border:none;
          border-radius:5px;font-size:13px;font-family:'Inter',sans-serif;
          cursor:pointer;font-weight:500;
        ">Save</button>
        ${u.email ? `<button class="au-pw-reset-btn" data-user-id="${u.userId}" data-email="${u.email}" style="
          padding:.4rem 1.1rem;background:#C9A84C;color:#fff;border:none;
          border-radius:5px;font-size:13px;font-family:'Inter',sans-serif;
          cursor:pointer;font-weight:500;
        ">Send Password Reset Email</button>` : ''}
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

  // Admin role (skip if user is super_admin — it's derived)
  if (!wantsSA) {
    const wantsAdmin = detail.querySelector('.au-admin-cb:not(:disabled)')?.checked;
    if (wantsAdmin !== undefined) {
      if (wantsAdmin && !u.roles.includes('admin')) {
        await sb.from('user_roles').upsert({ user_id: userId, role: 'admin' }, { onConflict: 'user_id,role' });
      } else if (!wantsAdmin && u.roles.includes('admin')) {
        await sb.from('user_roles').delete().eq('user_id', userId).eq('role', 'admin');
      }
    }
  }

  // Sacramental roles
  const checkedSacraments = Array.from(detail.querySelectorAll('.au-sac-cb:checked')).map(cb => cb.dataset.sacrament);
  await sb.from('sacramental_roles').delete().eq('user_id', userId);
  if (checkedSacraments.length) {
    await sb.from('sacramental_roles').insert(checkedSacraments.map(s => ({ user_id: userId, sacrament: s })));
  }

  // Panel grants — exclude locked (derived) checkboxes so we don't write implied access to panel_grants
  const checkedGrants = Array.from(detail.querySelectorAll('.au-grant-cb:checked:not(:disabled)')).map(cb => cb.dataset.panel);
  await sb.from('panel_grants').delete().eq('user_id', userId);
  if (checkedGrants.length) {
    await sb.from('panel_grants').insert(checkedGrants.map(p => ({ user_id: userId, panel: p })));
  }

  // Team memberships — only if user has a linked personnel_id
  const personnelId = u?.profile?.personnel_id;
  if (personnelId) {
    const checkedTeams = Array.from(detail.querySelectorAll('.au-team-cb:checked')).map(cb => cb.dataset.teamId);
    const uncheckedTeams = Array.from(detail.querySelectorAll('.au-team-cb:not(:checked):not(:disabled)')).map(cb => cb.dataset.teamId);
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

// ── Calendars tab ──────────────────────────────────────────────────────────

async function _renderCalendarsTab() {
  const el = document.getElementById('admin-tab-content');
  if (!el) return;
  el.innerHTML = '<div style="font-size:13px;color:#9CA3AF;">Loading…</div>';

  const { data: cals, error } = await sb
    .from('calendars')
    .select('*')
    .eq('scope', 'parish')
    .order('created_at');
  if (error) { el.innerHTML = `<div style="color:#E74C3C;font-size:13px;">Error: ${error.message}</div>`; return; }

  const rows = (cals || []).map(c => `
    <div style="display:flex;align-items:center;gap:10px;padding:.65rem 0;border-bottom:.5px solid #F0EDE8;">
      <div style="width:12px;height:12px;border-radius:50%;background:${c.color};flex-shrink:0;"></div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13.5px;font-weight:500;color:#1C2B3A;">${c.name}</div>
        <div style="font-size:11.5px;color:#9CA3AF;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${c.url}</div>
      </div>
      <span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:20px;background:${c.type === 'google' ? '#E8F5E9' : '#EEF2FF'};color:${c.type === 'google' ? '#2E7D32' : '#3730A3'};">${c.type === 'google' ? 'Google' : 'ICS'}</span>
      <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:#6B7280;margin:0;cursor:pointer;letter-spacing:normal;">
        <input type="checkbox" class="cal-active-cb" data-cal-id="${c.id}" ${c.active ? 'checked' : ''}
          style="width:auto;accent-color:#8B1A2F;cursor:pointer;" />
        Active
      </label>
      <button class="cal-delete-btn" data-cal-id="${c.id}" data-cal-name="${c.name}" style="
        background:none;border:none;cursor:pointer;color:#D1D5DB;font-size:15px;padding:0;flex-shrink:0;
      " title="Delete" onmouseover="this.style.color='#8B1A2F'" onmouseout="this.style.color='#D1D5DB'">✕</button>
    </div>`).join('');

  el.innerHTML = `
    <div style="max-width:600px;">
      <div style="display:flex;justify-content:flex-end;margin-bottom:1rem;">
        <button id="cal-add-btn" style="
          padding:.4rem 1rem;background:#1C2B3A;color:#fff;border:none;border-radius:5px;
          font-size:13px;font-family:'Inter',sans-serif;cursor:pointer;font-weight:500;
        ">+ Add Calendar</button>
      </div>
      <div id="cal-list">
        ${rows || '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No parish calendars yet.</div>'}
      </div>
    </div>
  `;

  el.querySelectorAll('.cal-active-cb').forEach(cb => {
    cb.addEventListener('change', async () => {
      await sb.from('calendars').update({ active: cb.checked }).eq('id', cb.dataset.calId);
    });
  });

  el.querySelectorAll('.cal-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Delete "${btn.dataset.calName}"?`)) return;
      const { error } = await sb.from('calendars').delete().eq('id', btn.dataset.calId);
      if (error) { alert('Delete failed: ' + error.message); return; }
      await _renderCalendarsTab();
    });
  });

  document.getElementById('cal-add-btn').addEventListener('click', () => _openCalendarModal());
}

function _openCalendarModal(data) {
  const colorPickers = CAL_PRESETS.map((c, i) => `
    <label style="display:inline-flex;align-items:center;margin:0;cursor:pointer;" title="${c}">
      <input type="radio" name="cal-color" value="${c}" ${(data?.color || CAL_PRESETS[0]) === c ? 'checked' : ''}
        style="display:none;" />
      <span style="
        display:block;width:20px;height:20px;border-radius:50%;background:${c};
        outline:${(data?.color || CAL_PRESETS[0]) === c ? '2.5px solid #1C2B3A' : '2.5px solid transparent'};
        outline-offset:2px;cursor:pointer;transition:outline .1s;
      " onclick="this.previousElementSibling.click();
        document.querySelectorAll('[name=cal-color]').forEach(r=>{
          r.nextElementSibling.style.outline=r.checked?'2.5px solid #1C2B3A':'2.5px solid transparent';
        })"></span>
    </label>`).join('');

  document.getElementById('modal-content').innerHTML = `
    <div class="modal-title">${data ? 'Edit Calendar' : 'Add Calendar'}</div>
    <label>Name</label>
    <input id="cal-name" value="${data?.name || ''}" placeholder="e.g. Parish Events" />
    <label>Type</label>
    <select id="cal-type" onchange="
      const lbl = document.getElementById('cal-url-label');
      lbl.textContent = this.value === 'google' ? 'Calendar ID' : 'Feed URL';
    ">
      <option value="ics"    ${(!data || data.type === 'ics')    ? 'selected' : ''}>ICS Feed</option>
      <option value="google" ${data?.type === 'google' ? 'selected' : ''}>Google Calendar</option>
    </select>
    <label id="cal-url-label">${(!data || data.type === 'ics') ? 'Feed URL' : 'Calendar ID'}</label>
    <input id="cal-url" value="${data?.url || ''}" placeholder="${(!data || data.type === 'ics') ? 'https://…' : 'example@group.calendar.google.com'}" />
    <label>Color</label>
    <div style="display:flex;gap:10px;align-items:center;margin-top:4px;">${colorPickers}</div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" onclick="saveCalendar(${data ? `'${data.id}'` : null})">Save</button>
    </div>
  `;
  document.getElementById('modal-overlay').classList.add('open');
}

async function _saveCalendar(id) {
  const name  = document.getElementById('cal-name').value.trim();
  const type  = document.getElementById('cal-type').value;
  const url   = document.getElementById('cal-url').value.trim();
  const color = document.querySelector('[name="cal-color"]:checked')?.value || CAL_PRESETS[0];

  if (!name) { alert('Name is required.'); return; }
  if (!url)  { alert('URL / Calendar ID is required.'); return; }

  const payload = { name, type, url, color, scope: 'parish', user_id: null };
  const { error } = id
    ? await sb.from('calendars').update(payload).eq('id', id)
    : await sb.from('calendars').insert(payload);
  if (error) { alert('Save failed: ' + error.message); return; }
  closeModal();
  await _renderCalendarsTab();
}

// ── Parish Settings tab ────────────────────────────────────────────────────

const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'];

// Parse "Street, City, ST ZIP" back into components for display
function _parseAddress(addr) {
  if (!addr) return { street: '', city: '', state: '', zip: '' };
  const m = addr.match(/^(.*?),\s*(.*?),\s*([A-Z]{2})\s*(\d{5})?$/);
  if (m) return { street: m[1].trim(), city: m[2].trim(), state: m[3].trim(), zip: (m[4] || '').trim() };
  return { street: addr, city: '', state: '', zip: '' };
}

async function _detectTimezone(city, state) {
  const query = `${city}, ${state}, USA`;
  const geo = await fetch(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`,
    { headers: { 'User-Agent': 'ParishDesk/1.0' } }
  ).then(r => r.json());
  if (!geo?.[0]) return null;
  const { lat, lon } = geo[0];
  const tzData = await fetch(
    `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`
  ).then(r => r.json());
  return tzData?.timezone?.ianaTimeId || tzData?.timezone?.name || null;
}

async function _renderSettingsTab() {
  const el = document.getElementById('admin-tab-content');
  if (!el) return;
  el.innerHTML = '<div style="font-size:13px;color:#9CA3AF;">Loading…</div>';

  const { data, error } = await sb.from('parish_settings').select('*').limit(1).maybeSingle();
  if (error) { el.innerHTML = `<div style="color:#E74C3C;font-size:13px;">Error: ${error.message}</div>`; return; }

  const addr = _parseAddress(data?.address || '');
  const inputStyle = `width:100%;box-sizing:border-box;padding:.4rem .65rem;border:.5px solid #D1C9BE;
    border-radius:5px;font-size:13px;font-family:'Inter',sans-serif;outline:none;margin-bottom:.75rem;`;
  const labelStyle = `display:block;font-size:11.5px;color:#6B7280;margin-bottom:3px;`;
  const stateOptions = US_STATES.map(s => `<option ${s === addr.state ? 'selected' : ''}>${s}</option>`).join('');
  const tzDisplay = data?.timezone
    ? `Timezone: <strong>${data.timezone}</strong> <span style="color:#9CA3AF;">(auto-detected)</span>`
    : `<span style="color:#9CA3AF;">Timezone will be auto-detected from city &amp; state on save.</span>`;

  el.innerHTML = `
    <div style="background:#fff;border:.5px solid #E2DDD6;border-radius:8px;padding:1.2rem 1.4rem;max-width:480px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;margin-bottom:1rem;">Parish Settings</div>

      <label style="${labelStyle}">Parish Name</label>
      <input id="ps-name" value="${(data?.parish_name || '').replace(/"/g, '&quot;')}" style="${inputStyle}" />
      <div style="font-size:11.5px;color:#9CA3AF;margin-top:-.5rem;margin-bottom:1rem;line-height:1.5;">
        Appears on the login screen, sidebar, and Directory.
      </div>

      <div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.65rem;">Parish Address</div>

      <label style="${labelStyle}">Street Address</label>
      <input id="ps-street" value="${addr.street.replace(/"/g, '&quot;')}" placeholder="123 Main Street" style="${inputStyle}" />

      <div style="display:grid;grid-template-columns:1fr auto auto;gap:.6rem;margin-bottom:.75rem;">
        <div>
          <label style="${labelStyle}">City</label>
          <input id="ps-city" value="${addr.city.replace(/"/g, '&quot;')}" placeholder="Natchez"
            style="width:100%;box-sizing:border-box;padding:.4rem .65rem;border:.5px solid #D1C9BE;border-radius:5px;font-size:13px;font-family:'Inter',sans-serif;outline:none;" />
        </div>
        <div>
          <label style="${labelStyle}">State</label>
          <select id="ps-state"
            style="padding:.4rem .65rem;border:.5px solid #D1C9BE;border-radius:5px;font-size:13px;font-family:'Inter',sans-serif;outline:none;cursor:pointer;background:#fff;">
            <option value=""></option>
            ${stateOptions}
          </select>
        </div>
        <div>
          <label style="${labelStyle}">Zip</label>
          <input id="ps-zip" value="${addr.zip}" placeholder="00000" maxlength="5"
            style="width:70px;box-sizing:border-box;padding:.4rem .65rem;border:.5px solid #D1C9BE;border-radius:5px;font-size:13px;font-family:'Inter',sans-serif;outline:none;" />
        </div>
      </div>

      <div id="ps-tz-display" style="font-size:12px;color:#4B5563;margin-bottom:1rem;line-height:1.6;">
        ${tzDisplay}
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
    const statusEl  = document.getElementById('ps-status');
    statusEl.style.color = '#6B7280';
    statusEl.textContent = 'Saving…';

    const name   = document.getElementById('ps-name').value.trim();
    const street = document.getElementById('ps-street').value.trim();
    const city   = document.getElementById('ps-city').value.trim();
    const state  = document.getElementById('ps-state').value.trim();
    const zip    = document.getElementById('ps-zip').value.trim();
    if (!name) { statusEl.textContent = 'Parish name is required.'; return; }

    const addressParts = [street, city, state ? (zip ? `${state} ${zip}` : state) : zip].filter(Boolean);
    const address = addressParts.length ? `${street}, ${city}, ${state} ${zip}`.replace(/,?\s*$/, '').trim() : '';

    // Auto-detect timezone from city + state
    let timezone = data?.timezone || null;
    if (city && state) {
      try {
        statusEl.textContent = 'Detecting timezone…';
        const detected = await _detectTimezone(city, state);
        timezone = detected;
        const tzEl = document.getElementById('ps-tz-display');
        if (tzEl) {
          tzEl.innerHTML = detected
            ? `Timezone: <strong>${detected}</strong> <span style="color:#9CA3AF;">(auto-detected)</span>`
            : `<span style="color:#9CA3AF;">Timezone: Could not auto-detect.</span>`;
        }
      } catch { timezone = null; }
    }

    statusEl.textContent = 'Saving…';
    const payload = { parish_name: name, primary_institution: name, address, timezone };
    const { error: saveErr } = data
      ? await sb.from('parish_settings').update(payload).eq('id', data.id)
      : await sb.from('parish_settings').insert(payload);
    if (saveErr) { statusEl.textContent = 'Error: ' + saveErr.message; return; }
    store.parishSettings = { ...store.parishSettings, ...payload };
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
  const saveBtn = e.target.closest('.au-save-btn');
  if (saveBtn) { _saveUser(saveBtn.dataset.userId); return; }

  const resetBtn = e.target.closest('.au-pw-reset-btn');
  if (resetBtn) _resetPassword(resetBtn.dataset.email, resetBtn.closest('.admin-user-detail'));
});

async function _resetPassword(email, detailEl) {
  const statusEl = detailEl?.querySelector('.au-status');
  if (!email) { if (statusEl) statusEl.textContent = 'No email address for this user.'; return; }
  if (statusEl) statusEl.textContent = 'Sending…';
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
  if (error) { if (statusEl) statusEl.textContent = 'Error: ' + error.message; return; }
  if (statusEl) { statusEl.textContent = `Reset email sent to ${email}`; statusEl.style.color = '#2E7D32'; }
  setTimeout(() => { if (statusEl) { statusEl.textContent = ''; statusEl.style.color = '#6B7280'; } }, 5000);
}

window.saveCalendar = _saveCalendar;
