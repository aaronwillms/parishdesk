import { sb } from '../supabase.js';
import { store } from '../store.js';
import { fmtDate } from '../utils.js';
import { updateProjectStats, renderDashProjects } from './dashboard.js';

const STATUS = {
  not_started: { label: 'Not Started', color: '#6B7280', bg: '#F3F4F6' },
  in_progress:  { label: 'In Progress',  color: '#1B4F72', bg: '#EBF5FB' },
  blocked:      { label: 'Blocked',      color: '#922B21', bg: '#FDEDEC' },
  complete:     { label: 'Complete',     color: '#1E8449', bg: '#EAFAF1' },
};

const ORDER = ['blocked', 'in_progress', 'not_started', 'complete'];

let activeFilter = 'all';

export async function loadProjects() {
  const { data, error } = await sb
    .from('projects')
    .select('*')
    .order('due_date', { nullsFirst: false })
    .order('created_at');
  if (error) { console.error('[projects]', error); return; }
  store.allProjects = data || [];
  renderProjects();
  updateProjectStats();
  renderDashProjects();
}

export function renderProjects() {
  const el = document.getElementById('projects-list');
  if (!el) return;

  const items = activeFilter === 'all'
    ? store.allProjects
    : store.allProjects.filter(p => p.status_code === activeFilter);

  // Update active filter button styles
  document.querySelectorAll('.proj-filter-btn').forEach(b => {
    b.classList.toggle('btn-primary', b.dataset.filter === activeFilter);
    b.classList.toggle('btn-secondary', b.dataset.filter !== activeFilter);
  });

  if (!items.length) {
    el.innerHTML = '<div style="font-size:13px;color:#6B7280;padding:.5rem 0;">No projects.</div>';
    return;
  }

  const grouped = {};
  items.forEach(p => {
    if (!grouped[p.status_code]) grouped[p.status_code] = [];
    grouped[p.status_code].push(p);
  });

  let html = '';
  ORDER.forEach(s => {
    const group = grouped[s];
    if (!group?.length) return;
    const st = STATUS[s] || STATUS.not_started;
    html += `<div style="margin-bottom:1.25rem;">
      <div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.5rem;">${st.label}</div>`;
    group.forEach(p => {
      html += projectCard(p);
    });
    html += `</div>`;
  });
  el.innerHTML = html;
}

function personnelName(id) {
  if (!id) return null;
  return (store.personnel || []).find(p => p.id === id)?.name || null;
}

function teamName(id) {
  if (!id) return null;
  return (store.teams || []).find(t => t.id === id)?.name || null;
}

function statusBadge(code) {
  const st = STATUS[code] || STATUS.not_started;
  return `<span style="font-size:11px;font-weight:600;background:${st.bg};color:${st.color};border-radius:20px;padding:2px 9px;white-space:nowrap;">${st.label}</span>`;
}

function projectCard(p) {
  const person = personnelName(p.assigned_to);
  const team   = teamName(p.team_id);
  return `<div class="evt-item clickable" onclick="openProjectDetail('${p.id}')">
    <div style="flex:1;min-width:0;">
      <div class="evt-title">${p.title}</div>
      <div class="evt-sub" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:3px;">
        ${statusBadge(p.status_code)}
        ${person ? `<span style="font-size:11.5px;color:#6B7280;">👤 ${person}</span>` : ''}
        ${team   ? `<span style="font-size:11.5px;color:#6B7280;">🏛 ${team}</span>` : ''}
        ${p.due_date ? `<span style="font-size:11.5px;color:#6B7280;">📅 ${fmtDate(p.due_date)}</span>` : ''}
      </div>
      ${p.notes ? `<div style="font-size:12px;color:#9CA3AF;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${p.notes}</div>` : ''}
    </div>
  </div>`;
}

function teamOptions(selectedId) {
  const teams = store.teams || [];
  return `<option value="">— None —</option>` +
    teams.map(t => `<option value="${t.id}"${t.id === selectedId ? ' selected' : ''}>${t.name}</option>`).join('');
}

function personnelOptions(selectedId) {
  const people = [...(store.personnel || [])].sort((a, b) => {
    const la = (a.name || '').split(' ').pop();
    const lb = (b.name || '').split(' ').pop();
    return la.localeCompare(lb);
  });
  return `<option value="">— None —</option>` +
    people.map(p => `<option value="${p.id}"${p.id === selectedId ? ' selected' : ''}>${p.name}</option>`).join('');
}

export function projectForm(defaultStatus, data) {
  const sc = data?.status_code || defaultStatus || 'not_started';
  return `<div class="modal-title">${data ? 'Edit project' : 'Add project'}</div>
  <label>Title</label><input id="f-title" value="${data?.title || ''}" placeholder="Project name" />
  <label>Status</label>
  <select id="f-sc">
    ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}"${k === sc ? ' selected' : ''}>${v.label}</option>`).join('')}
  </select>
  <label>Team (optional)</label>
  <select id="f-team">${teamOptions(data?.team_id)}</select>
  <label>Assigned to (optional)</label>
  <select id="f-assigned">${personnelOptions(data?.assigned_to)}</select>
  <label>Due date</label><input type="date" id="f-due" value="${data?.due_date || ''}" />
  <label>Visibility</label>
  <select id="f-vis">
    <option value="team"${(data?.visibility || 'team') === 'team' ? ' selected' : ''}>Team</option>
    <option value="personal"${data?.visibility === 'personal' ? ' selected' : ''}>Personal</option>
  </select>
  <label>Notes</label><textarea id="f-notes" rows="3">${data?.notes || ''}</textarea>
  <div class="modal-actions" style="justify-content:space-between;">
    ${data ? `<button class="btn-delete" onclick="deleteProject('${data.id}')">Delete</button>` : '<span></span>'}
    <div style="display:flex;gap:8px;">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" onclick="saveProject(${data ? `'${data.id}'` : null})">Save</button>
    </div>
  </div>`;
}

async function saveProject(id) {
  const title = document.getElementById('f-title').value.trim();
  if (!title) { alert('Title is required.'); return; }
  const payload = {
    title,
    status_code: document.getElementById('f-sc').value,
    team_id:     document.getElementById('f-team').value     || null,
    assigned_to: document.getElementById('f-assigned').value || null,
    due_date:    document.getElementById('f-due').value      || null,
    visibility:  document.getElementById('f-vis').value,
    notes:       document.getElementById('f-notes').value.trim() || null,
    updated_at:  new Date().toISOString(),
  };
  let err;
  if (id) {
    const r = await sb.from('projects').update(payload).eq('id', id); err = r.error;
  } else {
    const r = await sb.from('projects').insert(payload); err = r.error;
  }
  if (err) { alert('Save failed: ' + err.message); return; }
  closeModal();
  loadProjects();
}

async function deleteProject(id) {
  const p = store.allProjects.find(x => x.id === id);
  if (!confirm(`Delete "${p?.title}"? This cannot be undone.`)) return;
  const { error } = await sb.from('projects').delete().eq('id', id);
  if (error) { alert('Delete failed: ' + error.message); return; }
  closeModal();
  loadProjects();
}

function openProjectDetail(id) {
  const proj = store.allProjects.find(p => p.id === id);
  if (!proj) return;
  document.getElementById('modal-content').innerHTML = projectForm(proj.status_code, proj);
  document.getElementById('modal-overlay').classList.add('open');
}

function setProjectFilter(f) {
  activeFilter = f;
  renderProjects();
}

Object.assign(window, { saveProject, deleteProject, openProjectDetail, setProjectFilter, renderProjects });
