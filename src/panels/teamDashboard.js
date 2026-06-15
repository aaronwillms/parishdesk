import { sb } from '../supabase.js';
import { store } from '../store.js';
import { createContactPicker } from '../ui/contactPicker.js';
import { isTeamAdmin, isSuperAdmin } from '../roles.js';
import { createAvatar } from '../ui/avatar.js';

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
  _members = membersRes.data || [];
}

// ── Render ─────────────────────────────────────────────────────────────────

const TABS = [
  { key: 'projects',    label: 'Projects' },
  { key: 'tasks',       label: 'Tasks' },
  { key: 'schedule',    label: 'Schedule' },
  { key: 'documents',   label: 'Documents' },
  { key: 'members',     label: 'Members' },
];

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
        ${TABS.map(tab => `
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

  // Add member button + picker area
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

function _memberRow(m) {
  const p = m.personnel || {};
  const canRemove = !_isAutoSyncedMember(m);
  return `
    <div class="td-member-row" data-member-id="${m.id}" style="
      display:flex;align-items:center;gap:10px;
      padding:.7rem 0;border-bottom:.5px solid #F0EDE8;
    ">
      <div style="flex:1;min-width:0;">
        <div style="font-size:14px;font-weight:500;color:#1C2B3A;">${p.name || '—'}</div>
        ${p.title ? `<div style="font-size:12px;color:#6B7280;margin-top:1px;">${p.title}</div>` : ''}
      </div>
      <input class="td-role-input" data-member-id="${m.id}" value="${m.role || ''}" placeholder="Role in team"
        style="
          width:140px;padding:.3rem .55rem;border:.5px solid transparent;border-radius:5px;
          font-size:12.5px;font-family:'Inter',sans-serif;color:#374151;
          background:transparent;outline:none;transition:border-color .12s,background .12s;
        "
        title="Click to edit role"
      />
      ${canRemove ? `
      <button class="td-remove-btn" data-member-id="${m.id}" data-team-id="${_currentTeamId}"
        title="Remove from team"
        style="background:none;border:none;cursor:pointer;color:#D1D5DB;font-size:14px;padding:2px 4px;line-height:1;flex-shrink:0;"
        onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#D1D5DB'"
      >✕</button>` : `<span style="width:22px;flex-shrink:0;"></span>`}
    </div>
  `;
}

function _bindMemberRowEvents() {
  document.querySelectorAll('.td-role-input').forEach(input => {
    input.addEventListener('focus', () => {
      input.style.borderColor = '#D1C9BE';
      input.style.background = '#fff';
    });
    input.addEventListener('blur', async () => {
      input.style.borderColor = 'transparent';
      input.style.background = 'transparent';
      const memberId = input.dataset.memberId;
      const role = input.value.trim() || null;
      const current = _members.find(m => m.id === memberId);
      if (!current || current.role === role) return;
      const { error } = await sb.from('team_members').update({ role }).eq('id', memberId);
      if (error) { alert('Failed to save role: ' + error.message); return; }
      current.role = role;
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
  });

  document.querySelectorAll('.td-remove-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this member from the team?')) return;
      const memberId = btn.dataset.memberId;
      const { error } = await sb.from('team_members').delete().eq('id', memberId);
      if (error) { alert('Failed to remove: ' + error.message); return; }
      await _loadData();
      _renderTabContent();
    });
  });
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

// ── Stub tabs ──────────────────────────────────────────────────────────────

const STUB_ICONS = {
  discussions: '💬',
  schedule:    '📅',
  projects:    '📋',
  tasks:       '✅',
  documents:   '📄',
};

function _renderStub(el, tab) {
  const label = TABS.find(t => t.key === tab)?.label || tab;
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
