import { sb } from '../supabase.js';
import { store } from '../store.js';
import { fmtDate, todayCST } from '../utils.js';
import { createContactPicker } from '../ui/contactPicker.js';

// ── Status config ──────────────────────────────────────────────────────────

const STATUS = {
  in_progress:  { label: 'In Progress',  color: '#7A5C00', bg: '#FDF3D0' },
  blocked:      { label: 'Blocked',      color: '#7A1020', bg: '#FDEAED' },
  not_started:  { label: 'Not Started',  color: '#4B5563', bg: '#F3F4F6' },
  complete:     { label: 'Complete',     color: '#F5F1EB', bg: '#1C2B3A' },
};

// ── Module state ───────────────────────────────────────────────────────────

let _projectId   = null;
let _project     = null;
let _tasks       = [];
let _activeTab   = 'tasks';
let _taskPicker  = null;
let _detailPicker = null;

// ── Public entry point ─────────────────────────────────────────────────────

export async function renderProjectDashboard(container, projectId) {
  _projectId  = projectId;
  _activeTab  = 'tasks';
  _taskPicker = null;
  _detailPicker = null;
  container.innerHTML = '<div style="padding:2rem;text-align:center;color:#9CA3AF;">Loading…</div>';
  await _load();
  _render(container);
}

// ── Data ───────────────────────────────────────────────────────────────────

async function _load() {
  const [projRes, tasksRes] = await Promise.all([
    sb.from('projects').select('*').eq('id', _projectId).single(),
    sb.from('tasks')
      .select('*')
      .eq('project_id', _projectId)
      .order('created_at'),
  ]);
  if (projRes.error)  console.error('[projectDashboard] project:', projRes.error);
  if (tasksRes.error) console.error('[projectDashboard] tasks:', tasksRes.error);
  _project = projRes.data || null;
  _tasks   = tasksRes.data || [];
}

// ── Render shell ───────────────────────────────────────────────────────────

const TABS = [
  { key: 'tasks',       label: 'Tasks' },
  { key: 'discussions', label: 'Discussions' },
  { key: 'details',     label: 'Details' },
];

function _statusBadge(code) {
  const st = STATUS[code] || STATUS.not_started;
  return `<span style="font-size:11px;font-weight:700;background:${st.bg};color:${st.color};border-radius:20px;padding:2px 10px;">${st.label}</span>`;
}

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
      _activeTab = btn.dataset.tab;
      document.querySelectorAll('.pd-tab').forEach(b => {
        b.style.color = '#9CA3AF';
        b.style.borderBottomColor = 'transparent';
      });
      btn.style.color = '#1C2B3A';
      btn.style.borderBottomColor = '#8B1A2F';
      _taskPicker = null;
      _detailPicker = null;
      _renderTab();
    });
  });

  _renderTab();
}

function _renderTab() {
  const el = document.getElementById('pd-content');
  if (!el) return;
  if (_activeTab === 'tasks')       _renderTasks(el);
  else if (_activeTab === 'details') _renderDetails(el);
  else                               _renderStub(el, _activeTab);
}

// ── Tasks tab ──────────────────────────────────────────────────────────────

function _personnelName(id) {
  if (!id) return null;
  return (store.personnel || []).find(p => p.id === id)?.name || null;
}

function _renderTasks(el) {
  const active    = _tasks.filter(t => !t.completed);
  const completed = _tasks.filter(t => t.completed);

  let html = '';

  if (!_tasks.length) {
    html = `<div style="font-size:13px;color:#9CA3AF;font-style:italic;margin-bottom:1rem;">No tasks yet.</div>`;
  } else {
    if (active.length) {
      html += active.map(t => _taskRow(t)).join('');
    }
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
      const taskId = cb.dataset.taskId;
      const checked = cb.checked;
      const { error } = await sb.from('tasks').update({
        completed: checked,
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
          border-radius:5px;font-size:12.5px;font-family:'Inter',sans-serif;
          cursor:pointer;font-weight:500;
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
    const payload = {
      title,
      project_id:  _projectId,
      assigned_to: _taskPicker?.getId() || null,
      due_date:    document.getElementById('pd-task-due').value || null,
      completed:   false,
    };
    const { data, error } = await sb.from('tasks').insert(payload).select().single();
    if (error) { alert('Failed to add task: ' + error.message); return; }
    _tasks.push(data);
    _taskPicker = null;
    const el = document.getElementById('pd-content');
    if (el) _renderTasks(el);
  });
}

// ── Discussions stub ───────────────────────────────────────────────────────

function _renderStub(el, tab) {
  const icons  = { discussions: '💬' };
  const labels = { discussions: 'Discussions' };
  el.innerHTML = `
    <div style="text-align:center;padding:3.5rem 1rem;color:#9CA3AF;">
      <div style="font-size:36px;margin-bottom:.75rem;">${icons[tab] || '🔧'}</div>
      <div style="font-family:'Cormorant Garamond',Georgia,serif;font-size:20px;font-weight:600;color:#C9A84C;margin-bottom:.4rem;">${labels[tab] || tab}</div>
      <div style="font-size:13px;">Coming soon</div>
    </div>`;
}

// ── Details tab ────────────────────────────────────────────────────────────

function _renderDetails(el) {
  if (!_project) return;

  const teams = store.teams || [];
  const teamOpts = `<option value="">— None —</option>` +
    teams.map(t => `<option value="${t.id}"${t.id === _project.team_id ? ' selected' : ''}>${t.name}</option>`).join('');

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
        <label style="font-size:11.5px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:4px;">Assigned to</label>
        <div id="det-assignee-cp"></div>
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

  // Init contact picker with current value
  _detailPicker = createContactPicker({
    container: document.getElementById('det-assignee-cp'),
    placeholder: 'Search person…',
    initialValue: _project.assigned_to || undefined,
    onSelect: () => {},
  });

  document.getElementById('det-save').addEventListener('click', _saveDetails);
  document.getElementById('det-delete').addEventListener('click', _deleteProject);
}

async function _saveDetails() {
  const title = document.getElementById('det-title').value.trim();
  if (!title) { document.getElementById('det-title').focus(); return; }
  const payload = {
    title,
    status_code: document.getElementById('det-status').value,
    assigned_to: _detailPicker?.getId() || null,
    due_date:    document.getElementById('det-due').value || null,
    notes:       document.getElementById('det-notes').value.trim() || null,
    updated_at:  new Date().toISOString(),
  };
  const { error } = await sb.from('projects').update(payload).eq('id', _projectId);
  if (error) { alert('Save failed: ' + error.message); return; }
  Object.assign(_project, payload);
  // Refresh header
  const container = document.getElementById('project-dashboard-root');
  if (container) _render(container);
  // Also refresh topbar title
  document.getElementById('topbar-title').textContent = title;
}

async function _deleteProject() {
  if (!confirm(`Delete "${_project.title}"? This cannot be undone.`)) return;
  const { error } = await sb.from('projects').delete().eq('id', _projectId);
  if (error) { alert('Delete failed: ' + error.message); return; }
  window.switchPanel('projects');
}
