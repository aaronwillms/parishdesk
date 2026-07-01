import { sb, deleteWithRetry } from '../supabase.js';
import { store } from '../store.js';
import { fmtDate, todayCST, logActivity } from '../utils.js';
import { createContactPicker } from '../ui/contactPicker.js';
import { notifyUsers, getUserIdsForTeam, getUserIdForPersonnel } from '../notifications.js';

// Phase 2b-2: the standalone Tasks panel (list / kanban board / filter bar / quick-add / drag)
// was RETIRED — the dashboard two-tab surface is the tasks home. This module now exists only as a
// FUNCTION LIBRARY for the shared task row + detail modal that teamDashboard.js reuses. The status
// model (statusOf / STATUS_META / BOARD_COLUMNS) is NOT vestigial: taskForm has a status dropdown
// and toggleTask writes status, both exercised by teamDashboard.

let _taskAssignedPicker = null;
let _newTaskTeamId = null;

const RECURRENCE_LABELS = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };

// Status meta (shared by taskRow's chip + the taskForm status dropdown).
const STATUS_META = {
  not_started: { label: 'Not Started', color: '#6A1B9A', bg: '#F5F3FF', dot: '#9CA3AF' },
  in_progress: { label: 'In Progress', color: '#1565C0', bg: '#EFF6FF', dot: '#1565C0' },
  blocked:     { label: 'Blocked',     color: '#8B1A2F', bg: '#FEF2F2', dot: '#8B1A2F' },
  complete:    { label: 'Complete',     color: '#2E7D32', bg: '#F0FDF4', dot: '#2E7D32' },
};
const BOARD_COLUMNS = ['not_started', 'in_progress', 'blocked', 'complete'];

// ── Data ───────────────────────────────────────────────────────────────────

export function invalidateTasks() {
  store.allTasks = [];
  store._taskScopeReady = undefined;
}

// Retained as a no-op refresh hook. The standalone panel was retired, so #tasks-list no longer
// exists; the shared write helpers (toggleTask/saveTask/deleteTask), used by teamDashboard, still
// call this — teamDashboard re-renders its own task tab on interaction (unchanged behaviour).
function renderTasks() {
  const el = document.getElementById('tasks-list');
  if (!el) return;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function personnelName(id) {
  return id ? ((store.personnel || []).find(p => p.id === id)?.name || null) : null;
}

function teamName(id) {
  return id ? ((store.teams || []).find(t => t.id === id)?.name || null) : null;
}

function statusOf(t) {
  const s = t.status || (t.completed ? 'complete' : 'not_started');
  return s === 'todo' ? 'not_started' : s; // legacy 'todo' → 'not_started'
}

function isOverdue(task) {
  if (!task.due_date || task.completed) return false;
  return task.due_date < todayCST();
}

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Deterministic colour from a name for the initials badge.
const _AV_COLORS = ['#1C2B3A', '#6A1B9A', '#1565C0', '#2E7D32', '#8B1A2F', '#B8860B', '#0F766E', '#7C3AED'];
function _miniAvatar(name, size = 22) {
  if (!name) return `<span style="width:${size}px;height:${size}px;flex-shrink:0;"></span>`;
  const parts = name.trim().split(/\s+/);
  const initials = ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const bg = _AV_COLORS[h % _AV_COLORS.length];
  return `<span title="${_esc(name)}" style="width:${size}px;height:${size}px;border-radius:50%;background:${bg};color:#fff;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;font-size:${Math.round(size * 0.42)}px;font-weight:600;letter-spacing:.02em;">${_esc(initials)}</span>`;
}

function statusChip(status) {
  const m = STATUS_META[status] || STATUS_META.not_started;
  return `<span style="font-size:10.5px;font-weight:600;color:${m.color};background:${m.bg};border-radius:20px;padding:2px 8px;display:inline-flex;align-items:center;gap:4px;"><span style="width:6px;height:6px;border-radius:50%;background:${m.dot};display:inline-block;"></span>${m.label}</span>`;
}

// ── Shared task row (used by teamDashboard) ──────────────────────────────────
// No drag affordance (the kanban board was retired); the row opens the detail modal and its
// checkbox toggles completion via the shared toggleTask.
export function taskRow(t) {
  const person = personnelName(t.assigned_to);
  const team   = teamName(t.team_id);
  const status = statusOf(t);

  const meta = [
    team ? `<span style="font-size:11px;color:#6B7280;display:inline-flex;align-items:center;gap:3px;"><i class="fa-solid fa-people-group" style="font-size:10px;"></i>${_esc(team)}</span>` : '',
    t.due_date && !t.completed ? `<span style="font-size:11px;color:${isOverdue(t) ? '#922B21' : '#6B7280'};">${fmtDate(t.due_date)}</span>` : '',
    t.recurring ? `<span style="font-size:11px;color:#6B7280;">🔁 ${RECURRENCE_LABELS[t.recurrence_pattern] || 'Recurring'}</span>` : '',
    !t.completed ? statusChip(status) : '',
    t.completed && t.completed_at ? `<span style="font-size:11px;color:#1E8449;">✓ ${fmtDate(t.completed_at.slice(0, 10))}</span>` : '',
  ].filter(Boolean).join('');

  return `<div class="task-row" id="task-row-${t.id}" style="display:flex;align-items:center;gap:9px;padding:.5rem 0;border-bottom:.5px solid var(--stone);" onclick="openTaskDetail('${t.id}')">
    <input type="checkbox" ${t.completed ? 'checked' : ''} onclick="event.stopPropagation()" onchange="toggleTask('${t.id}',this.checked)"
      style="width:16px;height:16px;flex-shrink:0;cursor:pointer;accent-color:var(--cardinal);" />
    ${_miniAvatar(person)}
    <div style="flex:1;min-width:0;">
      <div class="evt-title" style="${t.completed ? 'text-decoration:line-through;color:#9CA3AF;' : ''}">${_esc(t.title)}</div>
      ${meta ? `<div style="display:flex;flex-wrap:wrap;gap:7px;margin-top:3px;align-items:center;">${meta}</div>` : ''}
    </div>
    <button class="task-edit-btn" onclick="event.stopPropagation();openTaskDetail('${t.id}')" title="Edit task"><i class="fa-solid fa-pencil"></i></button>
  </div>`;
}

function _syncCompleted(payload, status) {
  if (status === 'complete') {
    payload.completed = true;
    payload.completed_at = payload.completed_at || new Date().toISOString();
  } else {
    payload.completed = false;
    payload.completed_at = null;
  }
}

// ── Toggle complete (checkbox) ───────────────────────────────────────────────

async function toggleTask(id, checked) {
  const status = checked ? 'complete' : 'not_started';
  const payload = {
    completed: checked,
    completed_at: checked ? new Date().toISOString() : null,
    status,
    updated_at: new Date().toISOString(),
  };
  const { error } = await sb.from('tasks').update(payload).eq('id', id);
  if (error) { console.error('[tasks] toggle failed:', error); return; }
  const t = (store.allTasks || []).find(x => x.id === id);
  if (t) Object.assign(t, payload);
  if (checked) {
    logActivity({ action: 'completed task', entityType: 'task', entityName: t?.title || 'Unknown', contextType: 'task', contextId: id });
    // Delegator-notify (Phase 1b): when the assignee completes a delegated task, notify the
    // delegator (created_by, an auth uid) — not the assignee. notifyUsers excludes the actor,
    // so a self-completed personal task fires nothing.
    if (t?.assigned_to && t.created_by) {
      const { data: { user: _me } } = await sb.auth.getUser();
      if (t.created_by !== _me?.id) {
        const who = store.currentUserProfile?.personnel?.name || 'Someone';
        notifyUsers([t.created_by], _me?.id, `${who} completed: ${t.title}`, 'success', 'tasks', id);
      }
    }
  }
  renderTasks();
}

// ── Detail modal ─────────────────────────────────────────────────────────────

function _commentsHtml(t) {
  const comments = Array.isArray(t.comments) ? t.comments : [];
  const rows = comments.length
    ? comments.map(c => `
        <div style="padding:.5rem 0;border-bottom:.5px solid var(--stone);">
          <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:2px;">
            <span style="font-size:12px;font-weight:600;color:#1C2B3A;">${_esc(c.author_name || 'Someone')}</span>
            <span style="font-size:10.5px;color:#9CA3AF;">${_esc((c.created_at || '').slice(0, 10))}</span>
          </div>
          <div style="font-size:13px;color:#374151;white-space:pre-wrap;word-break:break-word;">${_esc(c.body)}</div>
        </div>`).join('')
    : `<div style="font-size:12.5px;color:#9CA3AF;font-style:italic;padding:.25rem 0;">No notes yet.</div>`;
  return rows;
}

function taskForm(data) {
  const teams = store.teams || [];
  const status = data ? statusOf(data) : 'not_started';
  const createdLine = data?.created_at
    ? `<div style="font-size:11px;color:#9CA3AF;margin-top:1rem;">Created ${_esc(data.created_at.slice(0, 10))}${data.created_by === store.currentUserProfile?.user_id ? ' by you' : ''}</div>`
    : '';

  return `<div class="modal-title">${data ? 'Task' : 'Add task'}</div>
  <label>Title</label><input id="tf-title" value="${_esc(data?.title || '')}" placeholder="Task description" />
  <label>Description</label>
  <textarea id="tf-desc" rows="2" placeholder="Add more detail…" oninput="this.style.height='auto';this.style.height=this.scrollHeight+'px';">${_esc(data?.description || '')}</textarea>
  <label>Assigned to (optional)</label>
  <div id="tf-assigned-picker"></div>
  <div style="display:flex;gap:10px;flex-wrap:wrap;">
    <div style="flex:1;min-width:130px;">
      <label>Status</label>
      <select id="tf-status">
        ${BOARD_COLUMNS.map(s => `<option value="${s}"${s === status ? ' selected' : ''}>${STATUS_META[s].label}</option>`).join('')}
      </select>
    </div>
    <div style="flex:1;min-width:130px;">
      <label>Due date</label><input type="date" id="tf-due" value="${data?.due_date || ''}" />
    </div>
  </div>
  <label>Team (optional)</label>
  <select id="tf-team">
    <option value="">— None —</option>
    ${teams.map(t => `<option value="${t.id}"${t.id === data?.team_id ? ' selected' : ''}>${_esc(t.name)}</option>`).join('')}
  </select>
  <label>Visibility</label>
  <select id="tf-vis">
    <option value="personal"${(data?.visibility || 'personal') === 'personal' ? ' selected' : ''}>Personal</option>
    <option value="team"${data?.visibility === 'team' ? ' selected' : ''}>Team</option>
  </select>
  <div style="display:flex;align-items:center;gap:8px;margin:.5rem 0;">
    <input type="checkbox" id="tf-recurring" ${data?.recurring ? 'checked' : ''} onchange="toggleRecurUI()" style="width:15px;height:15px;accent-color:var(--cardinal);" />
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
  ${data ? `
  <label style="margin-top:.75rem;">Notes</label>
  <div id="tf-comments">${_commentsHtml(data)}</div>
  <div style="display:flex;gap:6px;margin-top:.5rem;">
    <input id="tf-comment" placeholder="Add a note…" autocomplete="off" style="flex:1;" onkeydown="if(event.key==='Enter'){event.preventDefault();appendTaskComment('${data.id}');}" />
    <button class="btn-secondary" style="padding:.4rem .8rem;font-size:12px;" onclick="appendTaskComment('${data.id}')">Add</button>
  </div>` : ''}
  ${createdLine}
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

export function openAddTask({ teamId = null } = {}) {
  _newTaskTeamId = teamId;
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

async function appendTaskComment(id) {
  const input = document.getElementById('tf-comment');
  const body = (input?.value || '').trim();
  if (!body) return;
  const t = (store.allTasks || []).find(x => x.id === id);
  if (!t) return;

  const comment = {
    id: (crypto?.randomUUID?.() || String(Date.now())),
    author_id: store.currentUserProfile?.user_id || null,
    author_name: store.currentUserProfile?.personnel?.name || 'You',
    body,
    created_at: new Date().toISOString(),
  };
  const comments = [...(Array.isArray(t.comments) ? t.comments : []), comment];

  const { error } = await sb.from('tasks').update({ comments, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) { alert('Could not add note: ' + error.message); return; }
  t.comments = comments;

  // re-render only the comments block + clear input
  const box = document.getElementById('tf-comments');
  if (box) box.innerHTML = _commentsHtml(t);
  if (input) { input.value = ''; input.focus(); }
}

async function saveTask(id) {
  const title = document.getElementById('tf-title').value.trim();
  if (!title) { alert('Title is required.'); return; }
  const recurring = !!document.getElementById('tf-recurring')?.checked;
  const status = document.getElementById('tf-status')?.value || 'not_started';

  const payload = {
    title,
    description:        document.getElementById('tf-desc')?.value.trim() || null,
    assigned_to:        _taskAssignedPicker?.getId() || null,
    team_id:            _newTaskTeamId || document.getElementById('tf-team').value || null,
    due_date:           document.getElementById('tf-due').value || null,
    visibility:         document.getElementById('tf-vis').value || 'personal',
    status,
    recurring,
    recurrence_pattern: recurring ? document.getElementById('tf-recur').value : null,
    updated_at:         new Date().toISOString(),
  };
  _syncCompleted(payload, status);

  if (id) {
    const { error } = await sb.from('tasks').update(payload).eq('id', id);
    if (error) { alert('Save failed: ' + error.message); return; }
    const prior = (store.allTasks || []).find(x => x.id === id);
    const { data: { user: _me } } = await sb.auth.getUser();
    if (payload.assigned_to && payload.assigned_to !== prior?.assigned_to) {
      const uid = await getUserIdForPersonnel(payload.assigned_to);
      if (uid) notifyUsers([uid], _me?.id, `You've been assigned to task: ${payload.title}`, 'info', 'tasks', id);
    }
    if (prior) Object.assign(prior, payload);
    logActivity({ action: 'updated task', entityType: 'task', entityName: payload.title, contextType: 'task', contextId: id });
    window.flashSavedThen(() => { closeModal(); renderTasks(); });
  } else {
    const { data: { user } } = await sb.auth.getUser();
    payload.created_by = user?.id || null;
    const { data: newTask, error } = await sb.from('tasks').insert(payload).select().single();
    if (error) { alert('Save failed: ' + error.message); return; }
    if (!store.allTasks) store.allTasks = [];
    store.allTasks.push(newTask);
    logActivity({ action: 'created task', entityType: 'task', entityName: newTask.title, contextType: 'task', contextId: newTask.id });
    if (newTask.team_id) {
      const team = (store.teams || []).find(t => t.id === newTask.team_id);
      if (team?.name?.toLowerCase().includes('parish staff')) {
        const _uids = await getUserIdsForTeam(newTask.team_id);
        notifyUsers(_uids, user?.id, `New Parish Staff task: ${newTask.title}`, 'info', 'tasks', newTask.id);
      }
    }
    if (newTask.assigned_to) {
      const uid = await getUserIdForPersonnel(newTask.assigned_to);
      if (uid) notifyUsers([uid], user?.id, `You've been assigned to task: ${newTask.title}`, 'info', 'tasks', newTask.id);
    }
    _newTaskTeamId = null;
    window.flashSavedThen(() => { closeModal(); renderTasks(); });
  }
}

async function deleteTask(id) {
  const t = (store.allTasks || []).find(x => x.id === id);
  if (!confirm(`Delete "${t?.title}"?`)) return;
  const { error } = await deleteWithRetry(() => sb.from('tasks').delete().eq('id', id));
  if (error) { alert('Delete failed: ' + error.message); return; }
  logActivity({ action: 'deleted task', entityType: 'task', entityName: t?.title || 'Unknown', contextType: 'task', contextId: id });
  store.allTasks = (store.allTasks || []).filter(x => x.id !== id);
  closeModal();
  renderTasks();
}

Object.assign(window, {
  toggleTask, openAddTask, openTaskDetail, saveTask, deleteTask, toggleRecurUI, appendTaskComment,
});
