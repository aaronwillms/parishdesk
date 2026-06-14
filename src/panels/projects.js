import { sb } from '../supabase.js';
import { store } from '../store.js';
import { fmtDate } from '../utils.js';
import { updateProjectStats, renderDashProjects } from './dashboard.js';

export const STATUS_LABELS = {deadline:'Deadline',action:'My Action',waiting:'Waiting On',capital:'Capital',standing:'Standing',done:'Done'};
const STATUS_COLORS = {deadline:'#D4AC0D',action:'#1B4F72',waiting:'#AAB7B8',capital:'#2D6A4F',standing:'#C8A96E',done:'#7FAE7C'};
const BADGE_CLASS = {deadline:'badge-urgent',action:'badge-active',waiting:'badge-complete',capital:'badge-active',standing:'badge-pending',done:'badge-complete'};

export async function loadProjects() {
  const {data, error} = await sb.from('projects').select('*').order('sort_order').order('due_date', {nullsFirst:false});
  if(error){console.error(error);return;}
  store.allProjects = data || [];
  renderProjects();
  updateProjectStats();
  renderDashProjects();
}

function renderProjects() {
  const filterEl = document.getElementById('project-filter');
  if(!filterEl) return;
  const filter = filterEl.value;
  const items = filter==='all' ? store.allProjects : store.allProjects.filter(p => p.status_code===filter);
  const c = document.getElementById('projects-list');
  if(!items.length){c.innerHTML='<div style="font-size:13px;color:#6B7280;padding:.5rem 0;">No items.</div>';return;}

  const grouped = {};
  items.forEach(p => {
    if(!grouped[p.status_code]) grouped[p.status_code] = [];
    grouped[p.status_code].push(p);
  });
  const ORDER = ['deadline','action','waiting','capital','standing','done'];
  let html = '';
  ORDER.forEach(s => {
    if(!grouped[s]||!grouped[s].length) return;
    html += `<div class="card">
      <div class="card-header"><div class="card-title"><span class="status-dot s-${s}" style="margin-right:4px;"></span>${STATUS_LABELS[s]}</div>
      <button class="card-action" onclick="openModal('project','${s}')">+ Add</button></div>`;
    grouped[s].forEach(p => {
      const subtasks = p.subtasks||[];
      const done = subtasks.filter(t=>t.done).length;
      html += `<div class="evt-item clickable" onclick="openProjectDetail('${p.id}')">
        <div style="flex:1;min-width:0;">
          <div class="evt-title">${p.title}</div>
          <div class="evt-sub">${p.context||''}${p.owner?` · ⏳ ${p.owner}`:''}${subtasks.length?` · ${done}/${subtasks.length} steps`:''}</div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
          ${p.due_date?`<span class="badge ${BADGE_CLASS[p.status_code]}">${fmtDate(p.due_date)}</span>`:p.date_note?`<span class="badge badge-pending">${p.date_note}</span>`:''}
        </div>
      </div>`;
    });
    html += '</div>';
  });
  c.innerHTML = html;
}

export function projectForm(defaultStatus, data) {
  return `<div class="modal-title">${data?'Edit project':'Add project'}</div>
  <label>Title</label><input id="f-title" value="${data?.title||''}" />
  <label>Context / project</label><input id="f-ctx" value="${data?.context||''}" />
  <label>Status</label>
  <select id="f-sc">
    ${Object.entries(STATUS_LABELS).map(([k,v])=>`<option value="${k}"${(data?.status_code||defaultStatus)===k?' selected':''}>${v}</option>`).join('')}
  </select>
  <label>Type</label><input id="f-type" value="${data?.type||''}" placeholder="e.g. School, Capital, Formation" />
  <label>Due date</label><input type="date" id="f-due" value="${data?.due_date||''}" />
  <label>Date note (if no firm date)</label><input id="f-dn" value="${data?.date_note||''}" placeholder="e.g. August" />
  <label>Owner / waiting on</label><input id="f-own" value="${data?.owner||''}" />
  <label>Notes</label><textarea id="f-notes">${data?.notes||''}</textarea>
  <div class="modal-actions">
    <button class="btn-secondary" onclick="closeModal()">Cancel</button>
    <button class="btn-primary" onclick="saveProject(${data?`'${data.id}'`:null})">Save</button>
  </div>`;
}

async function saveProject(id) {
  const payload = {
    title:document.getElementById('f-title').value.trim(),
    context:document.getElementById('f-ctx').value.trim(),
    status_code:document.getElementById('f-sc').value,
    type:document.getElementById('f-type').value.trim(),
    due_date:document.getElementById('f-due').value||null,
    date_note:document.getElementById('f-dn').value.trim(),
    owner:document.getElementById('f-own').value.trim(),
    notes:document.getElementById('f-notes').value.trim(),
    updated_at:new Date().toISOString()
  };
  if(!payload.title){alert('Title is required.');return;}
  if(id){await sb.from('projects').update(payload).eq('id',id);}
  else{await sb.from('projects').insert(payload);}
  closeModal(); loadProjects();
}

function openProjectDetail(id) {
  const proj = store.allProjects.find(p => p.id===id);
  if(proj) {
    document.getElementById('modal-content').innerHTML = projectForm(proj.status_code, proj);
    document.getElementById('modal-overlay').classList.add('open');
  }
}

Object.assign(window, { saveProject, openProjectDetail });
