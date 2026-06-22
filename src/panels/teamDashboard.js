import { sb, deleteWithRetry } from '../supabase.js';
import { store } from '../store.js';
import { createContactPicker } from '../ui/contactPicker.js';
import { logActivity, fmtDate, todayCST, personTitle } from '../utils.js';
import { isTeamAdmin, isSuperAdmin, isAdmin } from '../roles.js';
import { notifyUsers, getUserIdForPersonnel } from '../notifications.js';
import { createAvatar } from '../ui/avatar.js';
import { renderDiscussionThread } from '../ui/discussionThread.js';
import { deriveParishStaffPersonnelIds } from '../ui/parishStaff.js';
import { STATUS, GROUP_ORDER, projectCard, openNewProjectModal } from './projects.js';
import { taskRow, openAddTask as _openAddTask } from './tasks.js';

let _currentTeamId = null;
let _team = null;
let _members = [];
let _activeTab = 'discussions';
let _memberPicker = null;

// Team-scoped filter state (reset when team changes)
let _tpSearch = '';
let _tpFilter = 'all';
let _ttFilter = 'all';
let _ttSearch = '';

// ── Public entry point ─────────────────────────────────────────────────────

export async function renderTeamDashboard(container, teamId) {
  _currentTeamId = teamId;
  _activeTab = 'discussions';
  _memberPicker = null;
  _tpSearch = ''; _tpFilter = 'all'; _ttFilter = 'all'; _ttSearch = '';
  container.innerHTML = '<div style="padding:2rem;text-align:center;color:#9CA3AF;">Loading…</div>';
  await _loadData();
  _render(container);
}

// ── Data ───────────────────────────────────────────────────────────────────

async function _loadData() {
  const teamRes = await sb.from('teams').select('*').eq('id', _currentTeamId).single();
  if (teamRes.error) console.error('[teamDashboard] team load:', teamRes.error);
  _team = teamRes.data || null;

  if (_team?.is_protected) {
    // Parish Staff is DERIVED from HR at read time — never a stored member list.
    // Recompute the membership from the current HR occupancy state on every view.
    const ids = await deriveParishStaffPersonnelIds();
    const { data: people } = ids.length
      ? await sb.from('personnel').select('id,name,phone,email,institution,employment').in('id', ids)
      : { data: [] };
    _members = (people || []).map(p => ({ id: `hr:${p.id}`, personnel_id: p.id, role: null, personnel: p }));
  } else {
    const membersRes = await sb.from('team_members')
      .select('*, personnel(id,name,phone,email,institution,employment)')
      .eq('team_id', _currentTeamId)
      .order('sort_order', { nullsFirst: false });
    if (membersRes.error) console.error('[teamDashboard] members load:', membersRes.error);
    _members = membersRes.data || [];
  }
  _members.sort((a, b) => (a.personnel?.name || '').localeCompare(b.personnel?.name || ''));
  // personnel.title was retired in the HR Stage 1 collapse — derive the
  // directory title from current HR positions so the member rows still show it.
  _members.forEach(m => { if (m.personnel) m.personnel.title = personTitle(m.personnel.id); });
}

// ── Render ─────────────────────────────────────────────────────────────────

const TABS_BASE = [
  { key: 'discussions',  label: 'Discussions' },
  { key: 'projects',     label: 'Projects' },
  { key: 'tasks',        label: 'Tasks' },
  { key: 'schedule',     label: 'Schedule' },
  { key: 'members',      label: 'Members' },
];
const TAB_SETTINGS = { key: 'settings', label: 'Settings' };
function _tabs() {
  return isTeamAdmin(_currentTeamId)
    ? [...TABS_BASE, TAB_SETTINGS]
    : TABS_BASE;
}

function _render(container) {
  if (!_team) {
    container.innerHTML = '<div style="padding:2rem;color:#E74C3C;">Team not found.</div>';
    return;
  }

  // Parish Staff public view: non-admins see only a read-only members directory
  if (_team.is_protected && !isTeamAdmin(_team.id)) {
    _renderPublicStaffDirectory(container);
    return;
  }

  container.innerHTML = `
    <div id="td-root" style="max-width:860px;margin:0 auto;">
      <!-- Header -->
      <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:1.25rem;">
        <button id="td-back" style="
          background:none;border:none;cursor:pointer;
          color:#8FA8BF;font-size:20px;padding:0 4px;
          line-height:1;margin-top:3px;flex-shrink:0;
        " title="Back to Teams" onmouseover="this.style.color='#1C2B3A'" onmouseout="this.style.color='#8FA8BF'">←</button>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:10px;">
            <i class="fa-solid ${_team.is_protected ? 'fa-church' : (_team.icon || 'fa-users')}" style="font-size:26px;color:#8B1A2F;flex-shrink:0;"></i>
            <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:26px;font-weight:700;color:#1C2B3A;margin:0;line-height:1.2;">${_team.name}</h1>
          </div>
          ${_team.description ? `<div style="font-size:13.5px;color:#6B7280;margin-top:4px;">${_team.description}</div>` : ''}
        </div>
        ${(!_team.is_protected && isTeamAdmin(_team.id)) ? `
        <button onclick="openTeamSettings('${_team.id}')" title="Edit team" style="
          background:none;border:.5px solid #D1C9BE;border-radius:6px;
          padding:.3rem .65rem;font-size:12px;font-family:'Inter',sans-serif;
          color:#6B7280;cursor:pointer;flex-shrink:0;margin-top:4px;
        " onmouseover="this.style.borderColor='#1C2B3A';this.style.color='#1C2B3A';" onmouseout="this.style.borderColor='#D1C9BE';this.style.color='#6B7280';">
          ⚙ Edit
        </button>` : ''}
      </div>

      <!-- Tab bar -->
      <div id="td-tabs" style="display:flex;gap:0;border-bottom:1.5px solid #E2DDD6;margin-bottom:1.25rem;overflow-x:auto;">
        ${_tabs().map(tab => `
          <button class="td-tab" data-tab="${tab.key}" style="
            background:none;border:none;border-bottom:2.5px solid transparent;
            padding:.55rem 1rem;font-size:13px;font-family:'Inter',sans-serif;
            font-weight:500;color:#9CA3AF;cursor:pointer;white-space:nowrap;
            margin-bottom:-1.5px;transition:color .12s,border-color .12s;
            ${tab.key === _activeTab ? 'color:#1C2B3A;border-bottom-color:#8B1A2F;' : ''}
          ">${tab.label}</button>
        `).join('')}
      </div>

      <!-- Tab content -->
      <div id="td-content"></div>
    </div>
  `;

  document.getElementById('td-back').addEventListener('click', () => {
    window.switchPanel('teams');
  });

  document.querySelectorAll('.td-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeTab = btn.dataset.tab;
      document.querySelectorAll('.td-tab').forEach(b => {
        b.style.color = '#9CA3AF';
        b.style.borderBottomColor = 'transparent';
      });
      btn.style.color = '#1C2B3A';
      btn.style.borderBottomColor = '#8B1A2F';
      _renderTabContent();
    });
  });

  _renderTabContent();
}

function _renderPublicStaffDirectory(container) {
  const teamName = _team?.name || 'Parish Staff';
  container.innerHTML = `
    <div id="td-root" style="max-width:860px;margin:0 auto;">
      <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:1.5rem;">
        <button id="td-back" style="
          background:none;border:none;cursor:pointer;
          color:#8FA8BF;font-size:20px;padding:0 4px;
          line-height:1;margin-top:3px;flex-shrink:0;
        " title="Back to Teams" onmouseover="this.style.color='#1C2B3A'" onmouseout="this.style.color='#8FA8BF'">←</button>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:10px;">
            <i class="fa-solid fa-church" style="font-size:20px;color:#8B1A2F;"></i>
            <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:26px;font-weight:700;color:#1C2B3A;margin:0;line-height:1.2;">${teamName}</h1>
          </div>
          ${_team.description ? `<div style="font-size:13.5px;color:#6B7280;margin-top:4px;">${_team.description}</div>` : ''}
        </div>
      </div>
      <div id="td-public-members"></div>
    </div>
  `;

  document.getElementById('td-back').addEventListener('click', () => window.switchPanel('teams'));

  const el = document.getElementById('td-public-members');
  if (!_members.length) {
    el.innerHTML = '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No members listed.</div>';
    return;
  }

  el.innerHTML = _members.map((m, i) => {
    const p = m.personnel || {};
    return `
      <div class="td-pub-row" data-idx="${i}" style="
        display:flex;align-items:center;gap:12px;
        padding:.75rem 0;border-bottom:.5px solid #F0EDE8;
      ">
        <div class="td-pub-avatar" data-idx="${i}" style="
          width:36px;height:36px;border-radius:50%;background:#E2DDD6;
          flex-shrink:0;overflow:hidden;
        "></div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:14px;font-weight:500;color:#1C2B3A;">${p.name || '—'}</div>
          ${p.title ? `<div style="font-size:12px;color:#6B7280;margin-top:1px;">${p.title}</div>` : ''}
        </div>
        ${p.email ? `<a href="mailto:${p.email}" style="font-size:12px;color:#8B1A2F;text-decoration:none;white-space:nowrap;flex-shrink:0;"
          onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">${p.email}</a>` : ''}
      </div>`;
  }).join('');

  // Hydrate avatars
  _members.forEach((m, i) => {
    const slot = el.querySelector(`.td-pub-avatar[data-idx="${i}"]`);
    if (!slot) return;
    const p = m.personnel || {};
    createAvatar({ container: slot, userId: m.personnel_id || '', name: p.name || '', size: 36 });
  });
}

function _renderTabContent() {
  const el = document.getElementById('td-content');
  if (!el) return;
  if (_activeTab === 'members') {
    _renderMembers(el);
  } else if (_activeTab === 'settings') {
    _renderSettings(el);
  } else if (_activeTab === 'discussions') {
    renderDiscussionThread({ container: el, contextType: 'team', contextId: _currentTeamId });
  } else if (_activeTab === 'projects') {
    _renderTeamProjects(el);
  } else if (_activeTab === 'tasks') {
    _renderTeamTasks(el);
  } else {
    _renderStub(el, _activeTab);
  }
}

// ── Members tab ────────────────────────────────────────────────────────────

function _renderMembers(el) {
  _members.sort((a, b) => (a.personnel?.name || '').localeCompare(b.personnel?.name || ''));
  // Parish Staff: membership is derived from HR and not manually editable — note it
  // lightly and render the list read-only (no add/remove controls).
  const derivedNote = _team?.is_protected
    ? `<div style="font-size:11.5px;color:#9CA3AF;font-style:italic;margin-bottom:.85rem;line-height:1.5;"><i class="fa-solid fa-circle-info" style="margin-right:5px;"></i>Membership is derived from HR — current Full-Time, Part-Time, and clergy staff at the primary institution. Update a person's position in the <strong>Human Resources</strong> panel to change this list.</div>`
    : '';
  if (!_members.length) {
    el.innerHTML = `${derivedNote}<div style="font-size:13px;color:#9CA3AF;font-style:italic;margin-bottom:1rem;">No members yet.</div>`;
  } else {
    el.innerHTML = `
      ${derivedNote}
      <div id="td-member-list">
        ${_members.map(m => _memberRow(m)).join('')}
      </div>
    `;
    _bindMemberRowEvents();
  }

  // Parish Staff is read-only (derived from HR) — no manual add/remove.
  if (_team?.is_protected) return;
  // Add member button + picker area — team admins only
  if (!isTeamAdmin(_currentTeamId)) return;
  const addArea = document.createElement('div');
  addArea.id = 'td-add-area';
  addArea.style.cssText = 'margin-top:1rem;';
  addArea.innerHTML = `
    <button id="td-add-member-btn" style="
      font-size:13px;color:#8B1A2F;background:none;border:none;
      cursor:pointer;font-family:'Inter',sans-serif;padding:0;font-weight:500;
    ">+ Add member</button>
    <div id="td-picker-wrap" style="display:none;margin-top:.75rem;background:#F8F7F4;border:.5px solid #E2DDD6;border-radius:8px;padding:.85rem .9rem;">
      <div style="font-size:12px;font-weight:600;color:#555;margin-bottom:8px;">Add member to ${_team?.name}</div>
      <div id="td-cp-container" style="margin-bottom:8px;"></div>
      <select id="td-member-role" style="
        width:100%;box-sizing:border-box;
        padding:.4rem .65rem;border:.5px solid #D1C9BE;border-radius:5px;
        font-size:13px;font-family:'Inter',sans-serif;outline:none;
        margin-bottom:8px;background:#fff;
      " onchange="document.getElementById('td-role-other-wrap').style.display=this.value==='Other'?'':'none'">
        <option value="">— Role (optional) —</option>
        <option value="President">President</option>
        <option value="Vice President">Vice President</option>
        <option value="Secretary">Secretary</option>
        <option value="Treasurer">Treasurer</option>
        <option value="Coordinator">Coordinator</option>
        <option value="Member" selected>Member</option>
        <option value="Ad Hoc">Ad Hoc</option>
        <option value="Other">Other…</option>
      </select>
      <div id="td-role-other-wrap" style="display:none;margin-bottom:8px;">
        <input id="td-member-role-other" placeholder="Custom role title" style="
          width:100%;box-sizing:border-box;
          padding:.4rem .65rem;border:.5px solid #D1C9BE;border-radius:5px;
          font-size:13px;font-family:'Inter',sans-serif;outline:none;background:#fff;
        " />
      </div>
      <div style="display:flex;gap:8px;">
        <button id="td-picker-confirm" style="
          padding:.35rem .85rem;background:#1C2B3A;color:#fff;border:none;
          border-radius:5px;font-size:12.5px;font-family:'Inter',sans-serif;
          cursor:pointer;font-weight:500;
        ">Add</button>
        <button id="td-picker-cancel" style="
          padding:.35rem .85rem;background:none;color:#6B7280;
          border:.5px solid #D1C9BE;border-radius:5px;
          font-size:12.5px;font-family:'Inter',sans-serif;cursor:pointer;
        ">Cancel</button>
      </div>
    </div>
  `;
  el.appendChild(addArea);

  document.getElementById('td-add-member-btn').addEventListener('click', () => {
    const wrap = document.getElementById('td-picker-wrap');
    wrap.style.display = 'block';
    document.getElementById('td-add-member-btn').style.display = 'none';
    const cpContainer = document.getElementById('td-cp-container');
    const existingIds = new Set(_members.map(m => m.personnel_id));
    _memberPicker = createContactPicker({
      container: cpContainer,
      placeholder: 'Search person…',
      onSelect: () => {},
    });
  });

  document.getElementById('td-picker-cancel').addEventListener('click', () => {
    document.getElementById('td-picker-wrap').style.display = 'none';
    document.getElementById('td-add-member-btn').style.display = '';
    _memberPicker = null;
  });

  document.getElementById('td-picker-confirm').addEventListener('click', _confirmAddMember);
}

const STAFF_TYPES = new Set(['full-time', 'part-time']);

function _isAutoSyncedMember(m) {
  return _team?.is_protected && STAFF_TYPES.has(m.personnel?.employment);
}

const TEAM_ROLES = ['President', 'Vice President', 'Secretary', 'Treasurer', 'Coordinator', 'Member', 'Ad Hoc', 'Other'];

function _memberRow(m) {
  const p = m.personnel || {};
  const showCog = !_team?.is_protected && isTeamAdmin(_currentTeamId);
  const roleLabel = m.role && !TEAM_ROLES.slice(0, -1).includes(m.role)
    ? m.role   // custom "Other" value stored directly
    : m.role || null;
  return `
    <div class="td-member-row" data-member-id="${m.id}" style="
      display:flex;align-items:center;gap:10px;
      padding:.7rem 0;border-bottom:.5px solid #F0EDE8;
    ">
      <div style="flex:1;min-width:0;">
        <div style="font-size:14px;font-weight:500;color:#1C2B3A;">${p.name || '—'}</div>
        ${roleLabel ? `<div style="font-size:12px;color:#6B7280;margin-top:1px;">${roleLabel}</div>` :
          p.title ? `<div style="font-size:12px;color:#6B7280;margin-top:1px;">${p.title}</div>` : ''}
      </div>
      ${showCog ? `
      <button class="td-cog-btn" data-member-id="${m.id}"
        title="Member options"
        style="background:none;border:none;cursor:pointer;color:#9CA3AF;font-size:15px;padding:3px 5px;line-height:1;flex-shrink:0;"
        onmouseover="this.style.color='#1C2B3A'" onmouseout="this.style.color='#9CA3AF'"
      ><i class="fa-solid fa-gear"></i></button>` : ''}
    </div>
  `;
}

function _bindMemberRowEvents() {
  document.querySelectorAll('.td-cog-btn').forEach(btn => {
    btn.addEventListener('click', () => _openMemberModal(btn.dataset.memberId));
  });
}

function _openMemberModal(memberId) {
  const m = _members.find(x => x.id === memberId);
  if (!m) return;
  const p = m.personnel || {};
  const canRemove = !_isAutoSyncedMember(m);

  const PRESET_ROLES = ['President', 'Vice President', 'Secretary', 'Treasurer', 'Coordinator', 'Member', 'Ad Hoc'];
  const currentRole = m.role || 'Member';
  const isOther = currentRole && !PRESET_ROLES.includes(currentRole);
  const selectVal = isOther ? 'Other' : (currentRole || 'Member');

  document.getElementById('modal-content').innerHTML = `
    <div class="modal-title">${p.name || 'Member'}</div>
    ${p.title ? `<div style="font-size:13px;color:#6B7280;margin-top:-8px;margin-bottom:12px;">${p.title}</div>` : ''}
    <label>Team role</label>
    <select id="tm-role-select" onchange="document.getElementById('tm-other-wrap').style.display=this.value==='Other'?'':'none'">
      ${PRESET_ROLES.map(r => `<option value="${r}"${selectVal===r?' selected':''}>${r}</option>`).join('')}
      <option value="Other"${isOther?' selected':''}>Other…</option>
    </select>
    <div id="tm-other-wrap" style="${isOther ? '' : 'display:none;'}margin-top:.5rem;">
      <input id="tm-role-other" placeholder="Custom role title" value="${isOther ? currentRole : ''}" style="width:100%;box-sizing:border-box;" />
    </div>
    <div class="modal-actions" style="justify-content:space-between;margin-top:1.25rem;">
      ${canRemove ? `<button id="tm-remove-btn" class="btn-secondary" style="color:#8B1A2F;border-color:#8B1A2F;">Remove from team</button>` : '<span></span>'}
      <div style="display:flex;gap:8px;">
        <button class="btn-secondary" onclick="closeModal()">Cancel</button>
        <button id="tm-save-btn" class="btn-primary">Save</button>
      </div>
    </div>
  `;
  document.getElementById('modal-overlay').classList.add('open');

  document.getElementById('tm-save-btn').addEventListener('click', async () => {
    const sel = document.getElementById('tm-role-select').value;
    const role = sel === 'Other'
      ? (document.getElementById('tm-role-other')?.value.trim() || 'Other')
      : sel;
    const { error } = await sb.from('team_members').update({ role }).eq('id', memberId);
    if (error) { alert('Failed to save: ' + error.message); return; }
    m.role = role;
    closeModal();
    _renderTabContent();
  });

  if (canRemove) {
    document.getElementById('tm-remove-btn').addEventListener('click', async () => {
      if (!confirm(`Remove ${p.name || 'this member'} from the team?`)) return;
      const { error } = await deleteWithRetry(() => sb.from('team_members').delete().eq('id', memberId));
      if (error) { alert('Failed to remove: ' + error.message); return; }
      logActivity({ action: 'removed member from team', entityType: 'team', entityName: _team?.name || 'Unknown', contextType: 'team', contextId: _currentTeamId });
      closeModal();
      await _loadData();
      _renderTabContent();
    });
  }
}

async function _confirmAddMember() {
  if (!_memberPicker) return;
  const person = _memberPicker.getValue();
  if (!person) { alert('Please select a person.'); return; }
  const sel = document.getElementById('td-member-role')?.value || '';
  const role = sel === 'Other'
    ? (document.getElementById('td-member-role-other')?.value.trim() || 'Other')
    : (sel || null);
  const existing = _members.find(m => m.personnel_id === person.id);
  if (existing) { alert(`${person.name || 'This person'} is already a member.`); return; }
  const { error } = await sb.from('team_members').insert({
    team_id: _currentTeamId,
    personnel_id: person.id,
    role,
  });
  if (error) { alert('Failed to add member: ' + error.message); return; }
  logActivity({ action: 'added member to team', entityType: 'team', entityName: _team?.name || 'Unknown', contextType: 'team', contextId: _currentTeamId });
  const { data: { user: _me } } = await sb.auth.getUser();
  const newMemberUserId = await getUserIdForPersonnel(person.id);
  if (newMemberUserId) notifyUsers([newMemberUserId], _me?.id, `You've been added to the team: ${_team?.name || 'a team'}`, 'info', 'teams', _currentTeamId);
  _memberPicker = null;
  await _loadData();
  _renderTabContent();
}

// ── Settings tab ───────────────────────────────────────────────────────────

function _renderSettings(el) {
  const projCreation = _team?.project_creation || 'admins_only';

  const memberRows = _members.map(m => {
    const p = m.personnel || {};
    const isTeamAdminMember = m.team_role === 'admin';
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:.6rem 0;border-bottom:.5px solid #F0EDE8;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:14px;font-weight:500;color:#1C2B3A;">${p.name || '—'}</div>
          ${p.title ? `<div style="font-size:12px;color:#6B7280;">${p.title}</div>` : ''}
        </div>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;color:#374151;white-space:nowrap;">
          <input type="checkbox" class="ts-admin-cb" data-member-id="${m.id}"
            ${isTeamAdminMember ? 'checked' : ''}
            style="width:14px;height:14px;accent-color:#8B1A2F;margin:0;" />
          Team admin
        </label>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="card" style="margin-bottom:1rem;">
      <div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.75rem;">Team Admins</div>
      ${memberRows || '<div style="font-size:13px;color:#6B7280;font-style:italic;">No members yet.</div>'}
    </div>

    <div class="card" style="margin-bottom:1rem;">
      <div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.75rem;">Project Creation</div>
      <div style="font-size:13px;color:#374151;margin-bottom:.6rem;">Who can create projects within this team?</div>
      <label style="display:flex;align-items:center;gap:8px;margin-bottom:.5rem;cursor:pointer;font-size:13px;color:#1C2B3A;">
        <input type="radio" name="ts-proj-creation" value="admins_only" ${projCreation === 'admins_only' ? 'checked' : ''}
          style="accent-color:#8B1A2F;margin:0;" />
        Team admins only
      </label>
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:#1C2B3A;">
        <input type="radio" name="ts-proj-creation" value="all_members" ${projCreation === 'all_members' ? 'checked' : ''}
          style="accent-color:#8B1A2F;margin:0;" />
        All team members
      </label>
    </div>

    <div style="display:flex;align-items:center;gap:10px;">
      <button id="ts-save-btn" style="
        padding:.4rem 1.1rem;background:#1C2B3A;color:#fff;border:none;
        border-radius:5px;font-size:13px;font-family:'Inter',sans-serif;
        cursor:pointer;font-weight:500;
      ">Save</button>
      <div id="ts-status" style="font-size:12px;color:#6B7280;"></div>
    </div>
  `;

  document.getElementById('ts-save-btn').addEventListener('click', _saveSettings);
}

async function _saveSettings() {
  const statusEl = document.getElementById('ts-status');
  statusEl.textContent = 'Saving…';

  // team_role updates for each member
  const cbs = document.querySelectorAll('.ts-admin-cb');
  const updates = Array.from(cbs).map(cb => {
    const memberId = cb.dataset.memberId;
    const newRole = cb.checked ? 'admin' : 'member';
    const current = _members.find(m => m.id === memberId);
    if (!current || current.team_role === newRole) return null;
    return sb.from('team_members').update({ team_role: newRole }).eq('id', memberId)
      .then(({ error }) => { if (!error) current.team_role = newRole; return error; });
  }).filter(Boolean);

  // project_creation setting on team
  const projCreation = document.querySelector('input[name="ts-proj-creation"]:checked')?.value || 'admins_only';
  updates.push(
    sb.from('teams').update({ project_creation: projCreation }).eq('id', _currentTeamId)
      .then(({ error }) => { if (!error && _team) _team.project_creation = projCreation; return error; })
  );

  const results = await Promise.all(updates);
  const errs = results.filter(Boolean);
  statusEl.textContent = errs.length ? 'Some changes failed to save.' : 'Saved.';
  setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2500);
}

// ── Stub tabs ──────────────────────────────────────────────────────────────

const STUB_ICONS = {
  discussions: '💬',
  schedule:    '📅',
  projects:    '📋',
  tasks:       '✅',
  documents:   '📄',
};

// ── Team Projects tab ──────────────────────────────────────────────────────

function _renderTeamProjects(el) {
  const canCreate = isAdmin() || isTeamAdmin(_currentTeamId);
  const allProjects = (store.allProjects || []).filter(p => p.team_id === _currentTeamId);

  // Header row
  const header = document.createElement('div');
  header.style.cssText = 'margin-bottom:1rem;';
  header.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:.75rem;">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:1;min-width:0;">
        <div style="position:relative;flex:0 0 auto;width:clamp(160px,240px,100%);">
          <i class="fa-solid fa-magnifying-glass" style="position:absolute;left:9px;top:50%;transform:translateY(-50%);color:#9CA3AF;font-size:11px;pointer-events:none;"></i>
          <input id="tdp-search" placeholder="Search projects…" autocomplete="off" value="${_tpSearch}" style="
            width:100%;box-sizing:border-box;padding:.38rem .75rem .38rem 2rem;
            border:.5px solid #D1C9BE;border-radius:6px;font-size:13px;
            font-family:'Inter',sans-serif;outline:none;background:#fff;" />
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;">
          ${['all','in_progress','blocked','not_started','complete'].map(k => {
            const labels = { all:'All', in_progress:'In Progress', blocked:'Blocked', not_started:'Not Started', complete:'Complete' };
            const active = k === _tpFilter;
            return `<button class="tdp-filter-btn" data-filter="${k}" style="
              padding:.26rem .7rem;font-size:12px;font-family:'Inter',sans-serif;font-weight:500;
              border-radius:20px;border:.5px solid ${active ? '#C9A84C' : '#D1C9BE'};
              background:${active ? '#C9A84C' : '#fff'};color:${active ? '#fff' : '#1C2B3A'};
              cursor:pointer;white-space:nowrap;">${labels[k]}</button>`;
          }).join('')}
        </div>
      </div>
      ${canCreate ? `<button id="tdp-new-btn" style="
        padding:.38rem .9rem;background:#1C2B3A;color:#fff;border:none;border-radius:6px;
        font-size:13px;font-family:'Inter',sans-serif;font-weight:500;cursor:pointer;white-space:nowrap;flex-shrink:0;">
        + New project</button>` : ''}
    </div>
  `;
  el.innerHTML = '';
  el.appendChild(header);

  // Bind header events
  el.querySelector('#tdp-search')?.addEventListener('input', e => {
    _tpSearch = e.target.value;
    _renderTeamProjects(el);
  });
  el.querySelectorAll('.tdp-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => { _tpFilter = btn.dataset.filter; _renderTeamProjects(el); });
  });
  el.querySelector('#tdp-new-btn')?.addEventListener('click', () => {
    openNewProjectModal({ teamId: _currentTeamId });
  });

  // Filter items
  let items = allProjects;
  if (_tpSearch) {
    const q = _tpSearch.toLowerCase();
    items = items.filter(p => p.title?.toLowerCase().includes(q) || p.notes?.toLowerCase().includes(q));
  }
  if (_tpFilter !== 'all') {
    items = items.filter(p => (p.status_code || 'not_started') === _tpFilter);
  }

  const list = document.createElement('div');
  if (!items.length) {
    list.innerHTML = `<div style="font-size:13px;color:#6B7280;padding:.5rem 0;">${
      (_tpSearch || _tpFilter !== 'all') ? 'No projects match your search.' : 'No projects for this team yet.'
    }</div>`;
  } else {
    const grouped = {};
    items.forEach(p => {
      const key = p.status_code || 'not_started';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(p);
    });
    let html = '';
    GROUP_ORDER.forEach(s => {
      const group = grouped[s];
      if (!group?.length) return;
      const st = STATUS[s];
      html += `<div style="margin-bottom:1.5rem;">
        <div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.6rem;display:flex;align-items:center;gap:6px;">
          <span style="width:7px;height:7px;border-radius:50%;background:${st.dot};flex-shrink:0;display:inline-block;"></span>
          ${st.label} <span style="font-weight:400;color:#C4BDB3;">(${group.length})</span>
        </div>
        ${group.map(p => projectCard(p)).join('')}
      </div>`;
    });
    list.innerHTML = html;
  }
  el.appendChild(list);
}

// ── Team Tasks tab ─────────────────────────────────────────────────────────

function _renderTeamTasks(el) {
  const today = todayCST();
  let items = (store.allTasks || []).filter(t => t.team_id === _currentTeamId);

  // Header
  const header = document.createElement('div');
  header.style.cssText = 'margin-bottom:1rem;';
  const filterKeys = [
    { key: 'all', label: 'All' }, { key: 'open', label: 'Open' },
    { key: 'complete', label: 'Complete' },
  ];
  header.innerHTML = `
    <div style="margin-bottom:.75rem;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:.6rem;">
        <div style="display:flex;gap:4px;flex-wrap:wrap;">
          ${filterKeys.map(({ key, label }) => {
            const active = key === _ttFilter;
            return `<button class="tdt-filter-btn" data-filter="${key}" style="
              padding:.26rem .7rem;font-size:12px;font-family:'Inter',sans-serif;font-weight:500;
              border-radius:20px;border:.5px solid ${active ? '#C9A84C' : '#D1C9BE'};
              background:${active ? '#C9A84C' : '#fff'};color:${active ? '#fff' : '#1C2B3A'};
              cursor:pointer;white-space:nowrap;">${label}</button>`;
          }).join('')}
        </div>
        <button id="tdt-new-btn" style="
          padding:.38rem .9rem;background:#1C2B3A;color:#fff;border:none;border-radius:6px;
          font-size:13px;font-family:'Inter',sans-serif;font-weight:500;cursor:pointer;white-space:nowrap;flex-shrink:0;">
          + New task</button>
      </div>
      <div style="position:relative;max-width:280px;">
        <i class="fa-solid fa-magnifying-glass" style="position:absolute;left:9px;top:50%;transform:translateY(-50%);color:#9CA3AF;font-size:11px;pointer-events:none;"></i>
        <input id="tdt-search" placeholder="Search tasks…" autocomplete="off" value="${_ttSearch.replace(/"/g,'&quot;')}" style="
          width:100%;box-sizing:border-box;padding:.38rem .75rem .38rem 2rem;
          border:.5px solid #D1C9BE;border-radius:6px;font-size:13px;
          font-family:'Inter',sans-serif;outline:none;background:#fff;" />
        <button id="tdt-search-clear" style="display:${_ttSearch ? '' : 'none'};position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:#9CA3AF;font-size:13px;padding:0;line-height:1;">✕</button>
      </div>
    </div>
  `;
  el.innerHTML = '';
  el.appendChild(header);

  el.querySelectorAll('.tdt-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => { _ttFilter = btn.dataset.filter; _renderTeamTasks(el); });
  });
  el.querySelector('#tdt-new-btn').addEventListener('click', () => {
    _openAddTask({ teamId: _currentTeamId });
  });
  el.querySelector('#tdt-search')?.addEventListener('input', e => {
    _ttSearch = e.target.value;
    el.querySelector('#tdt-search-clear').style.display = _ttSearch ? '' : 'none';
    _renderTeamTasks(el);
  });
  el.querySelector('#tdt-search-clear')?.addEventListener('click', () => {
    _ttSearch = '';
    el.querySelector('#tdt-search').value = '';
    el.querySelector('#tdt-search-clear').style.display = 'none';
    _renderTeamTasks(el);
  });

  // Apply filters
  if (_ttFilter === 'complete') {
    items = items.filter(t => t.completed);
  } else if (_ttFilter === 'open') {
    items = items.filter(t => !t.completed);
  }
  if (_ttSearch) {
    const q = _ttSearch.toLowerCase();
    items = items.filter(t => t.title?.toLowerCase().includes(q));
  }

  const list = document.createElement('div');
  if (!items.length) {
    list.innerHTML = `<div style="font-size:13px;color:#6B7280;padding:.5rem 0;">${
      (_ttFilter !== 'all' || _ttSearch) ? 'No tasks match your search.' : 'No tasks for this team yet.'
    }</div>`;
  } else {
    const groups = {
      overdue:  { label: 'Overdue',  color: '#922B21', items: [] },
      today:    { label: 'Today',    color: '#1B4F72', items: [] },
      upcoming: { label: 'Upcoming', color: '#6B7280', items: [] },
      nodate:   { label: 'No date',  color: '#9CA3AF', items: [] },
      complete: { label: 'Complete', color: '#1E8449', items: [] },
    };
    items.forEach(t => {
      if (t.completed) { groups.complete.items.push(t); return; }
      if (t.due_date && t.due_date < today)   groups.overdue.items.push(t);
      else if (t.due_date === today)           groups.today.items.push(t);
      else if (t.due_date)                     groups.upcoming.items.push(t);
      else                                     groups.nodate.items.push(t);
    });
    let html = '';
    Object.values(groups).forEach(g => {
      if (!g.items.length) return;
      html += `<div style="margin-bottom:1.25rem;">
        <div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:${g.color};text-transform:uppercase;margin-bottom:.5rem;">${g.label}</div>`;
      g.items.forEach(t => { html += taskRow(t); });
      html += '</div>';
    });
    list.innerHTML = html;
  }
  el.appendChild(list);
}

function _renderStub(el, tab) {
  const label = _tabs().find(t => t.key === tab)?.label || tab;
  el.innerHTML = `
    <div style="
      text-align:center;padding:3.5rem 1rem;color:#9CA3AF;
    ">
      <div style="font-size:36px;margin-bottom:.75rem;">${STUB_ICONS[tab] || '🔧'}</div>
      <div style="font-family:'Cormorant Garamond',Georgia,serif;font-size:20px;font-weight:600;color:#C9A84C;margin-bottom:.4rem;">${label}</div>
      <div style="font-size:13px;">Coming soon</div>
    </div>
  `;
}
