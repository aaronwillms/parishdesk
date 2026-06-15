import { sb } from '../supabase.js';
import { store } from '../store.js';
import { fmtDate, todayCST } from '../utils.js';
import { createContactPicker } from '../ui/contactPicker.js';
import { getUserScope, isVisible } from '../ui/userScope.js';

// ── Status config ──────────────────────────────────────────────────────────

const STATUS = {
  in_progress:  { label: 'In Progress',  color: '#7A5C00', bg: '#FDF3D0' },
  blocked:      { label: 'Blocked',      color: '#7A1020', bg: '#FDEAED' },
  not_started:  { label: 'Not Started',  color: '#4B5563', bg: '#F3F4F6' },
  complete:     { label: 'Complete',     color: '#F5F1EB', bg: '#1C2B3A' },
};

const TABS = [
  { key: 'discussions', label: 'Discussions' },
  { key: 'tasks',       label: 'Tasks' },
  { key: 'members',     label: 'Members' },
  { key: 'project',     label: 'Project Information' },
];

// ── Module state ───────────────────────────────────────────────────────────

let _projectId      = null;
let _project        = null;
let _tasks          = [];
let _activeTab      = 'discussions';
let _taskPicker     = null;
let _memberPicker   = null;
// Multi-person assignees — normalized to array on load
let _assigneeIds    = [];

// ── Public entry point ─────────────────────────────────────────────────────

export async function renderProjectDashboard(container, projectId) {
  _projectId    = projectId;
  _activeTab    = 'discussions';
  _taskPicker   = null;
  _memberPicker = null;
  container.innerHTML = '<div style="padding:2rem;text-align:center;color:#9CA3AF;">Loading…</div>';
  await _load();
  _render(container);
}

// ── Data ───────────────────────────────────────────────────────────────────

async function _load() {
  const [projRes, tasksRes, scope] = await Promise.all([
    sb.from('projects').select('*').eq('id', _projectId).single(),
    sb.from('tasks').select('*').eq('project_id', _projectId).order('created_at'),
    getUserScope(),
  ]);
  if (projRes.error)  console.error('[projectDashboard] project:', projRes.error);
  if (tasksRes.error) console.error('[projectDashboard] tasks:',   tasksRes.error);
  _project = projRes.data || null;
  _tasks   = (tasksRes.data || []).filter(t => isVisible(t, scope));
  // Normalize assigned_to to always be an array of UUIDs
  if (_project) {
    const raw = _project.assigned_to;
    if (Array.isArray(raw))       _assigneeIds = raw.filter(Boolean);
    else if (raw)                 _assigneeIds = [raw];
    else                          _assigneeIds = [];
  } else {
    _assigneeIds = [];
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _statusBadge(code) {
  const st = STATUS[code] || STATUS.not_started;
  return `<span style="font-size:11px;font-weight:700;background:${st.bg};color:${st.color};border-radius:20px;padding:2px 10px;">${st.label}</span>`;
}

function _personnelName(id) {
  if (!id) return null;
  return (store.personnel || []).find(p => p.id === id)?.name || null;
}

// ── Render shell ───────────────────────────────────────────────────────────

function _render(container) {
  if (!_project) {
    container.innerHTML = '<div style="padding:2rem;color:#E74C3C;">Project not found.</div>';
    return;
  }

  container.innerHTML = `
    <div id="pd-root" style="max-width:860px;margin:0 auto;">
      <!-- Header -->
      <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:1.25rem;">
        <button id="pd-back" style="
          background:none;border:none;cursor:pointer;color:#8FA8BF;
          font-size:20px;padding:0 4px;line-height:1;margin-top:4px;flex-shrink:0;
        " onmouseover="this.style.color='#1C2B3A'" onmouseout="this.style.color='#8FA8BF'">←</button>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:4px;">
            <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:26px;font-weight:700;color:#1C2B3A;margin:0;line-height:1.2;">${_project.title}</h1>
            ${_statusBadge(_project.status_code)}
          </div>
          ${_project.notes ? `<div style="font-size:13.5px;color:#6B7280;">${_project.notes}</div>` : ''}
        </div>
      </div>

      <!-- Tab bar -->
      <div style="display:flex;border-bottom:1.5px solid #E2DDD6;margin-bottom:1.25rem;overflow-x:auto;">
        ${TABS.map(tab => `
          <button class="pd-tab" data-tab="${tab.key}" style="
            background:none;border:none;border-bottom:2.5px solid transparent;
            padding:.55rem 1rem;font-size:13px;font-family:'Inter',sans-serif;
            font-weight:500;color:#9CA3AF;cursor:pointer;white-space:nowrap;
            margin-bottom:-1.5px;transition:color .12s,border-color .12s;
            ${tab.key === _activeTab ? 'color:#1C2B3A;border-bottom-color:#8B1A2F;' : ''}
          ">${tab.label}</button>
        `).join('')}
      </div>

      <!-- Tab content -->
      <div id="pd-content"></div>
    </div>
  `;

  document.getElementById('pd-back').addEventListener('click', () => window.switchPanel('projects'));

  document.querySelectorAll('.pd-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeTab    = btn.dataset.tab;
      _taskPicker   = null;
      _memberPicker = null;
      document.querySelectorAll('.pd-tab').forEach(b => {
        b.style.color = '#9CA3AF';
        b.style.borderBottomColor = 'transparent';
      });
      btn.style.color = '#1C2B3A';
      btn.style.borderBottomColor = '#8B1A2F';
      _renderTab();
    });
  });

  _renderTab();
}

function _renderTab() {
  const el = document.getElementById('pd-content');
  if (!el) return;
  if      (_activeTab === 'tasks')   _renderTasks(el);
  else if (_activeTab === 'project') _renderProjectDetails(el);
  else if (_activeTab === 'members') _renderMembers(el);
  else                               _renderStub(el, _activeTab);
}

// ── Discussions stub ───────────────────────────────────────────────────────

function _renderStub(el) {
  el.innerHTML = `
    <div style="text-align:center;padding:3.5rem 1rem;color:#9CA3AF;">
      <div style="font-size:36px;margin-bottom:.75rem;">💬</div>
      <div style="font-family:'Cormorant Garamond',Georgia,serif;font-size:20px;font-weight:600;color:#C9A84C;margin-bottom:.4rem;">Discussions</div>
      <div style="font-size:13px;">Coming soon</div>
    </div>`;
}

// ── Tasks tab ──────────────────────────────────────────────────────────────

function _renderTasks(el) {
  const active    = _tasks.filter(t => !t.completed);
  const completed = _tasks.filter(t =>  t.completed);

  let html = '';
  if (!_tasks.length) {
    html = `<div style="font-size:13px;color:#9CA3AF;font-style:italic;margin-bottom:1rem;">No tasks yet.</div>`;
  } else {
    html += active.map(t => _taskRow(t)).join('');
    if (completed.length) {
      html += `<div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:#C4BDB3;text-transform:uppercase;margin:1rem 0 .5rem;">Completed</div>`;
      html += completed.map(t => _taskRow(t)).join('');
    }
  }

  el.innerHTML = `<div id="pd-task-list">${html}</div>`;
  _bindTaskEvents();
  _appendAddTaskArea(el);
}

function _taskRow(t) {
  const person = _personnelName(t.assigned_to);
  const overdue = t.due_date && !t.completed && t.due_date < todayCST();
  return `
    <div class="pd-task-row" data-task-id="${t.id}" style="
      display:flex;align-items:center;gap:10px;
      padding:.6rem 0;border-bottom:.5px solid #F0EDE8;
    ">
      <input type="checkbox" ${t.completed ? 'checked' : ''} class="pd-task-check" data-task-id="${t.id}"
        style="flex-shrink:0;accent-color:#1C2B3A;width:15px;height:15px;cursor:pointer;" />
      <div style="flex:1;min-width:0;">
        <div style="font-size:13.5px;color:${t.completed ? '#9CA3AF' : '#1C2B3A'};${t.completed ? 'text-decoration:line-through;' : ''}white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${t.title}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:2px;">
          ${person ? `<span style="font-size:11px;color:#8FA8BF;">👤 ${person}</span>` : ''}
          ${t.due_date ? `<span style="font-size:11px;color:${overdue ? '#8B1A2F' : '#9CA3AF'};">📅 ${fmtDate(t.due_date)}</span>` : ''}
        </div>
      </div>
      <button class="pd-task-delete" data-task-id="${t.id}"
        style="background:none;border:none;cursor:pointer;color:transparent;font-size:13px;padding:2px 4px;flex-shrink:0;line-height:1;transition:color .1s;"
        title="Delete task">🗑</button>
    </div>`;
}

function _bindTaskEvents() {
  document.querySelectorAll('.pd-task-check').forEach(cb => {
    cb.addEventListener('change', async () => {
      const taskId  = cb.dataset.taskId;
      const checked = cb.checked;
      const { error } = await sb.from('tasks').update({
        completed:    checked,
        completed_at: checked ? new Date().toISOString() : null,
      }).eq('id', taskId);
      if (error) { alert('Update failed: ' + error.message); return; }
      const t = _tasks.find(x => x.id === taskId);
      if (t) { t.completed = checked; t.completed_at = checked ? new Date().toISOString() : null; }
      const el = document.getElementById('pd-content');
      if (el) _renderTasks(el);
    });
  });

  document.querySelectorAll('.pd-task-row').forEach(row => {
    const del = row.querySelector('.pd-task-delete');
    row.addEventListener('mouseover', () => { if (del) del.style.color = '#C0392B'; });
    row.addEventListener('mouseout',  () => { if (del) del.style.color = 'transparent'; });
  });

  document.querySelectorAll('.pd-task-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this task?')) return;
      const taskId = btn.dataset.taskId;
      const { error } = await sb.from('tasks').delete().eq('id', taskId);
      if (error) { alert('Delete failed: ' + error.message); return; }
      _tasks = _tasks.filter(t => t.id !== taskId);
      const el = document.getElementById('pd-content');
      if (el) _renderTasks(el);
    });
  });
}

function _appendAddTaskArea(el) {
  const addArea = document.createElement('div');
  addArea.style.cssText = 'margin-top:1rem;';
  addArea.innerHTML = `
    <button id="pd-add-task-btn" style="
      font-size:13px;color:#8B1A2F;background:none;border:none;
      cursor:pointer;font-family:'Inter',sans-serif;padding:0;font-weight:500;
    ">+ Add task</button>
    <div id="pd-add-task-form" style="display:none;margin-top:.75rem;background:#F8F7F4;border:.5px solid #E2DDD6;border-radius:8px;padding:.85rem .9rem;">
      <div style="font-size:12px;font-weight:600;color:#555;margin-bottom:8px;">New task</div>
      <input id="pd-task-title" placeholder="Task title *" style="
        width:100%;box-sizing:border-box;padding:.4rem .65rem;
        border:.5px solid #D1C9BE;border-radius:5px;font-size:13px;
        font-family:'Inter',sans-serif;outline:none;margin-bottom:8px;background:#fff;
      " />
      <div id="pd-task-cp" style="margin-bottom:8px;"></div>
      <input type="date" id="pd-task-due" style="
        width:100%;box-sizing:border-box;padding:.4rem .65rem;
        border:.5px solid #D1C9BE;border-radius:5px;font-size:13px;
        font-family:'Inter',sans-serif;outline:none;margin-bottom:8px;background:#fff;
      " />
      <div style="display:flex;gap:8px;">
        <button id="pd-task-save" style="
          padding:.35rem .85rem;background:#1C2B3A;color:#fff;border:none;
          border-radius:5px;font-size:12.5px;font-family:'Inter',sans-serif;cursor:pointer;font-weight:500;
        ">Add task</button>
        <button id="pd-task-cancel" style="
          padding:.35rem .85rem;background:none;color:#6B7280;
          border:.5px solid #D1C9BE;border-radius:5px;
          font-size:12.5px;font-family:'Inter',sans-serif;cursor:pointer;
        ">Cancel</button>
      </div>
    </div>
  `;
  el.appendChild(addArea);

  document.getElementById('pd-add-task-btn').addEventListener('click', () => {
    document.getElementById('pd-add-task-form').style.display = 'block';
    document.getElementById('pd-add-task-btn').style.display = 'none';
    _taskPicker = createContactPicker({
      container: document.getElementById('pd-task-cp'),
      placeholder: 'Assign to…',
      onSelect: () => {},
    });
    document.getElementById('pd-task-title').focus();
  });

  document.getElementById('pd-task-cancel').addEventListener('click', () => {
    document.getElementById('pd-add-task-form').style.display = 'none';
    document.getElementById('pd-add-task-btn').style.display = '';
    _taskPicker = null;
  });

  document.getElementById('pd-task-save').addEventListener('click', async () => {
    const title = document.getElementById('pd-task-title').value.trim();
    if (!title) { document.getElementById('pd-task-title').focus(); return; }
    const { data, error } = await sb.from('tasks').insert({
      title,
      project_id:  _projectId,
      assigned_to: _taskPicker?.getId() || null,
      due_date:    document.getElementById('pd-task-due').value || null,
      completed:   false,
    }).select().single();
    if (error) { alert('Failed to add task: ' + error.message); return; }
    _tasks.push(data);
    _taskPicker = null;
    const el = document.getElementById('pd-content');
    if (el) _renderTasks(el);
  });
}

// ── Members tab (multi-person assignees) ───────────────────────────────────

function _renderMembers(el) {
  _renderMembersList(el);
}

function _renderMembersList(el) {
  const people = (store.personnel || []);

  let listHtml = '';
  if (!_assigneeIds.length) {
    listHtml = `<div style="font-size:13px;color:#9CA3AF;font-style:italic;margin-bottom:1rem;">No members assigned yet.</div>`;
  } else {
    listHtml = _assigneeIds.map(id => {
      const name = _personnelName(id) || id;
      const p = people.find(x => x.id === id);
      return `
        <div style="display:flex;align-items:center;gap:10px;padding:.65rem 0;border-bottom:.5px solid #F0EDE8;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:14px;font-weight:500;color:#1C2B3A;">${name}</div>
            ${p?.title ? `<div style="font-size:12px;color:#6B7280;">${p.title}</div>` : ''}
          </div>
          <button data-remove-id="${id}" style="
            background:none;border:none;cursor:pointer;color:#D1D5DB;font-size:14px;
            padding:2px 4px;flex-shrink:0;line-height:1;
          " onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#D1D5DB'"
            title="Remove from project">✕</button>
        </div>`;
    }).join('');
  }

  el.innerHTML = `
    <div id="pd-member-list">${listHtml}</div>
    <div id="pd-member-add-area" style="margin-top:1rem;">
      <button id="pd-add-member-btn" style="
        font-size:13px;color:#8B1A2F;background:none;border:none;
        cursor:pointer;font-family:'Inter',sans-serif;padding:0;font-weight:500;
      ">+ Add member</button>
      <div id="pd-member-picker-wrap" style="display:none;margin-top:.75rem;background:#F8F7F4;border:.5px solid #E2DDD6;border-radius:8px;padding:.85rem .9rem;">
        <div style="font-size:12px;font-weight:600;color:#555;margin-bottom:8px;">Add member</div>
        <div id="pd-member-cp" style="margin-bottom:8px;"></div>
        <div style="display:flex;gap:8px;">
          <button id="pd-member-confirm" style="
            padding:.35rem .85rem;background:#1C2B3A;color:#fff;border:none;
            border-radius:5px;font-size:12.5px;font-family:'Inter',sans-serif;cursor:pointer;font-weight:500;
          ">Add</button>
          <button id="pd-member-cancel" style="
            padding:.35rem .85rem;background:none;color:#6B7280;
            border:.5px solid #D1C9BE;border-radius:5px;
            font-size:12.5px;font-family:'Inter',sans-serif;cursor:pointer;
          ">Cancel</button>
        </div>
      </div>
    </div>
  `;

  // Remove buttons
  el.querySelectorAll('[data-remove-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.removeId;
      _assigneeIds = _assigneeIds.filter(x => x !== id);
      await _saveAssignees();
      _renderMembersList(el);
    });
  });

  document.getElementById('pd-add-member-btn').addEventListener('click', () => {
    document.getElementById('pd-member-picker-wrap').style.display = 'block';
    document.getElementById('pd-add-member-btn').style.display = 'none';
    _memberPicker = createContactPicker({
      container: document.getElementById('pd-member-cp'),
      placeholder: 'Search person…',
      onSelect: () => {},
    });
  });

  document.getElementById('pd-member-cancel').addEventListener('click', () => {
    document.getElementById('pd-member-picker-wrap').style.display = 'none';
    document.getElementById('pd-add-member-btn').style.display = '';
    _memberPicker = null;
  });

  document.getElementById('pd-member-confirm').addEventListener('click', async () => {
    const person = _memberPicker?.getValue();
    if (!person) { alert('Please select a person.'); return; }
    if (_assigneeIds.includes(person.id)) { alert(`${person.name || 'This person'} is already assigned.`); return; }
    _assigneeIds.push(person.id);
    _memberPicker = null;
    await _saveAssignees();
    _renderMembersList(el);
  });
}

async function _saveAssignees() {
  const { error } = await sb.from('projects')
    .update({ assigned_to: _assigneeIds, updated_at: new Date().toISOString() })
    .eq('id', _projectId);
  if (error) console.error('[projectDashboard] assignee save:', error);
}

// ── Project (details) tab ─────────────────────────────────────────────────

function _renderProjectDetails(el) {
  if (!_project) return;

  el.innerHTML = `
    <div style="max-width:520px;">
      <div style="margin-bottom:.85rem;">
        <label style="font-size:11.5px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:4px;">Title</label>
        <input id="det-title" value="${_project.title || ''}" style="
          width:100%;box-sizing:border-box;padding:.45rem .7rem;
          border:.5px solid #D1C9BE;border-radius:6px;font-size:14px;
          font-family:'Inter',sans-serif;outline:none;background:#fff;
        " />
      </div>
      <div style="margin-bottom:.85rem;">
        <label style="font-size:11.5px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:4px;">Status</label>
        <select id="det-status" style="
          width:100%;padding:.45rem .7rem;border:.5px solid #D1C9BE;border-radius:6px;
          font-size:13.5px;font-family:'Inter',sans-serif;background:#fff;outline:none;
        ">
          ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}"${k === _project.status_code ? ' selected' : ''}>${v.label}</option>`).join('')}
        </select>
      </div>
      <div style="margin-bottom:.85rem;">
        <label style="font-size:11.5px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:4px;">Due date</label>
        <input type="date" id="det-due" value="${_project.due_date || ''}" style="
          width:100%;box-sizing:border-box;padding:.45rem .7rem;
          border:.5px solid #D1C9BE;border-radius:6px;font-size:13.5px;
          font-family:'Inter',sans-serif;background:#fff;outline:none;
        " />
      </div>
      <div style="margin-bottom:1.25rem;">
        <label style="font-size:11.5px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:4px;">Notes</label>
        <textarea id="det-notes" rows="4" style="
          width:100%;box-sizing:border-box;padding:.45rem .7rem;
          border:.5px solid #D1C9BE;border-radius:6px;font-size:13.5px;
          font-family:'Inter',sans-serif;background:#fff;outline:none;resize:vertical;
        ">${_project.notes || ''}</textarea>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
        <button id="det-save" style="
          padding:.45rem 1.1rem;background:#1C2B3A;color:#fff;border:none;
          border-radius:6px;font-size:13px;font-family:'Inter',sans-serif;
          cursor:pointer;font-weight:600;
        ">Save changes</button>
        <button id="det-delete" style="
          padding:.45rem 1rem;background:none;color:#8B1A2F;
          border:.5px solid #8B1A2F;border-radius:6px;
          font-size:13px;font-family:'Inter',sans-serif;cursor:pointer;
        ">Delete project</button>
      </div>
    </div>
  `;

  document.getElementById('det-save').addEventListener('click', _saveProjectDetails);
  document.getElementById('det-delete').addEventListener('click', _deleteProject);
}

async function _saveProjectDetails() {
  const title = document.getElementById('det-title').value.trim();
  if (!title) { document.getElementById('det-title').focus(); return; }
  const payload = {
    title,
    status_code: document.getElementById('det-status').value,
    due_date:    document.getElementById('det-due').value || null,
    notes:       document.getElementById('det-notes').value.trim() || null,
    updated_at:  new Date().toISOString(),
  };
  const { error } = await sb.from('projects').update(payload).eq('id', _projectId);
  if (error) { alert('Save failed: ' + error.message); return; }
  Object.assign(_project, payload);
  const container = document.getElementById('project-dashboard-root');
  if (container) _render(container);
  document.getElementById('topbar-title').textContent = title;
}

async function _deleteProject() {
  if (!confirm(`Delete "${_project.title}"? This cannot be undone.`)) return;
  const { error } = await sb.from('projects').delete().eq('id', _projectId);
  if (error) { alert('Delete failed: ' + error.message); return; }
  window.switchPanel('projects');
}
