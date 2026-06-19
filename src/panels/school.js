import { sb } from '../supabase.js';
import { fmtDate } from '../utils.js';

const SCHOOL_STATUS_BADGE = {planning:'badge-pending',active:'badge-active',confirmed:'badge-active',complete:'badge-complete',cancelled:'badge-complete'};

export async function loadSchool() {
  const {data} = await sb.from('school_events').select('*').order('event_date',{nullsFirst:false});
  const cats = {retreat:'retreats',peer_ministry:'peer',liturgy:'liturgy',theology:'theology'};
  Object.keys(cats).forEach(cat => {
    const el = document.getElementById(`school-${cats[cat]}-list`);
    if(!el) return;
    const items = (data||[]).filter(e => e.category===cat);
    if(!items.length){el.innerHTML='<div style="font-size:13px;color:#6B7280;">No items.</div>';return;}
    el.innerHTML = items.map(e => `
      <div class="evt-item clickable" onclick="openSchoolDetail('${e.id}')">
        <div style="flex:1;min-width:0;">
          <div class="evt-title">${e.title}</div>
          <div class="evt-sub">${e.event_date?fmtDate(e.event_date)+' · ':e.date_note?e.date_note+' · ':''}${e.location?e.location+' · ':''}${e.notes||''}</div>
        </div>
        <span class="badge ${SCHOOL_STATUS_BADGE[e.status]||'badge-pending'}">${e.status}</span>
      </div>`).join('');
  });
}

function schoolEventForm(cat, data) {
  const catLabels = {retreat:'Retreat',peer_ministry:'Peer Ministry',liturgy:'Liturgical Activity',theology:'Theology Dept'};
  return `<div class="modal-title">${data?'Edit':'Add'} — ${catLabels[cat]||cat}</div>
  <label>Title</label><input id="f-title" value="${data?.title||''}" />
  <label>Date</label><input type="date" id="f-due" value="${data?.event_date||''}" />
  <label>Date note (if no firm date)</label><input id="f-dn" value="${data?.date_note||''}" />
  <label>Location</label><input id="f-loc" value="${data?.location||''}" />
  <label>Status</label>
  <select id="f-st">
    ${['planning','active','confirmed','complete','cancelled'].map(s=>`<option value="${s}"${data?.status===s?' selected':''}>${s}</option>`).join('')}
  </select>
  <label>Student count</label><input type="number" id="f-sc2" value="${data?.student_count||''}" />
  <label>Notes</label><textarea id="f-notes">${data?.notes||''}</textarea>
  <input type="hidden" id="f-cat" value="${cat}" />
  <div class="modal-actions">
    <button class="btn-secondary" onclick="closeModal()">Cancel</button>
    <button class="btn-primary" onclick="saveSchoolEvent(${data?`'${data.id}'`:null})">Save</button>
  </div>`;
}

function openSchoolModal(cat) {
  document.getElementById('modal-content').innerHTML = schoolEventForm(cat);
  document.getElementById('modal-overlay').classList.add('open');
}

async function saveSchoolEvent(id) {
  const payload = {
    title:document.getElementById('f-title').value.trim(),
    category:document.getElementById('f-cat').value,
    event_date:document.getElementById('f-due').value||null,
    date_note:document.getElementById('f-dn').value.trim(),
    location:document.getElementById('f-loc').value.trim(),
    status:document.getElementById('f-st').value,
    student_count:parseInt(document.getElementById('f-sc2').value)||null,
    notes:document.getElementById('f-notes').value.trim(),
    updated_at:new Date().toISOString()
  };
  if(!payload.title){alert('Title is required.');return;}
  let error;
  if(id){({ error } = await sb.from('school_events').update(payload).eq('id',id));}
  else{({ error } = await sb.from('school_events').insert(payload));}
  if(error){alert('Save failed: '+error.message);return;}
  window.flashSavedThen(() => { closeModal(); loadSchool(); });
}

function openSchoolDetail(id) {
  sb.from('school_events').select('*').eq('id',id).single().then(({data}) => {
    document.getElementById('modal-content').innerHTML = schoolEventForm(data.category, data);
    document.getElementById('modal-overlay').classList.add('open');
  });
}

Object.assign(window, { openSchoolModal, saveSchoolEvent, openSchoolDetail });
