import { sb } from '../supabase.js';
import { store } from '../store.js';
import { fmtDate, todayCST, logActivity } from '../utils.js';
import { createContactPicker } from '../ui/contactPicker.js';
import { getUserScope, isVisible, scopeNotice } from '../ui/userScope.js';

let _taskAssignedPicker = null;

const RECURRENCE_LABELS = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };

let activeFilter = 'all';

// ── Data ───────────────────────────────────────────────────────────────────

export function invalidateTasks() {
  store.allTasks = [];
  store._taskScopeReady = undefined;
}

export async function loadTasks() {
  // Use cached store data if scope is already resolved
  if (store.allTasks?.length > 0 && store._taskScopeReady !== undefined) {
    renderTasks();
    return;
  }

  const scope = await getUserScope();

  const { data, error } = await sb
    .from('tasks')
    .select('*')
    .order('due_date', { nullsFirst: false })
    .order('sort_order', { nullsFirst: false })
    .order('created_at');
  if (error) { console.error('[tasks]', error); return; }

  store.allTasks = (data || []).filter(t => isVisible(t, scope));
  store._taskScopeReady = scope.ready;
  renderTasks();
}

// ── Helpers ────────────────────────────────────────────────────────────────

function personnelName(id) {
  return id ? ((store.personnel || []).find(p => p.id === id)?.name || null) : null;
}

function teamName(id) {
  return id ? ((store.teams || []).find(t => t.id === id)?.name || null) : null;
}

function isOverdue(task) {
  if (!task.due_date || task.completed) return false;
  return task.due_date < todayCST();
}

function isToday(task) {
  if (!task.due_date || task.completed) return false;
  return task.due_date === todayCST();
}

// ── Render ─────────────────────────────────────────────────────────────────

export function renderTasks() {
  const el = document.getElementById('tasks-list');
  if (!el) return;

  // Update filter button styles
  document.querySelectorAll('.task-filter-btn').forEach(b => {
    b.classList.toggle('btn-primary', b.dataset.filter === activeFilter);
    b.classList.toggle('btn-secondary', b.dataset.filter !== activeFilter);
  });

  // Update stats
  const today = todayCST();
  const open = (store.allTasks || []).filter(t => !t.completed);
  const el_total   = document.getElementById('tstat-open');
  const el_today   = document.getElementById('tstat-today');
  const el_overdue = document.getElementById('tstat-overdue');
  if (el_total)   el_total.textContent   = open.length;
  if (el_today)   el_today.textContent   = open.filter(t => t.due_date === today).length;
  if (el_overdue) el_overdue.textContent = open.filter(t => t.due_date && t.due_date < today).length;

  let filtered = store.allTasks || [];
  if (activeFilter === 'complete') {
    filtered = filtered.filter(t => t.completed);
  } else {
    filtered = filtered.filter(t => !t.completed);
    if (activeFilter === 'mine') {
      // "mine" = no team, or personal
      filtered = filtered.filter(t => !t.team_id || t.visibility === 'personal');
    } else if (activeFilter === 'team') {
      filtered = filtered.filter(t => !!t.team_id);
    } else if (activeFilter === 'personal') {
      filtered = filtered.filter(t => t.visibility === 'personal');
    }
  }

  const notice = store._taskScopeReady === false ? scopeNotice() : '';

  if (!filtered.length) {
    el.innerHTML = notice + '<div style="font-size:13px;color:#6B7280;padding:.5rem 0;">No tasks.</div>';
    return;
  }

  const groups = {
    overdue:  { label: 'Overdue',  color: '#922B21', items: [] },
    today:    { label: 'Today',    color: '#1B4F72', items: [] },
    upcoming: { label: 'Upcoming', color: '#6B7280', items: [] },
    nodate:   { label: 'No date',  color: '#9CA3AF', items: [] },
    complete: { label: 'Complete', color: '#1E8449', items: [] },
  };

  filtered.forEach(t => {
    if (t.completed) { groups.complete.items.push(t); return; }
    if (isOverdue(t))       groups.overdue.items.push(t);
    else if (isToday(t))    groups.today.items.push(t);
    else if (t.due_date)    groups.upcoming.items.push(t);
    else                    groups.nodate.items.push(t);
  });

  let html = '';
  Object.values(groups).forEach(g => {
    if (!g.items.length) return;
    html += `<div style="margin-bottom:1.25rem;">
      <div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:${g.color};text-transform:uppercase;margin-bottom:.5rem;">${g.label}</div>`;
    g.items.forEach(t => { html += taskRow(t); });
    html += `</div>`;
  });
  el.innerHTML = notice + html;
}

function taskRow(t) {
  const person = personnelName(t.assigned_to);
  const team   = teamName(t.team_id);
  const chips = [
    person ? `<span style="font-size:11px;color:#6B7280;">👤 ${person}</span>` : '',
    team   ? `<span style="font-size:11px;color:#6B7280;">🏛 ${team}</span>` : '',
    t.due_date && !t.completed ? `<span style="font-size:11px;color:#6B7280;">📅 ${fmtDate(t.due_date)}</span>` : '',
    t.recurring ? `<span style="font-size:11px;color:#6B7280;">🔁 ${RECURRENCE_LABELS[t.recurrence_pattern] || 'Recurring'}</span>` : '',
    t.completed && t.completed_at ? `<span style="font-size:11px;color:#1E8449;">✓ ${fmtDate(t.completed_at.slice(0,10))}</span>` : '',
  ].filter(Boolean).join('');

  return `<div class="task-row" id="task-row-${t.id}" style="display:flex;align-items:center;gap:10px;border-bottom:.5px solid var(--stone);" onclick="openTaskDetail('${t.id}')">
    <input type="checkbox" ${t.completed ? 'checked' : ''} onclick="event.stopPropagation()" onchange="toggleTask('${t.id}',this.checked)"
      style="width:16px;height:16px;flex-shrink:0;cursor:pointer;accent-color:var(--cardinal);" />
    <div style="flex:1;min-width:0;">
      <div class="evt-title" style="${t.completed ? 'text-decoration:line-through;color:#9CA3AF;' : ''}">${t.title}</div>
      ${chips ? `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:3px;">${chips}</div>` : ''}
      ${t.notes ? `<div style="font-size:12px;color:#9CA3AF;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${t.notes}</div>` : ''}
    </div>
    <button class="task-edit-btn" onclick="event.stopPropagation();openTaskDetail('${t.id}')" title="Edit task"><i class="fa-solid fa-pencil"></i></button>
  </div>`;
}

// ── Interactions ───────────────────────────────────────────────────────────

async function toggleTask(id, checked) {
  const payload = {
    completed:    checked,
    completed_at: checked ? new Date().toISOString() : null,
    updated_at:   new Date().toISOString(),
  };
  const { error } = await sb.from('tasks').update(payload).eq('id', id);
  if (error) { console.error('[tasks] toggle failed:', error); return; }
  const t = (store.allTasks || []).find(x => x.id === id);
  if (t) Object.assign(t, payload);
  if (checked) logActivity({ action: 'completed task', entityType: 'task', entityName: t?.title || 'Unknown', contextType: 'task', contextId: id });
  renderTasks();
}

function setTaskFilter(f) {
  activeFilter = f;
  renderTasks();
}

// ── Modal ──────────────────────────────────────────────────────────────────

function taskForm(data) {
  const teams = store.teams || [];

  return `<div class="modal-title">${data ? 'Edit task' : 'Add task'}</div>
  <label>Title</label><input id="tf-title" value="${data?.title || ''}" placeholder="Task description" />
  <label>Assigned to (optional)</label>
  <div id="tf-assigned-picker"></div>
  <label>Team (optional)</label>
  <select id="tf-team">
    <option value="">— None —</option>
    ${teams.map(t => `<option value="${t.id}"${t.id === data?.team_id ? ' selected' : ''}>${t.name}</option>`).join('')}
  </select>
  <label>Due date</label><input type="date" id="tf-due" value="${data?.due_date || ''}" />
  <label>Visibility</label>
  <select id="tf-vis">
    <option value="personal"${(data?.visibility || 'personal') === 'personal' ? ' selected' : ''}>Personal</option>
    <option value="team"${data?.visibility === 'team' ? ' selected' : ''}>Team</option>
  </select>
  <div style="display:flex;align-items:center;gap:8px;margin:.5rem 0;">
    <input type="checkbox" id="tf-recurring" ${data?.recurring ? 'checked' : ''} onchange="toggleRecurUI()"
      style="width:15px;height:15px;accent-color:var(--cardinal);" />
    <label for="tf-recurring" style="margin:0;cursor:pointer;">Recurring</label>
  </div>
  <div id="recur-wrap" style="display:${data?.recurring ? 'block' : 'none'}">
    <label>Recurrence</label>
    <select id="tf-recur">
      <option value="daily"${data?.recurrence_pattern === 'daily' ? ' selected' : ''}>Daily</option>
      <option value="weekly"${data?.recurrence_pattern === 'weekly' ? ' selected' : ''}>Weekly</option>
      <option value="monthly"${data?.recurrence_pattern === 'monthly' ? ' selected' : ''}>Monthly</option>
    </select>
  </div>
  <label>Notes</label><textarea id="tf-notes" rows="2">${data?.notes || ''}</textarea>
  <div class="modal-actions" style="justify-content:space-between;">
    ${data ? `<button class="btn-delete" onclick="deleteTask('${data.id}')">Delete</button>` : '<span></span>'}
    <div style="display:flex;gap:8px;">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" onclick="saveTask(${data ? `'${data.id}'` : null})">Save</button>
    </div>
  </div>`;
}

function toggleRecurUI() {
  const el = document.getElementById('recur-wrap');
  if (el) el.style.display = document.getElementById('tf-recurring')?.checked ? 'block' : 'none';
}

function initTaskPicker(assignedToId) {
  if (_taskAssignedPicker) { _taskAssignedPicker.destroy(); _taskAssignedPicker = null; }
  const container = document.getElementById('tf-assigned-picker');
  if (!container) return;
  _taskAssignedPicker = createContactPicker({
    container,
    placeholder: 'Search by name…',
    onSelect: () => {},
    initialValue: assignedToId || null,
  });
}

function openAddTask() {
  document.getElementById('modal-content').innerHTML = taskForm(null);
  document.getElementById('modal-overlay').classList.add('open');
  initTaskPicker(null);
}

function openTaskDetail(id) {
  const t = (store.allTasks || []).find(x => x.id === id);
  if (!t) return;
  document.getElementById('modal-content').innerHTML = taskForm(t);
  document.getElementById('modal-overlay').classList.add('open');
  initTaskPicker(t.assigned_to);
}

async function saveTask(id) {
  const title = document.getElementById('tf-title').value.trim();
  if (!title) { alert('Title is required.'); return; }
  const recurring = !!document.getElementById('tf-recurring')?.checked;
  const payload = {
    title,
    assigned_to:        _taskAssignedPicker?.getId() || null,
    team_id:            document.getElementById('tf-team').value      || null,
    due_date:           document.getElementById('tf-due').value       || null,
    visibility:         document.getElementById('tf-vis').value       || 'personal',
    recurring,
    recurrence_pattern: recurring ? document.getElementById('tf-recur').value : null,
    notes:              document.getElementById('tf-notes').value.trim() || null,
    updated_at:         new Date().toISOString(),
  };

  if (id) {
    const { error } = await sb.from('tasks').update(payload).eq('id', id);
    if (error) { alert('Save failed: ' + error.message); return; }
    const t = (store.allTasks || []).find(x => x.id === id);
    if (t) Object.assign(t, payload);
    logActivity({ action: 'updated task', entityType: 'task', entityName: payload.title, contextType: 'task', contextId: id });
    closeModal();
    renderTasks();
  } else {
    const { data: { user } } = await sb.auth.getUser();
    payload.created_by = user?.id || null;
    const { data: newTask, error } = await sb.from('tasks').insert(payload).select().single();
    if (error) { alert('Save failed: ' + error.message); return; }
    if (!store.allTasks) store.allTasks = [];
    store.allTasks.push(newTask);
    logActivity({ action: 'created task', entityType: 'task', entityName: newTask.title, contextType: 'task', contextId: newTask.id });
    closeModal();
    renderTasks();
  }
}

async function deleteTask(id) {
  const t = (store.allTasks || []).find(x => x.id === id);
  if (!confirm(`Delete "${t?.title}"?`)) return;
  const { error } = await sb.from('tasks').delete().eq('id', id);
  if (error) { alert('Delete failed: ' + error.message); return; }
  logActivity({ action: 'deleted task', entityType: 'task', entityName: t?.title || 'Unknown' });
  store.allTasks = (store.allTasks || []).filter(x => x.id !== id);
  closeModal();
  renderTasks();
}

Object.assign(window, {
  toggleTask, setTaskFilter, openAddTask, openTaskDetail, saveTask, deleteTask, toggleRecurUI, renderTasks,
});
