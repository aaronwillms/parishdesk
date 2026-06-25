import { sb, deleteWithRetry } from '../supabase.js';
import { store } from '../store.js';
import { PREP_PROGRAMS } from '../ui/programCoordinators.js';   // prep-vs-cura key set (single source)
import { createAvatar } from '../ui/avatar.js';
import { applyParishName } from '../ui/navigation.js';
import { createContactPicker } from '../ui/contactPicker.js';
import { fetchAllGrants, revokeGrant, setGrantNote, labelForGrant, userName, ensureIdentities, recordTypeLabel, PRIORITY_TYPES } from '../ui/grants.js';
import { personTitle } from '../utils.js';
import { computePermissionBasis } from '../roles.js';
import { deriveParishStaffPersonnelIds } from '../ui/parishStaff.js';

const SACRAMENTS = ['baptism', 'first_communion', 'confirmation', 'ocia', 'marriage', 'annulments'];
const SACRAMENT_LABELS = { baptism: 'Baptism', first_communion: 'First Communion', confirmation: 'Confirmation', ocia: 'OCIA', marriage: 'Marriage', annulments: 'Annulments' };

// Only non-sacramental, non-auto panels that can be manually granted
// (projects and tasks are always available — no grant needed)
const PANEL_LABELS = {
  school: 'Cathedral School',
  // Discernment "panel access" (axis 1): super-admin grants/revokes it here.
  // Persisted in panel_grants.panel='discernment'; read by canAccessDiscernment().
  // Holders are collaborators (read + write all parish discernment files).
  discernment: 'Discernment',
  // Sick & Homebound panel access. Manually grantable here, AND locked ON (with a
  // "🔒 Minister to the Sick" chip) for account-linked Ministers-to-the-Sick roster
  // members (program_coordinators program='homebound'), like sacramental coordinators.
  homebound: 'Sick & Homebound',
};

let _activeTab = 'users';
let _users = [];
let _expandedUserId = null;
let _currentAuthUserId = null;

const CAL_PRESETS = ['#1C2B3A', '#8B1A2F', '#C9A84C', '#1565C0', '#2E7D32', '#6A1B9A', '#00695C', '#E65100'];

// ── Public entry point ─────────────────────────────────────────────────────

export async function loadAdmin() {
  const { data: { user } } = await sb.auth.getUser();
  _currentAuthUserId = user?.id || null;
  // Land on Calendars right after designating the parish Google writer (so the
  // admin can pick which calendar is the global one).
  _activeTab = new URLSearchParams(location.search).has('parish_writer_connected') ? 'calendars' : 'users';
  _render();
  if (_activeTab === 'users') await _loadUsers();
  else if (_activeTab === 'calendars') await _renderCalendarsTab();
}

// ── Data ───────────────────────────────────────────────────────────────────

async function _loadUsers() {
  const [profilesRes, rolesRes, sacramentRes, grantsRes, teamMembersRes, authRes, coordRes] = await Promise.all([
    sb.from('user_profiles').select('user_id, personnel_id, avatar_url, personnel(id,name)'),
    sb.from('user_roles').select('user_id, role'),
    sb.from('sacramental_roles').select('user_id, sacrament'),
    sb.from('panel_grants').select('user_id, panel'),
    sb.from('team_members').select('team_id, personnel_id'),
    fetch('/admin-users').then(r => r.ok ? r.json() : { users: [] }).catch(() => ({ users: [] })),
    sb.from('program_coordinators').select('program, coordinator_ids'),
  ]);

  const profiles   = profilesRes.data  || [];
  // personnel.title was retired in the HR Stage 1 collapse — derive the title
  // shown under each user's name from their current HR positions.
  profiles.forEach(p => { if (p.personnel) p.personnel.title = personTitle(p.personnel.id); });
  const roles      = rolesRes.data     || [];
  const sacraments = sacramentRes.data || [];
  const grants     = grantsRes.data    || [];
  const authUsers  = authRes.users     || [];

  // Build personnelId → coordinator programs[] map
  const coordByPersonnel = {};
  (coordRes.data || []).forEach(row => {
    (row.coordinator_ids || []).forEach(pid => {
      if (!coordByPersonnel[pid]) coordByPersonnel[pid] = [];
      coordByPersonnel[pid].push(row.program);
    });
  });

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

  // Attach coordinator-granted sacraments per user
  Object.values(map).forEach(u => {
    const pid = u.profile?.personnel_id;
    u.coordinatorSacraments = pid ? (coordByPersonnel[pid] || []) : [];
  });

  // "Parish Staff" membership is DERIVED from HR (not team_members), so the badge
  // must come from the same derivation to stay in sync.
  const parishStaffIds = new Set(await deriveParishStaffPersonnelIds());
  Object.values(map).forEach(u => {
    u.isParishStaff = !!(u.profile?.personnel_id && parishStaffIds.has(u.profile.personnel_id));
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
    { key: 'diocesan',  label: 'Diocesan Calendar' },
    { key: 'settings',  label: 'Parish Settings' },
    { key: 'audit',     label: 'Access Audit' },
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
      if (_activeTab === 'diocesan')  await _renderDiocesanTab();
      if (_activeTab === 'settings')  await _renderSettingsTab();
      if (_activeTab === 'audit')     await _renderAuditTab();
      if (_activeTab === 'invite')    _renderInviteTab();
    });
  });

  if (_activeTab === 'calendars')     _renderCalendarsTab();
  else if (_activeTab === 'diocesan') _renderDiocesanTab();
  else if (_activeTab === 'settings') _renderSettingsTab();
  else if (_activeTab === 'audit')    _renderAuditTab();
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
    _mountLinkPicker(slot, userId);
  });

  // Change / Remove link buttons for already-linked users
  el.querySelectorAll('.au-link-change').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); _changeLinkUser(btn.dataset.userId, btn.closest('.admin-user-detail')); });
  });
  el.querySelectorAll('.au-link-remove').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); _unlinkUser(btn.dataset.userId); });
  });

  document.querySelectorAll('.admin-user-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.admin-user-detail')) return;
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

  const isParishStaff = u.isParishStaff;

  const roleLabel = u.roles.includes('super_admin') ? 'Super Admin'
                  : u.roles.includes('admin')       ? 'Admin'
                  : 'Basic';
  const roleBg    = u.roles.includes('super_admin') ? '#1C2B3A'
                  : u.roles.includes('admin')       ? '#F3F4F6'
                  : '#F3F4F6';
  const roleColor = u.roles.includes('super_admin') ? '#F8F7F4' : '#4B5563';
  const roleBadges = [
    `<span style="font-size:10.5px;font-weight:600;background:${roleBg};color:${roleColor};border-radius:20px;padding:2px 8px;">${roleLabel}</span>`,
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
  const { error } = await sb.from('user_profiles').upsert({ user_id: userId, personnel_id: null }, { onConflict: 'user_id' });
  if (error) { alert('Remove failed: ' + error.message); return; }
  await _loadUsers();
}

function _changeLinkUser(userId, detailEl) {
  if (!detailEl) return;
  const currentBlock = detailEl.querySelector('[data-link-block]');
  if (!currentBlock) return;
  const slotId = 'au-change-picker-' + userId;
  currentBlock.innerHTML = `<div id="${slotId}"></div>`;
  const slot = document.getElementById(slotId);
  if (!slot) return;
  _mountLinkPicker(slot, userId);
}

function _mountLinkPicker(container, userId) {
  // Two-step: pick → confirm button. Avoids race between onSelect and upsert.
  let _selectedPerson = null;

  container.innerHTML = `
    <div id="aup-cp-${userId}"></div>
    <div style="display:flex;gap:8px;margin-top:8px;">
      <button id="aup-confirm-${userId}" disabled style="
        padding:.3rem .85rem;background:#1C2B3A;color:#fff;border:none;
        border-radius:5px;font-size:12.5px;font-family:'Inter',sans-serif;
        cursor:not-allowed;opacity:0.45;font-weight:500;
      ">Link</button>
      <div id="aup-status-${userId}" style="font-size:12px;color:#6B7280;line-height:2;"></div>
    </div>
  `;

  const confirmBtn = document.getElementById(`aup-confirm-${userId}`);
  const statusEl   = document.getElementById(`aup-status-${userId}`);

  createContactPicker({
    container: document.getElementById(`aup-cp-${userId}`),
    placeholder: 'Search directory…',
    onSelect: (person) => {
      _selectedPerson = person?.id ? person : null;
      confirmBtn.disabled = !_selectedPerson;
      confirmBtn.style.opacity = _selectedPerson ? '1' : '0.45';
      confirmBtn.style.cursor  = _selectedPerson ? 'pointer' : 'not-allowed';
    },
  });

  confirmBtn.addEventListener('click', async () => {
    if (!_selectedPerson?.id) return;
    confirmBtn.disabled = true;
    statusEl.textContent = 'Saving…';
    console.log('[admin link] upserting personnel_id:', _selectedPerson.id, 'for user:', userId);
    const { error } = await sb.from('user_profiles').upsert(
      // Step 3b: stamp the admin's resolved parish so a newly-linked user gets a real
      // parish_id (never NULL → never hits the hardened current_parish_id() fail-closed
      // path). Single-parish: idempotent — every user is already Basilica. ⚠️ 3c: once a
      // second parish exists this must become a parish PICKER; an unconditional stamp on
      // the upsert-UPDATE path would otherwise move an existing cross-parish user to the
      // admin's parish on re-link. (undefined → key omitted → DB DEFAULT current_parish_id().)
      { user_id: userId, personnel_id: _selectedPerson.id, parish_id: store.parishSettings?.id || undefined },
      { onConflict: 'user_id' }
    );
    if (error) {
      console.error('[admin link] upsert failed:', error);
      statusEl.textContent = 'Failed: ' + error.message;
      confirmBtn.disabled = false;
      return;
    }
    statusEl.textContent = 'Linked.';
    await _loadUsers();
  });
}

function _userDetail(u) {
  const isSelf = u.userId === _currentAuthUserId;
  const isSA = u.roles.includes('super_admin');
  const isAdminRole = u.roles.includes('admin');
  const teams = store.teams || [];

  // For super admins, skip individual permission columns — show collapsed full-access notice instead
  // For super admins, skip individual permission columns — show collapsed full-access notice instead
  const permissionsBlock = isSA ? `
    <div style="background:#F0F4F8;border:.5px solid #C7D7E8;border-radius:7px;padding:.75rem 1rem;margin-bottom:1rem;display:flex;align-items:center;gap:10px;">
      <span style="font-size:16px;">🔓</span>
      <div>
        <div style="font-size:13px;font-weight:600;color:#1C2B3A;">Super Admin — Full Access</div>
        <div style="font-size:11.5px;color:#6B7280;margin-top:1px;">All sacramental roles, panel grants, and team memberships are granted automatically. Individual permissions cannot be edited.</div>
      </div>
    </div>` : (() => {
    // Three visually distinct toggle states (basis computed in roles.js):
    //   editable           → normal interactive checkbox, no chip
    //   locked by admin    → ON + disabled, navy "🔒 Admin" chip
    //   locked by coordinator → ON + disabled, cardinal "🔒 [Sacrament] coordinator" chip
    const adminChip = `<span title="Granted by Admin role" style="display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:600;padding:1px 6px;border-radius:3px;background:#EEF1F5;color:var(--navy);border:.5px solid #C7D2DE;white-space:nowrap;">🔒 Admin</span>`;
    const coordChip = (label) => `<span title="Granted by ${label} coordinator role" style="display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:600;padding:1px 6px;border-radius:3px;background:#FDEAED;color:var(--cardinal);border:.5px solid #F2C9D1;white-space:nowrap;">🔒 ${label} coordinator</span>`;
    //   locked by roster → ON + disabled, cardinal "🔒 [Roster]" chip (e.g. Minister to the Sick)
    const rosterChip = (label) => `<span title="Granted by the ${label} roster" style="display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:600;padding:1px 6px;border-radius:3px;background:#FDEAED;color:var(--cardinal);border:.5px solid #F2C9D1;white-space:nowrap;">🔒 ${label}</span>`;
    const permRow = (inputClass, dataAttr, label, { granted, locked, lockedBy }, roleLabel) => {
      const chip = !locked ? '' : (lockedBy === 'admin' ? adminChip : lockedBy === 'roster' ? rosterChip(roleLabel) : coordChip(roleLabel));
      return `
      <div style="display:flex;align-items:center;gap:8px;padding:4px 0;">
        <input type="checkbox" class="${inputClass}" ${dataAttr} ${granted ? 'checked' : ''} ${locked ? 'disabled' : ''}
          style="width:14px;height:14px;accent-color:#8B1A2F;margin:0;cursor:${locked ? 'not-allowed' : 'pointer'};flex-shrink:0;${locked ? 'opacity:0.45;' : ''}" />
        <span style="font-size:13px;color:#1C2B3A;">${label}</span>
        ${chip}
      </div>`;
    };

    // Sacraments: manual grants stay EDITABLE; only the coordinator "role" basis
    // locks. Admin does NOT lock sacraments.
    const coordinatorSacraments = u.coordinatorSacraments || [];
    const sacramentChecks = SACRAMENTS.map(s => {
      const state = computePermissionBasis({
        kind: 'sacrament',
        hasManual: u.sacraments.includes(s),
        hasRole:   coordinatorSacraments.includes(s),
        roleLabel: SACRAMENT_LABELS[s],
      });
      return permRow('au-sac-cb', `data-sacrament="${s}"`, SACRAMENT_LABELS[s], state, SACRAMENT_LABELS[s]);
    }).join('');

    // Panel grants (institution permissions): manual stays editable; Admin locks all.
    // Homebound additionally locks for account-linked Ministers-to-the-Sick roster
    // members (program_coordinators program='homebound'; carried in coordinatorSacraments).
    const grantChecks = Object.entries(PANEL_LABELS).map(([p, label]) => {
      const onHbRoster = p === 'homebound' && (u.coordinatorSacraments || []).includes('homebound');
      const state = computePermissionBasis({
        kind: 'panel', isAdmin: isAdminRole, hasManual: u.grants.includes(p),
        hasRoster: onHbRoster, rosterLabel: 'Minister to the Sick',
      });
      return permRow('au-grant-cb', `data-panel="${p}"`, label, state, 'Minister to the Sick');
    }).join('');

    // Team memberships: manual membership stays editable; Admin locks all.
    const teamChecks = teams.map(t => {
      const state = computePermissionBasis({ kind: 'team', isAdmin: isAdminRole, hasManual: (u.teamIds || []).includes(t.id) });
      return permRow('au-team-cb', `data-team-id="${t.id}" data-personnel-id="${u.profile?.personnel_id || ''}"`, t.name, state);
    }).join('');

    return `
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1.25rem;margin-bottom:1rem;">
        <div>
          <div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.5rem;">Sacramental Roles</div>
          ${sacramentChecks}
        </div>
        <div>
          <div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.5rem;">Panel Grants</div>
          ${grantChecks}
        </div>
        ${teams.length ? `
        <div>
          <div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.5rem;">Team Memberships</div>
          ${teamChecks}
        </div>` : ''}
      </div>`;
  })();

  return `
    <div class="admin-user-detail" data-user-id="${u.userId}" style="border-top:.5px solid #F0EDE8;padding:1rem 1.1rem;background:#FAFAF8;">
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

      <div style="margin-bottom:1rem;">
        <div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.5rem;">System Role</div>
        <div style="display:flex;align-items:center;gap:8px;padding:4px 0;">
          <input type="checkbox" id="au-sa-${u.userId}" class="au-sa-cb" ${isSA ? 'checked' : ''} ${isSelf ? 'disabled title="Cannot remove own super admin role"' : ''}
            style="width:14px;height:14px;accent-color:#1C2B3A;margin:0;cursor:${isSelf ? 'not-allowed' : 'pointer'};flex-shrink:0;" />
          <label for="au-sa-${u.userId}" style="font-size:13px;color:#1C2B3A;cursor:${isSelf ? 'not-allowed' : 'pointer'};margin:0;">Super Admin</label>
        </div>
        ${!isSA ? `
        <div style="display:flex;align-items:center;gap:8px;padding:4px 0;">
          <input type="checkbox" id="au-admin-${u.userId}" class="au-admin-cb" ${isAdminRole ? 'checked' : ''}
            style="width:14px;height:14px;accent-color:#8B1A2F;margin:0;cursor:pointer;flex-shrink:0;" />
          <label for="au-admin-${u.userId}" style="font-size:13px;color:#1C2B3A;cursor:pointer;margin:0;">Admin</label>
        </div>` : ''}
      </div>

      ${permissionsBlock}

      <div style="display:flex;align-items:center;gap:12px;margin-top:.5rem;flex-wrap:wrap;">
        <button id="admin-user-save-btn-${u.userId}" class="au-save-btn" data-user-id="${u.userId}" style="
          padding:.4rem 1.1rem;background:#1C2B3A;color:#fff;border:none;
          border-radius:5px;font-size:13px;font-family:'Inter',sans-serif;
          cursor:pointer;font-weight:500;
        ">Save</button>
        ${u.email ? `<button id="admin-user-pw-btn-${u.userId}" class="au-pw-reset-btn" data-user-id="${u.userId}" data-email="${u.email}" style="
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
      await deleteWithRetry(() => sb.from('user_roles').delete().eq('user_id', userId).eq('role', 'super_admin'));
    }
  }

  // Admin role (skip if user is super_admin — it's derived)
  if (!wantsSA) {
    const wantsAdmin = detail.querySelector('.au-admin-cb:not(:disabled)')?.checked;
    if (wantsAdmin !== undefined) {
      if (wantsAdmin && !u.roles.includes('admin')) {
        await sb.from('user_roles').upsert({ user_id: userId, role: 'admin' }, { onConflict: 'user_id,role' });
      } else if (!wantsAdmin && u.roles.includes('admin')) {
        await deleteWithRetry(() => sb.from('user_roles').delete().eq('user_id', userId).eq('role', 'admin'));
      }
    }
  }

  // ── Manual-only persistence (non-destructive) ─────────────────────────────
  // Only the MANUAL basis is ever written. Derived (admin/role) grants are never
  // persisted, so we must never strip a manual row that a derived lock is masking.
  // A disabled checkbox = a derived lock at render time → preserve its manual row
  // as-is; an enabled checkbox expresses the user's manual intent directly.

  // Sacramental roles (manual). Editable-checked = keep; coordinator-locked rows
  // that already have a manual grant are preserved.
  const sacCbs = Array.from(detail.querySelectorAll('.au-sac-cb'));
  const desiredSac = new Set(sacCbs.filter(cb => !cb.disabled && cb.checked).map(cb => cb.dataset.sacrament));
  u.sacraments.forEach(s => { const cb = sacCbs.find(c => c.dataset.sacrament === s); if (cb && cb.disabled) desiredSac.add(s); });
  await deleteWithRetry(() => sb.from('sacramental_roles').delete().eq('user_id', userId));
  if (desiredSac.size) {
    await sb.from('sacramental_roles').insert([...desiredSac].map(s => ({
      user_id: userId, sacrament: s,
      parish_id: PREP_PROGRAMS.has(s) ? (store.parishSettings?.id || null) : null,   // prep → parish, cura → NULL
    })));
  }

  // Panel grants (manual). Admin-locked rows with an existing manual grant are preserved.
  const grantCbs = Array.from(detail.querySelectorAll('.au-grant-cb'));
  const desiredGrants = new Set(grantCbs.filter(cb => !cb.disabled && cb.checked).map(cb => cb.dataset.panel));
  u.grants.forEach(p => { const cb = grantCbs.find(c => c.dataset.panel === p); if (cb && cb.disabled) desiredGrants.add(p); });
  await deleteWithRetry(() => sb.from('panel_grants').delete().eq('user_id', userId));
  if (desiredGrants.size) {
    await sb.from('panel_grants').insert([...desiredGrants].map(p => ({
      user_id: userId, panel: p,
      parish_id: PREP_PROGRAMS.has(p) ? (store.parishSettings?.id || null) : null,   // prep panel → parish, cura/other → NULL
    })));
  }

  // Team memberships (manual) — only if user has a linked personnel_id. Admin-locked
  // (disabled) rows are left untouched so admin grant/removal never adds or drops a
  // physical membership; editable rows reconcile to their checkbox.
  const personnelId = u?.profile?.personnel_id;
  if (personnelId) {
    for (const cb of detail.querySelectorAll('.au-team-cb')) {
      if (cb.disabled) continue;
      const teamId = cb.dataset.teamId;
      if (cb.checked) {
        await sb.from('team_members').upsert({ team_id: teamId, personnel_id: personnelId }, { onConflict: 'team_id,personnel_id' });
      } else {
        await deleteWithRetry(() => sb.from('team_members').delete().eq('team_id', teamId).eq('personnel_id', personnelId));
      }
    }
  }

  statusEl.textContent = 'Saved.';
  window.flashSaved();
  setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
  await _loadUsers();
}

// ── Calendars tab ──────────────────────────────────────────────────────────

function _calColorPickers(selectedColor, name = 'cal-color') {
  const sel = selectedColor || CAL_PRESETS[0];
  return CAL_PRESETS.map(c => `
    <label style="display:inline-flex;align-items:center;margin:0;cursor:pointer;" title="${c}">
      <input type="radio" name="${name}" value="${c}" ${sel === c ? 'checked' : ''} style="display:none;" />
      <span style="
        display:block;width:20px;height:20px;border-radius:50%;background:${c};
        outline:${sel === c ? '2.5px solid #C9A84C' : '2.5px solid transparent'};
        outline-offset:2px;cursor:pointer;transition:outline .1s;
      " onclick="this.previousElementSibling.click();
        document.querySelectorAll('[name=${name}]').forEach(r=>{
          r.nextElementSibling.style.outline=r.checked?'2.5px solid #C9A84C':'2.5px solid transparent';
        })"></span>
    </label>`).join('');
}

async function _renderCalendarsTab() {
  const el = document.getElementById('admin-tab-content');
  if (!el) return;
  el.innerHTML = '<div style="font-size:13px;color:#9CA3AF;">Loading…</div>';

  const [calsRes, settingsRes] = await Promise.all([
    sb.from('calendars').select('*').eq('scope', 'parish').order('created_at'),
    sb.from('parish_settings').select('*').limit(1).maybeSingle(),
  ]);
  if (calsRes.error) { el.innerHTML = `<div style="color:#E74C3C;font-size:13px;">Error: ${calsRes.error.message}</div>`; return; }

  const cals = calsRes.data || [];
  const ps   = settingsRes.data || {};

  // The designated GLOBAL parish calendar writer is the parish-scope Google row
  // (it carries the connected account's token). Shown in its own section, not the
  // generic read-feed list below.
  const writer = cals.find(c => c.type === 'google') || null;
  const feedCals = cals.filter(c => c.type !== 'google');

  const rows = feedCals.map(c => `
    <div style="display:flex;align-items:center;gap:10px;padding:.65rem 0;border-bottom:.5px solid #F0EDE8;">
      <div style="width:12px;height:12px;border-radius:50%;background:${c.color || '#1C2B3A'};flex-shrink:0;"></div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13.5px;font-weight:500;color:#1C2B3A;">${c.name}</div>
        <div style="font-size:11.5px;color:#9CA3AF;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${c.url || ''}</div>
      </div>
      <span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:20px;background:${c.type === 'google' ? '#E8F5E9' : '#EEF2FF'};color:${c.type === 'google' ? '#2E7D32' : '#3730A3'};">${c.type === 'google' ? 'Google' : 'ICS'}</span>
      <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:#6B7280;margin:0;cursor:pointer;letter-spacing:normal;">
        <input type="checkbox" class="cal-active-cb" data-cal-id="${c.id}" ${c.active ? 'checked' : ''}
          style="width:auto;accent-color:#8B1A2F;cursor:pointer;" />
        Active
      </label>
      <button class="cal-edit-btn" data-cal-id="${c.id}" style="
        background:none;border:none;cursor:pointer;color:#6B7280;font-size:13px;padding:0;flex-shrink:0;
      " title="Edit" onmouseover="this.style.color='#1C2B3A'" onmouseout="this.style.color='#6B7280'">
        <i class="fa-solid fa-pencil"></i>
      </button>
      <button class="cal-delete-btn" data-cal-id="${c.id}" data-cal-name="${c.name}" style="
        background:none;border:none;cursor:pointer;color:#D1D5DB;font-size:15px;padding:0;flex-shrink:0;
      " title="Delete" onmouseover="this.style.color='#8B1A2F'" onmouseout="this.style.color='#D1D5DB'">✕</button>
    </div>`).join('');

  el.innerHTML = `
    <div style="max-width:620px;">
      <div style="background:#fff;border:.5px solid #E2DDD6;border-radius:7px;padding:1rem 1.1rem;margin-bottom:1.5rem;">
        <div style="font-size:13px;font-weight:600;color:#1C2B3A;margin-bottom:.35rem;">Global Parish Calendar</div>
        <div style="font-size:12px;color:#6B7280;margin-bottom:.85rem;line-height:1.5;">One Google account designated as the parish's writable calendar. Its events appear on everyone's dashboard, and admins can post parish events to it. Typically the parish's own account (e.g. office@…), connected here — it is parish-level, not tied to any one person, so any admin can re-point it.</div>
        ${writer ? `
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:.7rem;flex-wrap:wrap;">
            <span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:20px;background:#E8F5E9;color:#2E7D32;">Connected</span>
            <span style="font-size:12px;color:#6B7280;">Which calendar on this account is the parish calendar?</span>
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            <select id="gpc-calendar" style="flex:1;min-width:0;padding:.4rem .6rem;border:.5px solid #D1C9BE;border-radius:5px;font-size:12.5px;background:#fff;cursor:pointer;"><option>Loading calendars…</option></select>
            <button id="gpc-save" class="btn-primary" style="padding:.4rem .9rem;font-size:12.5px;white-space:nowrap;">Save</button>
          </div>
          <div style="display:flex;align-items:center;gap:10px;margin-top:.7rem;"><span style="font-size:11px;color:#6B7280;">Event color</span><div style="display:flex;gap:8px;">${_calColorPickers(writer.color, 'gpc-color')}</div></div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:.7rem;gap:8px;">
            <span id="gpc-status" style="font-size:12px;color:#6B7280;"></span>
            <div style="white-space:nowrap;">
              <button id="gpc-reconnect" style="background:none;border:none;color:#8FA8BF;font-size:12px;cursor:pointer;">Re-connect account</button>
              <button id="gpc-disconnect" style="background:none;border:none;color:#A32D2D;font-size:12px;cursor:pointer;margin-left:8px;">Remove</button>
            </div>
          </div>
        ` : `
          <button id="gpc-connect" style="padding:.45rem 1rem;background:#1C2B3A;color:#fff;border:none;border-radius:5px;font-size:13px;cursor:pointer;font-weight:500;">Connect parish Google account</button>
        `}
      </div>
      <div style="background:#fff;border:.5px solid #E2DDD6;border-radius:7px;padding:1rem 1.1rem;margin-bottom:1.5rem;${writer ? '' : 'opacity:.55;'}">
        <div style="font-size:13px;font-weight:600;color:#1C2B3A;margin-bottom:.35rem;">Application Work Calendars</div>
        <div style="font-size:12px;color:#6B7280;margin-bottom:.85rem;line-height:1.5;">This is where all Sacramental, Project and Team events will be added.${writer ? '' : ' <strong>Set the Global Parish Calendar above first.</strong>'}</div>
        ${writer ? `
          <label style="font-size:11px;color:#6B7280;display:block;margin-bottom:3px;">Work calendar (may be the same as the global calendar)</label>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <select id="awc-calendar" style="flex:1;min-width:0;padding:.4rem .6rem;border:.5px solid #D1C9BE;border-radius:5px;font-size:12.5px;background:#fff;cursor:pointer;"><option>Loading calendars…</option></select>
            <button id="awc-save" class="btn-primary" style="padding:.4rem .9rem;font-size:12.5px;white-space:nowrap;">Save</button>
          </div>
          <div style="display:flex;align-items:center;gap:10px;margin-top:.7rem;"><span style="font-size:11px;color:#6B7280;">Event color</span><div style="display:flex;gap:8px;">${_calColorPickers(ps.work_calendar_color, 'awc-color')}</div></div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:.7rem;gap:8px;">
            <span id="awc-status" style="font-size:12px;color:#6B7280;"></span>
            <button id="awc-new" style="background:none;border:none;color:#8FA8BF;font-size:12px;cursor:pointer;white-space:nowrap;">+ Create a new calendar</button>
          </div>` : ''}
      </div>
      <div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.75rem;">Read-only feeds</div>
      <div style="display:flex;justify-content:flex-end;margin-bottom:1rem;">
        <button id="cal-add-btn" style="
          padding:.4rem 1rem;background:#1C2B3A;color:#fff;border:none;border-radius:5px;
          font-size:13px;font-family:'Inter',sans-serif;cursor:pointer;font-weight:500;
        ">+ Add Calendar</button>
      </div>

      <div id="cal-list" style="margin-bottom:1.5rem;">
        ${rows || '<div style="font-size:13px;color:#9CA3AF;font-style:italic;padding:.5rem 0;">No parish calendars yet.</div>'}
      </div>

    </div>
  `;

  // Active toggles
  el.querySelectorAll('.cal-active-cb').forEach(cb => {
    cb.addEventListener('change', async () => {
      await sb.from('calendars').update({ active: cb.checked }).eq('id', cb.dataset.calId);
    });
  });

  // Edit buttons — fetch cal data then open modal
  el.querySelectorAll('.cal-edit-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { data: cal } = await sb.from('calendars').select('*').eq('id', btn.dataset.calId).maybeSingle();
      if (cal) _openCalendarModal(cal);
    });
  });

  // Delete buttons
  el.querySelectorAll('.cal-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Delete "${btn.dataset.calName}"?`)) return;
      const { error } = await deleteWithRetry(() => sb.from('calendars').delete().eq('id', btn.dataset.calId));
      if (error) { alert('Delete failed: ' + error.message); return; }
      await _renderCalendarsTab();
    });
  });

  // Global Parish Calendar (designated writer) — connect / pick / remove
  document.getElementById('gpc-connect')?.addEventListener('click', _connectParishWriter);
  document.getElementById('gpc-reconnect')?.addEventListener('click', _connectParishWriter);
  document.getElementById('gpc-disconnect')?.addEventListener('click', async () => {
    if (!confirm('Remove the parish Google calendar? Parish events will stop syncing until you reconnect.')) return;
    if (writer) await deleteWithRetry(() => sb.from('calendars').delete().eq('id', writer.id));
    await _renderCalendarsTab();
  });
  if (writer) _populateParishCalendarPicker(writer);
  if (writer) _populateWorkCalendarPicker(writer, ps);

  document.getElementById('cal-add-btn').addEventListener('click', () => _openCalendarModal());
}

// Designate the parish's Google account as the global writer — reuses the existing
// personal OAuth connect flow (same authorize URL / callback), but with a
// "parishwriter:" state so the callback stores it as the parish-level writer row.
async function _connectParishWriter() {
  try {
    const res = await fetch('/config');
    const { googleClientId } = res.ok ? await res.json() : {};
    if (!googleClientId) { alert('Google Calendar is not configured — set GOOGLE_CLIENT_ID in Cloudflare env.'); return; }
    const { data: { user } } = await sb.auth.getUser();
    if (!user?.id) { alert('Not signed in.'); return; }
    const params = new URLSearchParams({
      client_id:     googleClientId,
      redirect_uri:  'https://parishdesk.pages.dev/auth/google/callback',
      response_type: 'code',
      scope:         'https://www.googleapis.com/auth/calendar',
      access_type:   'offline',
      prompt:        'consent',
      state:         'parishwriter:' + user.id,
    });
    window.location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
  } catch (e) {
    alert('Could not start Google connection: ' + e.message);
  }
}

// Fetch the designated account's calendar list (via the admin-gated proxy) so the
// admin can pick WHICH calendar is the global parish one (by name, not raw id).
async function _populateParishCalendarPicker(writer) {
  const sel = document.getElementById('gpc-calendar');
  const status = document.getElementById('gpc-status');
  if (!sel) return;
  try {
    const { data: { user } } = await sb.auth.getUser();
    const res = await fetch('/google-calendar-proxy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: user?.id, action: 'listCalendars', target: 'global' }),
    });
    if (!res.ok) { sel.innerHTML = `<option>Could not load calendars (${res.status})</option>`; return; }
    const { items } = await res.json();
    sel.innerHTML = (items || [])
      .map(c => `<option value="${c.id}" ${c.id === writer.url ? 'selected' : ''}>${c.summary}${c.primary ? ' (primary)' : ''}</option>`)
      .join('') || '<option>No calendars found</option>';
  } catch (e) {
    sel.innerHTML = '<option>Error loading calendars</option>';
  }
  document.getElementById('gpc-save')?.addEventListener('click', async () => {
    const calendarId = sel.value;
    const name = sel.options[sel.selectedIndex]?.textContent?.replace(/ \(primary\)$/, '') || 'Parish Google Calendar';
    const color = document.querySelector('[name="gpc-color"]:checked')?.value || writer.color || CAL_PRESETS[1];
    if (!calendarId) return;
    if (status) { status.style.color = '#6B7280'; status.textContent = 'Saving…'; }
    const { error } = await sb.from('calendars').update({ url: calendarId, name, color }).eq('id', writer.id);
    if (error) { if (status) { status.style.color = '#E74C3C'; status.textContent = 'Save failed.'; } return; }
    if (status) { status.style.color = '#2D6A4F'; status.textContent = 'Saved.'; }
    window.flashSaved?.();
  });
}

// Application Work Calendar picker — same connected account as the global writer.
// Lets the admin select (or create) which calendar receives panel-originated events.
// Stored on parish_settings.work_calendar_id.
async function _populateWorkCalendarPicker(writer, ps) {
  const sel = document.getElementById('awc-calendar');
  const status = document.getElementById('awc-status');
  if (!sel) return;
  const { data: { user } } = await sb.auth.getUser();
  const fill = (items) => {
    const cur = ps?.work_calendar_id || writer.url;
    sel.innerHTML = (items || [])
      .map(c => `<option value="${c.id}" ${c.id === cur ? 'selected' : ''}>${c.summary}${c.primary ? ' (primary)' : ''}</option>`)
      .join('') || '<option value="">No calendars found</option>';
  };
  try {
    const res = await fetch('/google-calendar-proxy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: user?.id, action: 'listCalendars', target: 'global' }),
    });
    if (!res.ok) { sel.innerHTML = `<option>Could not load calendars (${res.status})</option>`; return; }
    fill((await res.json()).items);
  } catch (e) { sel.innerHTML = '<option>Error loading calendars</option>'; return; }

  document.getElementById('awc-save')?.addEventListener('click', async () => {
    const calendarId = sel.value;
    const color = document.querySelector('[name="awc-color"]:checked')?.value || ps.work_calendar_color || CAL_PRESETS[1];
    if (!calendarId) return;
    if (status) { status.style.color = '#6B7280'; status.textContent = 'Saving…'; }
    const { data: psRow } = await sb.from('parish_settings').select('id').limit(1).maybeSingle();
    const { error } = await sb.from('parish_settings').update({ work_calendar_id: calendarId, work_calendar_color: color }).eq('id', psRow.id);
    if (error) {
      if (status) {
        status.style.color = '#E74C3C';
        status.textContent = /work_calendar_id|work_calendar_color|schema cache/i.test(error.message)
          ? 'Apply the calendar migrations first.' : 'Save failed.';
      }
      return;
    }
    if (store.parishSettings) { store.parishSettings.work_calendar_id = calendarId; store.parishSettings.work_calendar_color = color; }
    if (status) { status.style.color = '#2D6A4F'; status.textContent = 'Saved.'; }
    window.flashSaved?.();
  });

  document.getElementById('awc-new')?.addEventListener('click', async () => {
    const name = prompt('Name for the new calendar:', 'Parish Events');
    if (!name) return;
    if (status) { status.style.color = '#6B7280'; status.textContent = 'Creating…'; }
    const res = await fetch('/google-calendar-proxy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: user?.id, action: 'createCalendar', target: 'global', calendarName: name.trim() }),
    });
    if (!res.ok) { if (status) { status.style.color = '#E74C3C'; status.textContent = 'Create failed (' + res.status + ').'; } return; }
    const created = await res.json();
    // Reload the list and select the new calendar.
    const listRes = await fetch('/google-calendar-proxy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: user?.id, action: 'listCalendars', target: 'global' }),
    });
    if (listRes.ok) fill((await listRes.json()).items);
    sel.value = created.id;
    if (status) { status.style.color = '#2D6A4F'; status.textContent = 'Created — click Save to use it.'; }
  });
}

function _openCalendarModal(data) {
  const colorPickers = _calColorPickers(data?.color);

  document.getElementById('modal-content').innerHTML = `
    <div class="modal-title">${data?.id ? 'Edit Feed' : 'Add Read-only Feed'}</div>
    <label>Name</label>
    <input id="cal-name" value="${data?.name || ''}" placeholder="e.g. School Calendar" />
    <input type="hidden" id="cal-type" value="ics" />
    <label id="cal-url-label">Feed URL</label>
    <input id="cal-url" value="${data?.url || ''}" placeholder="https://…" />
    <div id="cal-note-ics" style="display:flex;align-items:flex-start;gap:8px;background:#F8F7F4;border:.5px solid #E2DDD6;border-radius:6px;padding:.55rem .75rem;margin-top:4px;">
      <i class="fa-solid fa-circle-info" style="font-size:12px;color:#6B7280;flex-shrink:0;margin-top:2px;"></i>
      <span style="font-size:12px;color:#6B7280;line-height:1.45;"><strong style="color:#374151;">ICS feeds are read-only.</strong> Events are pulled from the URL. To add a <em>writable</em> Google calendar, use “Global Parish Calendar” above. To edit feed events, update them in the source application.</span>
    </div>
    <label style="margin-top:.75rem;">Color</label>
    <div style="display:flex;gap:10px;align-items:center;margin-top:4px;">${colorPickers}</div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" onclick="saveCalendar(${data?.id ? `'${data.id}'` : null})">Save</button>
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
  window.flashSavedThen(async () => { closeModal(); await _renderCalendarsTab(); });
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

// Primary timezone for each US state/territory — instant lookup, no network call.
// States that straddle zones are mapped to their dominant/most-populated timezone.
const STATE_TIMEZONES = {
  AL: 'America/Chicago',
  AK: 'America/Anchorage',
  AZ: 'America/Phoenix',
  AR: 'America/Chicago',
  CA: 'America/Los_Angeles',
  CO: 'America/Denver',
  CT: 'America/New_York',
  DE: 'America/New_York',
  FL: 'America/New_York',
  GA: 'America/New_York',
  HI: 'Pacific/Honolulu',
  ID: 'America/Boise',
  IL: 'America/Chicago',
  IN: 'America/Indiana/Indianapolis',
  IA: 'America/Chicago',
  KS: 'America/Chicago',
  KY: 'America/New_York',
  LA: 'America/Chicago',
  ME: 'America/New_York',
  MD: 'America/New_York',
  MA: 'America/New_York',
  MI: 'America/Detroit',
  MN: 'America/Chicago',
  MS: 'America/Chicago',
  MO: 'America/Chicago',
  MT: 'America/Denver',
  NE: 'America/Chicago',
  NV: 'America/Los_Angeles',
  NH: 'America/New_York',
  NJ: 'America/New_York',
  NM: 'America/Denver',
  NY: 'America/New_York',
  NC: 'America/New_York',
  ND: 'America/Chicago',
  OH: 'America/New_York',
  OK: 'America/Chicago',
  OR: 'America/Los_Angeles',
  PA: 'America/New_York',
  RI: 'America/New_York',
  SC: 'America/New_York',
  SD: 'America/Chicago',
  TN: 'America/Chicago',
  TX: 'America/Chicago',
  UT: 'America/Denver',
  VT: 'America/New_York',
  VA: 'America/New_York',
  WA: 'America/Los_Angeles',
  WV: 'America/New_York',
  WI: 'America/Chicago',
  WY: 'America/Denver',
  DC: 'America/New_York',
  PR: 'America/Puerto_Rico',
  VI: 'America/St_Thomas',
  GU: 'Pacific/Guam',
};

function _detectTimezone(state) {
  return STATE_TIMEZONES[state?.toUpperCase()] || null;
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

    // Auto-detect timezone from state (instant — no network call)
    const detected = state ? _detectTimezone(state) : null;
    const timezone = detected ?? data?.timezone ?? null;
    const tzEl = document.getElementById('ps-tz-display');
    if (tzEl) {
      tzEl.innerHTML = timezone
        ? `Timezone: <strong>${timezone}</strong> <span style="color:#9CA3AF;">(auto-detected)</span>`
        : `<span style="color:#9CA3AF;">Could not detect timezone — select a state to auto-detect.</span>`;
    }

    statusEl.textContent = 'Saving…';
    // Resolve the principal institution's stable id at save time (the principal is the
    // institution whose name matches the parish name — the same rule the legacy
    // name-match used). New saves write the FK; the name string is kept too as a live
    // safety-net fallback. If the institution can't be resolved (list not loaded /
    // no match), preserve any existing FK rather than clobbering it to null.
    const principalId = (store.institutions || []).find(i => i.name === name)?.id
      || store.parishSettings?.principal_institution_id || null;
    const payload = { parish_name: name, primary_institution: name, address, timezone, principal_institution_id: principalId };
    const { error: saveErr } = data
      ? await sb.from('parish_settings').update(payload).eq('id', data.id)
      : await sb.from('parish_settings').insert(payload);
    if (saveErr) { statusEl.textContent = 'Error: ' + saveErr.message; return; }
    store.parishSettings = { ...store.parishSettings, ...payload };
    applyParishName(store.parishSettings?.display_name || name);   // Step 3b: short label where set
    statusEl.textContent = 'Saved.';
    window.flashSaved();
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
    const emailEl  = document.getElementById('inv-email');
    const sendBtn  = document.getElementById('inv-send');
    const statusEl = document.getElementById('inv-status');
    const email    = emailEl.value.trim();
    if (!email) { statusEl.style.color = '#8B1A2F'; statusEl.textContent = 'Email is required.'; return; }

    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    statusEl.style.color = '#6B7280';
    statusEl.textContent = '';

    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 10000);

    try {
      const res  = await fetch('/invite-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const data = await res.json();
      if (!res.ok) {
        statusEl.style.color = '#8B1A2F';
        statusEl.textContent = data.error || 'Invite failed.';
      } else {
        statusEl.style.color = '#2E7D32';
        statusEl.textContent = `Invite sent to ${email}`;
        emailEl.value = '';
      }
    } catch (err) {
      clearTimeout(timeout);
      statusEl.style.color = '#8B1A2F';
      statusEl.textContent = err.name === 'AbortError'
        ? 'Request timed out — please try again.'
        : 'Network error — please try again.';
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send Invite';
    }
  });
}

// ── Expose save handler globally ───────────────────────────────────────────

document.addEventListener('click', e => {
  const saveBtn = e.target.closest('.au-save-btn');
  if (saveBtn) { console.log('admin save clicked', saveBtn.dataset.userId); _saveUser(saveBtn.dataset.userId); return; }

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

// ── Access Audit tab (super-admin) — universal record_grants ledger ─────────
// On-demand only; NO nag prompts. Reads live, so auto-clear deletions simply
// vanish (the activity log retains history). Two pivots over ALL grantable
// record types.

let _auditGrants = [];
let _auditPivot = 'record';   // 'record' | 'person'

function _esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function _fmtDT(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

async function _renderAuditTab() {
  const el = document.getElementById('admin-tab-content');
  if (!el) return;
  el.innerHTML = '<div style="font-size:13px;color:#9CA3AF;font-style:italic;padding:1rem 0;">Loading access ledger…</div>';
  await ensureIdentities(true);
  const grants = await fetchAllGrants();
  // Resolve each record to a human label (best-effort, parallel).
  const labels = await Promise.all(grants.map(g => labelForGrant(g)));
  grants.forEach((g, i) => { g._label = labels[i]; });
  _auditGrants = grants;
  _renderAuditPivot();
}

function _auditPivotToggle() {
  return `
    <div style="display:flex;gap:8px;margin-bottom:1rem;">
      ${['record', 'person'].map(p => `
        <button onclick="window.adminAuditPivot('${p}')" style="
          background:${_auditPivot === p ? '#1C2B3A' : '#fff'};color:${_auditPivot === p ? '#fff' : '#6B7280'};
          border:.5px solid ${_auditPivot === p ? '#1C2B3A' : '#E2DDD6'};border-radius:6px;
          padding:.4rem .9rem;font-size:12.5px;font-family:'Inter',sans-serif;cursor:pointer;">
          ${p === 'record' ? 'By file' : 'By person'}
        </button>`).join('')}
    </div>`;
}

function _priorityBadge(type) {
  return PRIORITY_TYPES.has(type)
    ? `<span title="High-priority access to review" style="font-size:9.5px;font-weight:700;letter-spacing:.04em;padding:1px 6px;border-radius:3px;background:#FCE8D5;color:#B45309;margin-left:6px;">PRIORITY</span>` : '';
}
function _noteCell(g) {
  return g.note
    ? `<span style="color:#374151;">${_esc(g.note)}</span> <span onclick="window.adminEditGrantNote('${g.id}')" style="cursor:pointer;color:#8FA8BF;font-size:11px;">edit</span>`
    : `<span onclick="window.adminEditGrantNote('${g.id}')" style="cursor:pointer;color:#8FA8BF;font-size:11px;">+ reason</span>`;
}
function _revokeX(g) {
  return `<span title="Revoke access" onclick="window.adminRevokeGrant('${g.id}')" style="cursor:pointer;color:#A32D2D;font-weight:600;flex-shrink:0;">✕</span>`;
}

function _renderAuditPivot() {
  const el = document.getElementById('admin-tab-content');
  if (!el) return;
  if (!_auditGrants.length) {
    el.innerHTML = `${_auditPivotToggle()}<div style="font-size:13px;color:#9CA3AF;font-style:italic;padding:1rem 0;">No active grants. Access granted via the chat “%” controller appears here.</div>`;
    _bindAuditWindow();
    return;
  }

  let body = '';
  if (_auditPivot === 'record') {
    // Group by record_type + record_id ("who can see this file?")
    const groups = new Map();
    _auditGrants.forEach(g => {
      const k = `${g.record_type}|${g.record_id}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(g);
    });
    // Priority record types first, then by label.
    const entries = [...groups.entries()].sort((a, b) => {
      const ap = PRIORITY_TYPES.has(a[1][0].record_type) ? 0 : 1;
      const bp = PRIORITY_TYPES.has(b[1][0].record_type) ? 0 : 1;
      return ap - bp || (a[1][0]._label || '').localeCompare(b[1][0]._label || '');
    });
    body = entries.map(([, rows]) => {
      const g0 = rows[0];
      return `<div class="card" style="margin-bottom:.75rem;padding:.9rem 1rem;">
        <div style="font-size:13.5px;font-weight:600;color:#1C2B3A;margin-bottom:.5rem;">
          ${_esc(g0._label)} <span style="font-size:11px;color:#9CA3AF;font-weight:400;">· ${_esc(recordTypeLabel(g0.record_type))}</span>${_priorityBadge(g0.record_type)}
        </div>
        ${rows.map(g => `
          <div style="display:flex;align-items:center;gap:10px;padding:.4rem 0;border-bottom:.5px solid #F0EDE8;font-size:12px;">
            <div style="flex:1;min-width:0;">
              <span style="color:#1C2B3A;font-weight:500;">${_esc(userName(g.granted_to))}</span>
              <span style="color:#9CA3AF;"> · granted by ${_esc(userName(g.granted_by))} · ${_fmtDT(g.granted_at)}</span>
              <div style="font-size:11.5px;margin-top:1px;">${_noteCell(g)}</div>
            </div>
            ${_revokeX(g)}
          </div>`).join('')}
      </div>`;
    }).join('');
  } else {
    // Group by granted_to ("what has this user been granted?")
    const groups = new Map();
    _auditGrants.forEach(g => {
      if (!groups.has(g.granted_to)) groups.set(g.granted_to, []);
      groups.get(g.granted_to).push(g);
    });
    const entries = [...groups.entries()].sort((a, b) => userName(a[0]).localeCompare(userName(b[0])));
    body = entries.map(([uid, rows]) => `
      <div class="card" style="margin-bottom:.75rem;padding:.9rem 1rem;">
        <div style="font-size:13.5px;font-weight:600;color:#1C2B3A;margin-bottom:.5rem;">${_esc(userName(uid))}</div>
        ${rows.sort((a, b) => (PRIORITY_TYPES.has(a.record_type) ? 0 : 1) - (PRIORITY_TYPES.has(b.record_type) ? 0 : 1)).map(g => `
          <div style="display:flex;align-items:center;gap:10px;padding:.4rem 0;border-bottom:.5px solid #F0EDE8;font-size:12px;">
            <div style="flex:1;min-width:0;">
              <span style="color:#1C2B3A;font-weight:500;">${_esc(g._label)}</span> <span style="color:#9CA3AF;font-size:11px;">· ${_esc(recordTypeLabel(g.record_type))}</span>${_priorityBadge(g.record_type)}
              <span style="color:#9CA3AF;"> · by ${_esc(userName(g.granted_by))} · ${_fmtDT(g.granted_at)}</span>
              <div style="font-size:11.5px;margin-top:1px;">${_noteCell(g)}</div>
            </div>
            ${_revokeX(g)}
          </div>`).join('')}
      </div>`).join('');
  }

  el.innerHTML = `${_auditPivotToggle()}${body}`;
  _bindAuditWindow();
}

function _bindAuditWindow() {
  window.adminAuditPivot = (p) => { _auditPivot = p; _renderAuditPivot(); };
  window.adminRevokeGrant = async (grantId) => {
    if (!confirm('Revoke this access? The recipient will immediately lose access to the file.')) return;
    const { error } = await revokeGrant(grantId);
    if (error) { alert('Revoke failed: ' + error.message); return; }
    _auditGrants = _auditGrants.filter(g => g.id !== grantId);
    _renderAuditPivot();
  };
  window.adminEditGrantNote = async (grantId) => {
    const g = _auditGrants.find(x => x.id === grantId);
    const note = prompt('Reason for this grant (leave blank to clear):', g?.note || '');
    if (note === null) return;
    const { error } = await setGrantNote(grantId, note.trim());
    if (error) { alert('Could not save note: ' + error.message); return; }
    if (g) g.note = note.trim() || null;
    _renderAuditPivot();
  };
}

// ── Diocesan Calendar tab ────────────────────────────────────────────────────
let _dioOverrides = [];
let _dioEditId = null;
const DIO_RANKS  = ['Solemnity', 'Feast', 'Memorial', 'Optional Memorial'];
const DIO_COLORS = [['WHITE', 'White', '#F0EDE6'], ['GOLD', 'Gold', '#C9A84C'], ['RED', 'Red', '#8B1A2F'], ['PURPLE', 'Violet', '#534AB7'], ['GREEN', 'Green', '#3B6D11'], ['BLACK', 'Black', '#2C2C2A']];
const DIO_ANCHORS = [['easter', 'Easter Sunday'], ['ashWednesday', 'Ash Wednesday'], ['goodFriday', 'Good Friday'], ['ascension', 'Ascension'], ['pentecost', 'Pentecost']];

async function _renderDiocesanTab() {
  const el = document.getElementById('admin-tab-content'); if (!el) return;
  el.innerHTML = '<div style="font-size:13px;color:#9CA3AF;">Loading…</div>';
  const [psRes, ovRes] = await Promise.all([
    sb.from('parish_settings').select('id,ascension_on_sunday,epiphany_on_sunday,corpus_christi_on_sunday').limit(1).maybeSingle(),
    sb.from('diocesan_overrides').select('*').order('name'),
  ]);
  const missing = (e) => e && /(does not exist|relation|column .* does not exist|schema cache)/i.test(e.message || '');
  if (missing(psRes.error) || missing(ovRes.error)) {
    el.innerHTML = `<div style="background:#FEF9E7;border:.5px solid #E8D9A0;border-radius:8px;padding:1rem 1.2rem;font-size:13px;color:#7D6608;line-height:1.6;">
      The Diocesan Calendar needs its migration. Apply <code>supabase/migrations/20260621_diocesan_calendar.sql</code> (and the separate <code>ALTER TABLE diocesan_overrides DISABLE ROW LEVEL SECURITY;</code>), then reload.</div>`;
    return;
  }
  const ps = psRes.data || {};
  const tog = (v) => (v === undefined || v === null) ? true : !!v;
  _dioOverrides = ovRes.data || [];

  const card = 'background:#fff;border:.5px solid #E2DDD6;border-radius:8px;padding:1.2rem 1.4rem;margin-bottom:1.2rem;';
  const head = 'font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;margin-bottom:1rem;';
  const toggleRow = (field, label, on, sub) => `
    <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;margin-bottom:.85rem;">
      <input type="checkbox" ${on ? 'checked' : ''} onchange="window.dioSaveToggle('${field}',this.checked)" style="width:15px;height:15px;accent-color:var(--cardinal);margin-top:2px;flex-shrink:0;" />
      <span><span style="font-size:13px;color:#1C2B3A;font-weight:500;">${label}</span><br><span style="font-size:11.5px;color:#9CA3AF;">${sub}</span></span>
    </label>`;

  el.innerHTML = `
    <div style="${card}max-width:520px;">
      <div style="${head}">Transfer Settings</div>
      <div style="font-size:12px;color:#6B7280;margin:-.5rem 0 1rem;line-height:1.5;">Which day these moveable feasts are observed on. These feed the liturgical-calendar computation. Default (on) = transferred to Sunday, the common US practice.</div>
      ${toggleRow('ascension_on_sunday', 'Ascension on Sunday', tog(ps.ascension_on_sunday), 'Off = observed on Thursday (40 days after Easter).')}
      ${toggleRow('epiphany_on_sunday', 'Epiphany on Sunday', tog(ps.epiphany_on_sunday), 'Off = observed on January 6 (traditional).')}
      ${toggleRow('corpus_christi_on_sunday', 'Corpus Christi on Sunday', tog(ps.corpus_christi_on_sunday), 'Off = observed on Thursday after Trinity Sunday.')}
    </div>
    <div style="${card}max-width:520px;">
      <div style="${head}">Festal Overrides</div>
      <div style="font-size:12px;color:#6B7280;margin:-.5rem 0 1rem;line-height:1.5;">Local feasts that replace the day's celebration in the header. (Local overrides are never holy days of obligation — the ✠ comes only from the day being a Sunday or holy day.)</div>
      <div id="dio-list">${_dioListHtml()}</div>
      <div id="dio-form">${_dioFormHtml()}</div>
    </div>`;
}

function _dioListHtml() {
  if (!_dioOverrides.length) return '<div style="font-size:13px;color:#9CA3AF;font-style:italic;margin-bottom:1rem;">No overrides yet.</div>';
  return _dioOverrides.map(o => {
    const sw = (DIO_COLORS.find(c => c[0] === o.color) || DIO_COLORS[0])[2];
    let rule = '';
    if (o.rule_type === 'fixed') rule = `${o.month}/${o.day} yearly`;
    else if (o.rule_type === 'oneoff') rule = String(o.full_date || '').slice(0, 10);
    else if (o.rule_type === 'anchored') { const a = (DIO_ANCHORS.find(x => x[0] === o.anchor) || [])[1] || o.anchor; const n = Number(o.offset_days || 0); rule = `${Math.abs(n)} day${Math.abs(n) === 1 ? '' : 's'} ${n < 0 ? 'before' : 'after'} ${a}`; }
    return `<div style="display:flex;align-items:center;gap:10px;padding:.6rem 0;border-bottom:.5px solid #F0EDE8;">
      <span style="width:12px;height:12px;border-radius:50%;background:${sw};flex-shrink:0;"></span>
      <div style="flex:1;min-width:0;"><div style="font-size:13.5px;color:#1C2B3A;font-weight:500;">${_esc(o.name)}</div>
        <div style="font-size:11.5px;color:#9CA3AF;">${_esc(o.rank)} · ${_esc(rule)}</div></div>
      <button onclick="window.dioEdit('${o.id}')" style="background:none;border:none;cursor:pointer;color:#8FA8BF;font-size:12px;">Edit</button>
      <button onclick="window.dioDelete('${o.id}')" style="background:none;border:none;cursor:pointer;color:#A32D2D;font-size:12px;">Delete</button>
    </div>`;
  }).join('');
}

function _dioFormHtml() {
  const o = _dioEditId ? _dioOverrides.find(x => x.id === _dioEditId) : null;
  const inp = 'box-sizing:border-box;padding:.4rem .6rem;border:.5px solid #D1C9BE;border-radius:5px;font-size:13px;font-family:Inter,sans-serif;outline:none;background:#fff;';
  const lbl = 'display:block;font-size:11px;color:#6B7280;margin-bottom:3px;';
  const rt = o?.rule_type || 'fixed';
  const sel = (v, cur) => v === cur ? ' selected' : '';
  return `
    <div style="margin-top:1rem;padding-top:1rem;border-top:1px dashed #E2DDD6;">
      <div style="font-size:12.5px;font-weight:600;color:#1C2B3A;margin-bottom:.75rem;">${o ? 'Edit override' : 'Add override'}</div>
      <label style="${lbl}">Feast Name</label>
      <input id="dio-name" value="${_esc(o?.name || '')}" placeholder="Our Lady of the Passion" style="${inp}width:100%;margin-bottom:.7rem;" />
      <div style="display:flex;gap:.6rem;margin-bottom:.7rem;">
        <div style="flex:1;"><label style="${lbl}">Rank</label><select id="dio-rank" style="${inp}width:100%;cursor:pointer;">${DIO_RANKS.map(r => `<option${sel(r, o?.rank || 'Memorial')}>${r}</option>`).join('')}</select></div>
        <div style="flex:1;"><label style="${lbl}">Color</label><select id="dio-color" style="${inp}width:100%;cursor:pointer;">${DIO_COLORS.map(c => `<option value="${c[0]}"${sel(c[0], o?.color || 'WHITE')}>${c[1]}</option>`).join('')}</select></div>
      </div>
      <label style="${lbl}">Date rule</label>
      <select id="dio-rule" onchange="window.dioRuleChange(this.value)" style="${inp}width:100%;cursor:pointer;margin-bottom:.7rem;">
        <option value="fixed"${sel('fixed', rt)}>Fixed yearly (month/day)</option>
        <option value="oneoff"${sel('oneoff', rt)}>One-off (specific date)</option>
        <option value="anchored"${sel('anchored', rt)}>Moveable (offset from an anchor)</option>
      </select>
      <div id="dio-rule-fields">${_dioRuleFields(rt, o)}</div>
      <div style="display:flex;gap:8px;margin-top:.9rem;">
        <button onclick="window.dioSave()" class="btn-primary" style="padding:.4rem 1rem;font-size:12.5px;">${o ? 'Save' : 'Add'}</button>
        ${o ? `<button onclick="window.dioCancelEdit()" class="btn-secondary" style="padding:.4rem 1rem;font-size:12.5px;">Cancel</button>` : ''}
      </div>
    </div>`;
}

function _dioRuleFields(rt, o) {
  const inp = 'box-sizing:border-box;padding:.4rem .6rem;border:.5px solid #D1C9BE;border-radius:5px;font-size:13px;font-family:Inter,sans-serif;outline:none;background:#fff;';
  const lbl = 'display:block;font-size:11px;color:#6B7280;margin-bottom:3px;';
  const sel = (v, cur) => v === cur ? ' selected' : '';
  if (rt === 'fixed') return `<div style="display:flex;gap:.6rem;"><div><label style="${lbl}">Month</label><input id="dio-month" type="number" min="1" max="12" value="${o?.month || ''}" style="${inp}width:80px;" /></div><div><label style="${lbl}">Day</label><input id="dio-day" type="number" min="1" max="31" value="${o?.day || ''}" style="${inp}width:80px;" /></div></div>`;
  if (rt === 'oneoff') return `<label style="${lbl}">Date</label><input id="dio-fulldate" type="date" value="${String(o?.full_date || '').slice(0, 10)}" style="${inp}" />`;
  return `<div style="display:flex;gap:.6rem;align-items:flex-end;flex-wrap:wrap;">
    <div><label style="${lbl}">Offset (days, − before)</label><input id="dio-offset" type="number" value="${o?.offset_days ?? 0}" style="${inp}width:130px;" /></div>
    <div style="flex:1;min-width:140px;"><label style="${lbl}">Anchor</label><select id="dio-anchor" style="${inp}width:100%;cursor:pointer;">${DIO_ANCHORS.map(a => `<option value="${a[0]}"${sel(a[0], o?.anchor || 'easter')}>${a[1]}</option>`).join('')}</select></div>
  </div>`;
}

if (typeof window !== 'undefined') {
  window.dioSaveToggle = async (field, on) => {
    const { data: ps } = await sb.from('parish_settings').select('id').limit(1).maybeSingle();
    if (!ps?.id) return;
    const { error } = await sb.from('parish_settings').update({ [field]: on }).eq('id', ps.id);
    if (error) { alert('Could not save: ' + error.message); return; }
    if (store.parishSettings) store.parishSettings[field] = on;
    const { initLiturgical } = await import('../liturgical.js');
    initLiturgical();   // refresh header with the new transfer setting
  };
  window.dioRuleChange = (rt) => { const f = document.getElementById('dio-rule-fields'); if (f) f.innerHTML = _dioRuleFields(rt, _dioEditId ? _dioOverrides.find(x => x.id === _dioEditId) : null); };
  window.dioEdit = (id) => { _dioEditId = id; document.getElementById('dio-form').innerHTML = _dioFormHtml(); };
  window.dioCancelEdit = () => { _dioEditId = null; document.getElementById('dio-form').innerHTML = _dioFormHtml(); };
  window.dioSave = async () => {
    const name = (document.getElementById('dio-name')?.value || '').trim();
    if (!name) { alert('Feast name is required.'); return; }
    const rule_type = document.getElementById('dio-rule').value;
    const row = {
      name, rank: document.getElementById('dio-rank').value, color: document.getElementById('dio-color').value,
      rule_type, month: null, day: null, full_date: null, anchor: null, offset_days: 0,
    };
    if (rule_type === 'fixed') {
      row.month = Number(document.getElementById('dio-month')?.value) || null;
      row.day = Number(document.getElementById('dio-day')?.value) || null;
      if (!row.month || !row.day) { alert('Month and day are required.'); return; }
    } else if (rule_type === 'oneoff') {
      row.full_date = document.getElementById('dio-fulldate')?.value || null;
      if (!row.full_date) { alert('A date is required.'); return; }
    } else {
      row.anchor = document.getElementById('dio-anchor').value;
      row.offset_days = Number(document.getElementById('dio-offset')?.value) || 0;
    }
    const q = _dioEditId
      ? sb.from('diocesan_overrides').update(row).eq('id', _dioEditId)
      : sb.from('diocesan_overrides').insert(row);
    const { error } = await q;
    if (error) { alert('Save failed: ' + error.message); return; }
    _dioEditId = null;
    const { data } = await sb.from('diocesan_overrides').select('*').order('name');
    _dioOverrides = data || []; store.diocesanOverrides = _dioOverrides;
    document.getElementById('dio-list').innerHTML = _dioListHtml();
    document.getElementById('dio-form').innerHTML = _dioFormHtml();
    const { initLiturgical } = await import('../liturgical.js');
    initLiturgical();
  };
  window.dioDelete = async (id) => {
    if (!confirm('Delete this override?')) return;
    const { error } = await deleteWithRetry(() => sb.from('diocesan_overrides').delete().eq('id', id));
    if (error) { alert('Delete failed: ' + error.message); return; }
    _dioOverrides = _dioOverrides.filter(o => o.id !== id); store.diocesanOverrides = _dioOverrides;
    if (_dioEditId === id) _dioEditId = null;
    document.getElementById('dio-list').innerHTML = _dioListHtml();
    document.getElementById('dio-form').innerHTML = _dioFormHtml();
    const { initLiturgical } = await import('../liturgical.js');
    initLiturgical();
  };
}
