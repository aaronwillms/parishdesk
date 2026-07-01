import { sb, deleteWithRetry } from '../supabase.js';
import { store } from '../store.js';
import { fmtDate, todayCST, logActivity } from '../utils.js';
import { createContactPicker } from '../ui/contactPicker.js';
import { getUserScope, isVisible, scopeNotice } from '../ui/userScope.js';
import { notifyUsers, getUserIdsForTeam, getUserIdForPersonnel } from '../notifications.js';

let _taskAssignedPicker = null;
let _newTaskTeamId = null;

const RECURRENCE_LABELS = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };

// Kanban status meta. Pastel bg/colors match the project STATUS palette and the
// existing dark-mode overrides in main.css.
const STATUS_META = {
  not_started: { label: 'Not Started', color: '#6A1B9A', bg: '#F5F3FF', dot: '#9CA3AF' },
  in_progress: { label: 'In Progress', color: '#1565C0', bg: '#EFF6FF', dot: '#1565C0' },
  blocked:     { label: 'Blocked',     color: '#8B1A2F', bg: '#FEF2F2', dot: '#8B1A2F' },
  complete:    { label: 'Complete',    color: '#2E7D32', bg: '#F0FDF4', dot: '#2E7D32' },
};
const BOARD_COLUMNS = ['not_started', 'in_progress', 'blocked', 'complete'];

let activeFilter    = 'all';
let _taskSearch     = '';
let _taskTeamFilter = null;   // null = all
let _taskView       = (() => { try { return localStorage.getItem('pd_taskView') || 'board'; } catch (_) { return 'board'; } })(); // 'list' | 'board'
let _showCompleted  = false;
let _dragId         = null;   // task id being dragged

function _isMobile() { return window.innerWidth < 768; }

// ── Data ───────────────────────────────────────────────────────────────────

export function invalidateTasks() {
  store.allTasks = [];
  store._taskScopeReady = undefined;
}

export async function loadTasks() {
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

function statusOf(t) {
  const s = t.status || (t.completed ? 'complete' : 'not_started');
  return s === 'todo' ? 'not_started' : s; // legacy 'todo' → 'not_started'
}

function isOverdue(task) {
  if (!task.due_date || task.completed) return false;
  return task.due_date < todayCST();
}

function isToday(task) {
  if (!task.due_date || task.completed) return false;
  return task.due_date === todayCST();
}

// Returns the list-view due-date bucket key for an open task.
function dueBucket(t) {
  if (isOverdue(t)) return 'overdue';
  if (isToday(t))   return 'today';
  if (!t.due_date)  return 'nodate';
  // within 7 days → week; else later
  const today = todayCST();
  const d = new Date(t.due_date + 'T00:00:00');
  const diff = Math.round((d - new Date(today + 'T00:00:00')) / 86400000);
  return diff <= 7 ? 'week' : 'later';
}

const LIST_GROUPS = {
  overdue: { label: 'Overdue',       color: '#922B21' },
  today:   { label: 'Due Today',     color: '#B8860B' },
  week:    { label: 'Due This Week', color: '#1B4F72' },
  later:   { label: 'Due Later',     color: '#6B7280' },
  nodate:  { label: 'No Due Date',   color: '#9CA3AF' },
};

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

// ── Filtering ────────────────────────────────────────────────────────────────

function _applyFilters(list) {
  let filtered = list || [];
  if (_taskTeamFilter) filtered = filtered.filter(t => t.team_id === _taskTeamFilter);
  if (_taskSearch) {
    const q = _taskSearch.toLowerCase();
    filtered = filtered.filter(t =>
      t.title?.toLowerCase().includes(q) || t.description?.toLowerCase().includes(q));
  }
  // status pills (mine/team/personal) only affect open tasks
  if (activeFilter === 'mine')     filtered = filtered.filter(t => !t.team_id || t.visibility === 'personal');
  else if (activeFilter === 'team')     filtered = filtered.filter(t => !!t.team_id);
  else if (activeFilter === 'personal') filtered = filtered.filter(t => t.visibility === 'personal');
  return filtered;
}

// ── Filter / header bar ──────────────────────────────────────────────────────

function _pill(label, active, onClick) {
  return `<button class="task-filter-btn" style="
    padding:.26rem .72rem;font-size:12px;font-family:'Inter',sans-serif;font-weight:500;
    border-radius:20px;border:.5px solid ${active ? '#C9A84C' : '#D1C9BE'};
    background:${active ? '#C9A84C' : '#fff'};color:${active ? '#fff' : '#1C2B3A'};
    cursor:pointer;white-space:nowrap;" onclick="${onClick}">${label}</button>`;
}

function _renderTaskFilterBar() {
  const bar = document.getElementById('task-filter-bar');
  if (!bar) return;

  const allTasks = store.allTasks || [];
  const openCount = allTasks.filter(t => !t.completed).length;
  const teamIds  = [...new Set(allTasks.map(t => t.team_id).filter(Boolean))];
  const teams    = (store.teams || []).filter(t => teamIds.includes(t.id));

  const statusPills = [
    { key: 'all', label: 'All' }, { key: 'mine', label: 'Mine' },
    { key: 'team', label: 'Team' }, { key: 'personal', label: 'Personal' },
  ].map(({ key, label }) => _pill(label, key === activeFilter, `window._taskSetFilter('${key}')`)).join('');

  const teamRow = teams.length ? `
    <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:.6rem;">
      ${_pill('All Teams', !_taskTeamFilter, 'window._taskTeamFilter(null)')}
      ${teams.map(t => _pill(_esc(t.name), _taskTeamFilter === t.id, `window._taskTeamFilter('${t.id}')`)).join('')}
    </div>` : '';

  const viewBtn = (key, icon, label) => `<button onclick="window._taskSetView('${key}')" style="
    padding:.3rem .8rem;font-size:12px;font-weight:600;font-family:'Inter',sans-serif;border:none;cursor:pointer;
    background:${_taskView === key ? '#1C2B3A' : 'transparent'};color:${_taskView === key ? '#fff' : '#6B7280'};
    display:inline-flex;align-items:center;gap:5px;"><i class="fa-solid ${icon}"></i>${label}</button>`;

  bar.innerHTML = `
    <div style="margin-bottom:1rem;">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:.7rem;">
        <h2 style="font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:600;color:#1C2B3A;margin:0;">My Tasks</h2>
        <span class="task-count-badge" style="background:#1C2B3A;color:#fff;border-radius:20px;font-size:11px;font-weight:600;padding:2px 9px;">${openCount}</span>
        <div style="flex:1;"></div>
        <div class="task-view-toggle" style="display:inline-flex;border:.5px solid #D1C9BE;border-radius:7px;overflow:hidden;">
          ${viewBtn('list', 'fa-list', 'List')}${viewBtn('board', 'fa-table-columns', 'Board')}
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:.6rem;">
        <button class="btn-primary" onclick="openAddTask()">+ New task</button>
        <div style="position:relative;flex:1;min-width:160px;max-width:260px;">
          <i class="fa-solid fa-magnifying-glass" style="position:absolute;left:9px;top:50%;transform:translateY(-50%);color:#9CA3AF;font-size:11px;pointer-events:none;"></i>
          <input id="task-search-input" placeholder="Search tasks…" autocomplete="off" value="${_taskSearch.replace(/"/g, '&quot;')}" style="
            width:100%;box-sizing:border-box;padding:.38rem .75rem .38rem 2rem;
            border:.5px solid #D1C9BE;border-radius:6px;font-size:13px;
            font-family:'Inter',sans-serif;outline:none;background:#fff;" />
          <button id="task-search-clear" style="display:${_taskSearch ? '' : 'none'};position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:#9CA3AF;font-size:13px;padding:0;line-height:1;">✕</button>
        </div>
      </div>
      <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:${teams.length ? '.6rem' : '0'};">${statusPills}</div>
      ${teamRow}
    </div>`;

  bar.querySelector('#task-search-input')?.addEventListener('input', e => {
    _taskSearch = e.target.value;
    bar.querySelector('#task-search-clear').style.display = _taskSearch ? '' : 'none';
    renderTasks();
  });
  bar.querySelector('#task-search-clear')?.addEventListener('click', () => {
    _taskSearch = '';
    renderTasks();
  });
}

window._taskTeamFilter = (teamId) => { _taskTeamFilter = teamId; renderTasks(); };
window._taskSetFilter  = (f)      => { activeFilter = f; renderTasks(); };
window._taskSetView    = (v)      => { _taskView = v; try { localStorage.setItem('pd_taskView', v); } catch (_) {} renderTasks(); };

// ── Top-level render ─────────────────────────────────────────────────────────

export function renderTasks() {
  _renderTaskFilterBar();

  const el = document.getElementById('tasks-list');
  if (!el) return;

  // Stats
  const today = todayCST();
  const open = (store.allTasks || []).filter(t => !t.completed);
  const set = (id, v) => { const n = document.getElementById(id); if (n) n.textContent = v; };
  set('tstat-open', open.length);
  set('tstat-today', open.filter(t => t.due_date === today).length);
  set('tstat-overdue', open.filter(t => t.due_date && t.due_date < today).length);

  const notice = store._taskScopeReady === false ? scopeNotice() : '';

  if (_taskView === 'board') el.innerHTML = notice + _boardHtml();
  else                       el.innerHTML = notice + _listHtml();

  _wireQuickAdds(el);
}

// ── List view ────────────────────────────────────────────────────────────────

function _listHtml() {
  const filtered = _applyFilters(store.allTasks || []);
  const open = filtered.filter(t => !t.completed);
  const done = filtered.filter(t => t.completed);

  const buckets = { overdue: [], today: [], week: [], later: [], nodate: [] };
  open.forEach(t => buckets[dueBucket(t)].push(t));

  let html = '';
  Object.entries(LIST_GROUPS).forEach(([key, g]) => {
    const items = buckets[key];
    html += `<div class="task-group" data-group="${key}" style="margin-bottom:1.1rem;">
      <div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:${g.color};text-transform:uppercase;margin-bottom:.4rem;">${g.label}${items.length ? ` <span style="color:#B0A090;font-weight:600;">${items.length}</span>` : ''}</div>
      ${_quickAddRow('list', key)}
      <div class="task-droplist" data-group="${key}">${items.map(t => taskRow(t, { draggable: true, group: key })).join('')}</div>
    </div>`;
  });

  // Completed (collapsed)
  if (done.length) {
    html += `<div style="margin-top:1.25rem;border-top:.5px solid var(--stone);padding-top:.75rem;">
      <button onclick="window._taskToggleCompleted()" style="background:none;border:none;cursor:pointer;font-size:11px;font-weight:700;letter-spacing:.06em;color:#1E8449;text-transform:uppercase;padding:0;display:inline-flex;align-items:center;gap:6px;">
        <i class="fa-solid fa-chevron-${_showCompleted ? 'down' : 'right'}" style="font-size:10px;"></i>Completed <span style="color:#B0A090;">${done.length}</span>
      </button>
      ${_showCompleted ? `<div style="margin-top:.5rem;">${done.map(t => taskRow(t, { draggable: false })).join('')}</div>` : ''}
    </div>`;
  }

  const empty = !open.length && !done.length;
  if (empty) {
    const msg = (_taskSearch || _taskTeamFilter || activeFilter !== 'all') ? 'No tasks match your filters.' : 'No tasks yet.';
    // still show quick-add for the first group when truly empty & unfiltered
    return html + `<div style="font-size:13px;color:#6B7280;padding:.5rem 0;">${msg}</div>`;
  }
  return html;
}

window._taskToggleCompleted = () => { _showCompleted = !_showCompleted; renderTasks(); };

// Exported: also used standalone by teamDashboard.js (no drag there).
export function taskRow(t, { draggable = false, group = '' } = {}) {
  const person = personnelName(t.assigned_to);
  const team   = teamName(t.team_id);
  const status = statusOf(t);
  const canDrag = draggable && !_isMobile() && !t.completed;

  const meta = [
    team ? `<span style="font-size:11px;color:#6B7280;display:inline-flex;align-items:center;gap:3px;"><i class="fa-solid fa-people-group" style="font-size:10px;"></i>${_esc(team)}</span>` : '',
    t.due_date && !t.completed ? `<span style="font-size:11px;color:${isOverdue(t) ? '#922B21' : '#6B7280'};">${fmtDate(t.due_date)}</span>` : '',
    t.recurring ? `<span style="font-size:11px;color:#6B7280;">🔁 ${RECURRENCE_LABELS[t.recurrence_pattern] || 'Recurring'}</span>` : '',
    !t.completed ? statusChip(status) : '',
    t.completed && t.completed_at ? `<span style="font-size:11px;color:#1E8449;">✓ ${fmtDate(t.completed_at.slice(0, 10))}</span>` : '',
  ].filter(Boolean).join('');

  const dragAttrs = canDrag
    ? `draggable="true" ondragstart="window._taskDragStart(event,'${t.id}')" ondragend="window._taskDragEnd(event)" ondragover="window._taskRowDragOver(event)" ondrop="window._taskRowDrop(event,'${t.id}','${group}')"`
    : '';
  const handle = canDrag
    ? `<span class="task-drag-handle" title="Drag to reorder" style="cursor:grab;color:#C9C2B6;flex-shrink:0;font-size:13px;"><i class="fa-solid fa-grip-vertical"></i></span>`
    : '';

  return `<div class="task-row" id="task-row-${t.id}" ${dragAttrs} style="display:flex;align-items:center;gap:9px;padding:.5rem 0;border-bottom:.5px solid var(--stone);" onclick="openTaskDetail('${t.id}')">
    ${handle}
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

// ── Board view ───────────────────────────────────────────────────────────────

function _boardHtml() {
  const filtered = _applyFilters(store.allTasks || []);
  const cols = BOARD_COLUMNS.map(s => {
    const items = filtered.filter(t => statusOf(t) === s);
    const m = STATUS_META[s];
    const cards = items.map(t => _boardCard(t)).join('') ||
      `<div style="font-size:12px;color:#B0A090;font-style:italic;padding:.4rem 0;">No tasks</div>`;
    return `<div class="task-col" data-status="${s}" ondragover="window._taskColDragOver(event)" ondragleave="window._taskColDragLeave(event)" ondrop="window._taskColDrop(event,'${s}')">
      <div class="task-col-head" style="display:flex;align-items:center;gap:6px;margin-bottom:.5rem;">
        <span style="width:8px;height:8px;border-radius:50%;background:${m.dot};display:inline-block;"></span>
        <span style="font-size:11.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${m.color};">${m.label}</span>
        <span style="font-size:11px;color:#B0A090;font-weight:600;">${items.length}</span>
      </div>
      ${_quickAddRow('board', s)}
      <div class="task-col-cards">${cards}</div>
    </div>`;
  }).join('');
  return `<div class="task-board">${cols}</div>`;
}

function _boardCard(t) {
  const person = personnelName(t.assigned_to);
  const team   = teamName(t.team_id);
  const canDrag = !_isMobile();
  const moveSelect = _isMobile()
    ? `<select onclick="event.stopPropagation()" onchange="window._taskMove('${t.id}',this.value)" style="font-size:11px;border:.5px solid #D1C9BE;border-radius:5px;padding:2px 4px;background:#fff;color:#1C2B3A;margin-top:6px;width:100%;">
        ${BOARD_COLUMNS.map(s => `<option value="${s}"${statusOf(t) === s ? ' selected' : ''}>${STATUS_META[s].label}</option>`).join('')}
      </select>` : '';
  const dragAttrs = canDrag ? `draggable="true" ondragstart="window._taskDragStart(event,'${t.id}')" ondragend="window._taskDragEnd(event)"` : '';
  return `<div class="task-card" id="task-card-${t.id}" ${dragAttrs} onclick="openTaskDetail('${t.id}')" style="background:#fff;border:.5px solid var(--stone);border-radius:8px;padding:.6rem .7rem;margin-bottom:.5rem;cursor:pointer;">
    <div style="font-size:13px;font-weight:500;color:#1C2B3A;line-height:1.35;${t.completed ? 'text-decoration:line-through;color:#9CA3AF;' : ''}">${_esc(t.title)}</div>
    <div style="display:flex;align-items:center;gap:7px;margin-top:7px;flex-wrap:wrap;">
      ${_miniAvatar(person, 20)}
      ${t.due_date ? `<span style="font-size:11px;color:${isOverdue(t) ? '#922B21' : '#6B7280'};">${fmtDate(t.due_date)}</span>` : ''}
      ${team ? `<span style="font-size:10.5px;color:#6B7280;display:inline-flex;align-items:center;gap:3px;"><i class="fa-solid fa-people-group" style="font-size:9px;"></i>${_esc(team)}</span>` : ''}
    </div>
    ${moveSelect}
  </div>`;
}

// ── Quick add ────────────────────────────────────────────────────────────────

function _quickAddRow(view, key) {
  const id = `qa-${view}-${key}`;
  return `<div class="task-quickadd" style="display:flex;align-items:center;gap:6px;margin-bottom:.5rem;">
    <i class="fa-solid fa-plus" style="font-size:11px;color:#B0A090;"></i>
    <input id="${id}" data-view="${view}" data-key="${key}" placeholder="Add task…" autocomplete="off" style="
      flex:1;border:none;border-bottom:.5px solid transparent;background:transparent;outline:none;
      font-size:13px;font-family:'Inter',sans-serif;color:#1C2B3A;padding:3px 0;" />
  </div>`;
}

function _wireQuickAdds(root) {
  root.querySelectorAll('.task-quickadd input').forEach(inp => {
    inp.addEventListener('focus', () => { inp.style.borderBottomColor = '#C9A84C'; });
    inp.addEventListener('blur',  () => { inp.style.borderBottomColor = 'transparent'; });
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        _quickAddCreate(inp.dataset.view, inp.dataset.key, inp.value);
      }
    });
  });
}

async function _quickAddCreate(view, key, raw) {
  const title = (raw || '').trim();
  if (!title) return;

  const payload = {
    title,
    team_id:    _taskTeamFilter || null,
    visibility: _taskTeamFilter ? 'team' : 'personal',
    status:     'not_started',
    updated_at: new Date().toISOString(),
  };
  if (view === 'board') {
    payload.status = key;
    _syncCompleted(payload, key);
  } else if (view === 'list') {
    if (key === 'today')   payload.due_date = todayCST();
    // overdue/week/later/nodate quick-adds leave due_date null (avoid surprising dates)
  }

  const { data: { user } } = await sb.auth.getUser();
  payload.created_by = user?.id || null;

  const { data: newTask, error } = await sb.from('tasks').insert(payload).select().single();
  if (error) { alert('Add failed: ' + error.message); return; }

  if (!store.allTasks) store.allTasks = [];
  store.allTasks.push(newTask);
  logActivity({ action: 'created task', entityType: 'task', entityName: newTask.title, contextType: 'task', contextId: newTask.id });
  if (newTask.assigned_to) {
    const uid = await getUserIdForPersonnel(newTask.assigned_to);
    if (uid) notifyUsers([uid], user?.id, `You've been assigned to task: ${newTask.title}`, 'info', 'tasks', newTask.id);
  }

  renderTasks();
  // refocus the same quick-add input for rapid entry
  const again = document.getElementById(`qa-${view}-${key}`);
  if (again) { again.focus(); }
}

// ── Drag & drop ──────────────────────────────────────────────────────────────

window._taskDragStart = (e, id) => {
  _dragId = id;
  try { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
  const card = document.getElementById('task-card-' + id) || document.getElementById('task-row-' + id);
  if (card) setTimeout(() => { card.style.opacity = '.4'; }, 0);
};
window._taskDragEnd = (e) => {
  const card = document.getElementById('task-card-' + _dragId) || document.getElementById('task-row-' + _dragId);
  if (card) card.style.opacity = '';
  _dragId = null;
  document.querySelectorAll('.task-col.drag-over').forEach(c => c.classList.remove('drag-over'));
};

// Board: column drop → change status
window._taskColDragOver  = (e) => { e.preventDefault(); e.currentTarget.classList.add('drag-over'); };
window._taskColDragLeave = (e) => { e.currentTarget.classList.remove('drag-over'); };
window._taskColDrop = (e, status) => {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  if (_dragId) _setStatus(_dragId, status);
};

// List: row drop → reorder within the same due group
window._taskRowDragOver = (e) => { e.preventDefault(); };
window._taskRowDrop = (e, targetId, group) => {
  e.preventDefault();
  e.stopPropagation();
  if (!_dragId || _dragId === targetId) return;
  _reorderWithinGroup(_dragId, targetId, group);
};

window._taskMove = (id, status) => _setStatus(id, status);

async function _setStatus(id, status) {
  const t = (store.allTasks || []).find(x => x.id === id);
  if (!t || statusOf(t) === status) return;
  const payload = { status, updated_at: new Date().toISOString() };
  _syncCompleted(payload, status);
  const { error } = await sb.from('tasks').update(payload).eq('id', id);
  if (error) { console.error('[tasks] status update failed:', error); return; }
  Object.assign(t, payload);
  logActivity({ action: 'moved task to ' + (STATUS_META[status]?.label || status), entityType: 'task', entityName: t.title, contextType: 'task', contextId: id });
  renderTasks();
}

async function _reorderWithinGroup(dragId, targetId, group) {
  const filtered = _applyFilters(store.allTasks || []).filter(t => !t.completed && dueBucket(t) === group);
  const ids = filtered.map(t => t.id);
  const from = ids.indexOf(dragId);
  const to   = ids.indexOf(targetId);
  if (from === -1 || to === -1) return;
  ids.splice(to, 0, ids.splice(from, 1)[0]);

  // Reassign sort_order spaced by 10 and persist.
  const updates = ids.map((id, i) => {
    const t = store.allTasks.find(x => x.id === id);
    if (t) t.sort_order = i * 10;
    return sb.from('tasks').update({ sort_order: i * 10, updated_at: new Date().toISOString() }).eq('id', id);
  });
  renderTasks();
  await Promise.all(updates).catch(err => console.error('[tasks] reorder failed:', err));
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
  toggleTask, openAddTask, openTaskDetail, saveTask, deleteTask, toggleRecurUI, renderTasks, appendTaskComment,
});
