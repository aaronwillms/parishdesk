import { sb } from '../supabase.js';
import { store } from '../store.js';
import { createContactPicker } from '../ui/contactPicker.js';
import { isTeamAdmin, isSuperAdmin } from '../roles.js';
import { createAvatar } from '../ui/avatar.js';
import { renderDiscussionThread } from '../ui/discussionThread.js';

let _currentTeamId = null;
let _team = null;
let _members = [];
let _activeTab = 'projects';
let _memberPicker = null;

// ── Public entry point ─────────────────────────────────────────────────────

export async function renderTeamDashboard(container, teamId) {
  _currentTeamId = teamId;
  _activeTab = 'projects';
  _memberPicker = null;
  container.innerHTML = '<div style="padding:2rem;text-align:center;color:#9CA3AF;">Loading…</div>';
  await _loadData();
  _render(container);
}

// ── Data ───────────────────────────────────────────────────────────────────

async function _loadData() {
  const [teamRes, membersRes] = await Promise.all([
    sb.from('teams').select('*').eq('id', _currentTeamId).single(),
    sb.from('team_members')
      .select('*, personnel(id,name,title,phone,email,institution,employment)')
      .eq('team_id', _currentTeamId)
      .order('sort_order', { nullsFirst: false }),
  ]);
  if (teamRes.error) console.error('[teamDashboard] team load:', teamRes.error);
  if (membersRes.error) console.error('[teamDashboard] members load:', membersRes.error);
  _team = teamRes.data || null;
  _members = (membersRes.data || []).sort((a, b) => {
    const aName = a.personnel?.name || '';
    const bName = b.personnel?.name || '';
    return aName.localeCompare(bName);
  });
}

// ── Render ─────────────────────────────────────────────────────────────────

const TABS_BASE = [
  { key: 'projects',     label: 'Projects' },
  { key: 'tasks',        label: 'Tasks' },
  { key: 'discussions',  label: 'Discussions' },
  { key: 'schedule',     label: 'Schedule' },
  { key: 'documents',    label: 'Documents' },
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
  } else {
    _renderStub(el, _activeTab);
  }
}

// ── Members tab ────────────────────────────────────────────────────────────

function _renderMembers(el) {
  if (!_members.length) {
    el.innerHTML = `<div style="font-size:13px;color:#9CA3AF;font-style:italic;margin-bottom:1rem;">No members yet.</div>`;
  } else {
    el.innerHTML = `
      <div id="td-member-list">
        ${_members.map(m => _memberRow(m)).join('')}
      </div>
    `;
    _bindMemberRowEvents();
  }

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
      <input id="td-member-role" placeholder="Role in team (optional, e.g. Chair)" style="
        width:100%;box-sizing:border-box;
        padding:.4rem .65rem;border:.5px solid #D1C9BE;border-radius:5px;
        font-size:13px;font-family:'Inter',sans-serif;outline:none;
        margin-bottom:8px;background:#fff;
      " />
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

const TEAM_ROLES = ['President', 'Vice President', 'Secretary', 'Treasurer', 'Coordinator', 'Member', 'Other'];

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

  const PRESET_ROLES = ['President', 'Vice President', 'Secretary', 'Treasurer', 'Coordinator', 'Member'];
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
      const { error } = await sb.from('team_members').delete().eq('id', memberId);
      if (error) { alert('Failed to remove: ' + error.message); return; }
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
  const role = document.getElementById('td-member-role')?.value.trim() || null;
  const existing = _members.find(m => m.personnel_id === person.id);
  if (existing) { alert(`${person.name || 'This person'} is already a member.`); return; }
  const { error } = await sb.from('team_members').insert({
    team_id: _currentTeamId,
    personnel_id: person.id,
    role,
  });
  if (error) { alert('Failed to add member: ' + error.message); return; }
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
