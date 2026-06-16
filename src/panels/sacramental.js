import { sb } from '../supabase.js';
import { fmtDate, todayCST } from '../utils.js';
import { notifyUsers, getUserIdsForSacrament } from '../notifications.js';

const SACRAMENTAL_CFG = {
  baptism: {
    table:      'sacramental_baptism',
    listEl:     'bap-list',
    searchEl:   'bap-search',
    statTotal:  'stat-bap-total',
    statDate:   'stat-bap-upcoming',
    statDocs:   'stat-bap-docs',
    dateField:  'sacrament_date',
    dateLabel:  'Baptism date',
    nameLabel:  'Child\'s name',
    addLabel:   'Add child',
    statusOptions: null,
    extraFields: [
      {id:'dob',       label:'Date of birth',    type:'text'},
      {id:'father',    label:'Father\'s name',   type:'text'},
      {id:'mother',    label:'Mother\'s name',   type:'text'},
      {id:'phone',     label:'Contact phone',    type:'text'},
      {id:'email',     label:'Contact email',    type:'text'},
      {id:'godfather', label:'Godfather',        type:'text'},
      {id:'godmother', label:'Godmother',        type:'text'},
    ],
  },
  firstcomm: {
    table:      'sacramental_firstcomm',
    listEl:     'fc-list',
    searchEl:   'fc-search',
    statTotal:  'stat-fc-total',
    statDate:   'stat-fc-upcoming',
    statDocs:   'stat-fc-docs',
    dateField:  'sacrament_date',
    dateLabel:  'First Communion date',
    nameLabel:  'Student\'s name',
    addLabel:   'Add student',
    statusOptions: null,
    extraFields: [
      {id:'parent1',   label:'Parent / Guardian 1', type:'text'},
      {id:'parent2',   label:'Parent / Guardian 2', type:'text'},
      {id:'phone',     label:'Contact phone',        type:'text'},
      {id:'email',     label:'Contact email',        type:'text'},
      {id:'grade',     label:'School grade',         type:'text'},
    ],
  },
  confirmation: {
    table:      'sacramental_confirmation',
    listEl:     'con-list',
    searchEl:   'con-search',
    statTotal:  'stat-con-total',
    statDate:   'stat-con-upcoming',
    statDocs:   'stat-con-docs',
    dateField:  'sacrament_date',
    dateLabel:  'Confirmation date',
    nameLabel:  'Student\'s name',
    addLabel:   'Add student',
    statusOptions: null,
    extraFields: [
      {id:'parent1',   label:'Parent / Guardian 1', type:'text'},
      {id:'parent2',   label:'Parent / Guardian 2', type:'text'},
      {id:'phone',     label:'Contact phone',        type:'text'},
      {id:'email',     label:'Contact email',        type:'text'},
      {id:'grade',     label:'School grade',         type:'text'},
      {id:'sponsor',   label:'Sponsor',              type:'text'},
    ],
  },
};

const sacData = {baptism:[],firstcomm:[],confirmation:[]};
const sacFilter = {baptism:'all',firstcomm:'all',confirmation:'all'};
const sacExpanded = {baptism:null,firstcomm:null,confirmation:null};
const sacSelected = {baptism:new Set(),firstcomm:new Set(),confirmation:new Set()};

function setSacramentalFilter(prog, f, el) {
  sacFilter[prog] = f;
  const panel = document.getElementById('panel-'+prog);
  panel.querySelectorAll('.cf-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  renderSacramental(prog);
}

export async function loadSacramental(prog) {
  const cfg = SACRAMENTAL_CFG[prog];
  const {data, error} = await sb.from(cfg.table).select('*').order('created_at',{ascending:false});
  if(error){console.error(prog+' load error:',error.message);return;}
  sacData[prog] = data||[];
  updateSacramentalStats(prog);
  renderSacramental(prog);
}

function updateSacramentalStats(prog) {
  const cfg = SACRAMENTAL_CFG[prog];
  const items = sacData[prog];
  const active = items.filter(i => !i.archived);
  const el = id => document.getElementById(id);
  el(cfg.statTotal).textContent = active.length;
  const now = new Date(new Date().toLocaleString('en-US',{timeZone:'America/Chicago'}));
  const upcoming = active.filter(i => {
    if(!i.sacrament_date) return false;
    const d = new Date(i.sacrament_date+'T00:00:00');
    const diff = Math.round((d-now)/86400000);
    return diff>=0&&diff<=60;
  });
  el(cfg.statDate).textContent = upcoming.length;
  el(cfg.statDocs).textContent = active.filter(i => {
    const docs = i.documents||[];
    return docs.length>0&&docs.some(d=>!d.done);
  }).length;
}

function renderSacramental(prog) {
  const cfg = SACRAMENTAL_CFG[prog];
  const q = (document.getElementById(cfg.searchEl)?.value||'').toLowerCase();
  const f = sacFilter[prog];
  const items = sacData[prog].filter(i => {
    const name = (i.name||'').toLowerCase();
    const matchQ = !q||name.includes(q);
    let matchF = true;
    if(f==='active') matchF = !i.archived;
    else if(f==='archived') matchF = i.archived;
    return matchQ&&matchF;
  });
  const el = document.getElementById(cfg.listEl);
  if(!items.length){el.innerHTML='<div style="font-size:13px;color:#6B7280;padding:.5rem 0;">No records found.</div>';_renderSacBulkBar(prog);return;}
  const activeSac = items.filter(i => !i.archived);
  const archivedSac = items.filter(i => i.archived);
  const allVisible = items.map(i => i.id);
  const sel = sacSelected[prog];
  const allChecked = allVisible.length > 0 && allVisible.every(id => sel.has(id));
  let html = `<div style="display:flex;align-items:center;gap:8px;padding:4px 0 10px;border-bottom:.5px solid var(--stone);margin-bottom:8px;">
    <input type="checkbox" id="sac-sel-all-${prog}" ${allChecked?'checked':''} onchange="sacToggleAll('${prog}',this.checked)" style="width:14px;height:14px;accent-color:var(--cardinal);cursor:pointer;flex-shrink:0;" />
    <label for="sac-sel-all-${prog}" style="font-size:12px;color:#6B7280;cursor:pointer;margin:0;">Select all</label>
  </div>`;
  html += activeSac.map(i => renderSacramentalCard(prog,i)).join('');
  if(archivedSac.length) {
    html += `<div style="display:flex;align-items:center;gap:10px;margin:18px 0 10px;"><div style="flex:1;height:.5px;background:var(--stone);"></div><span style="font-size:11px;color:#6B7280;letter-spacing:.07em;text-transform:uppercase;font-weight:500;white-space:nowrap;">Archived</span><div style="flex:1;height:.5px;background:var(--stone);"></div></div>`;
    html += archivedSac.map(i => renderSacramentalCard(prog,i)).join('');
  }
  el.innerHTML = html;
  _renderSacBulkBar(prog);
}

function _renderSacBulkBar(prog) {
  const barId = `sac-bulk-bar-${prog}`;
  let bar = document.getElementById(barId);
  const sel = sacSelected[prog];
  if (!sel.size) { if(bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = barId;
    bar.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:9999;background:var(--navy);color:#fff;border-radius:10px;padding:10px 18px;display:flex;align-items:center;gap:14px;box-shadow:0 4px 24px rgba(0,0,0,.22);font-size:13px;';
    document.body.appendChild(bar);
  }
  bar.innerHTML = `
    <span style="font-weight:600;">${sel.size} selected</span>
    <select id="sac-bulk-action-${prog}" style="border-radius:6px;border:none;padding:4px 8px;font-size:12px;font-family:'Inter',sans-serif;background:#fff;color:var(--navy);cursor:pointer;">
      <option value="">— Action —</option>
      <option value="archive">Archive</option>
      <option value="unarchive">Unarchive</option>
    </select>
    <button onclick="sacApplyBulk('${prog}')" style="background:var(--cardinal);color:#fff;border:none;border-radius:6px;padding:5px 14px;font-size:12px;font-family:'Inter',sans-serif;cursor:pointer;font-weight:600;">Apply</button>
    <button onclick="sacClearSelection('${prog}')" style="background:none;border:1px solid rgba(255,255,255,.3);color:#fff;border-radius:6px;padding:5px 10px;font-size:12px;font-family:'Inter',sans-serif;cursor:pointer;">✕</button>`;
}

function renderSacramentalCard(prog, item) {
  const cfg = SACRAMENTAL_CFG[prog];
  const docs = item.documents||[];
  const docsDone = docs.filter(d=>d.done).length;
  const progress = docs.length>0?Math.round((docsDone/docs.length)*100):null;
  const exp = sacExpanded[prog]===item.id;

  let badge = '';
  if(cfg.statusOptions) {
    const sm = cfg.statusOptions.find(s=>s.value===item.status_code)||cfg.statusOptions[0];
    badge = `<span style="background:${sm.bg};color:${sm.color};border-radius:20px;padding:2px 10px;font-size:11px;font-weight:600;letter-spacing:.04em;display:inline-flex;align-items:center;gap:5px;border:1px solid ${sm.color}33;"><span style="width:7px;height:7px;border-radius:50%;background:${sm.dot};display:inline-block;"></span>${sm.label}</span>`;
  }

  const dateVal = item.sacrament_date;
  let dateChip = '';
  if(dateVal) {
    const days = Math.round((new Date(dateVal+'T00:00:00')-new Date(new Date().toLocaleString('en-US',{timeZone:'America/Chicago'})))/86400000);
    const urgent = days>=0&&days<=7;
    dateChip = `<span style="font-size:11px;color:${urgent?'#C0392B':'#777'};background:${urgent?'#FDEDEC':'#EFEFEF'};border-radius:20px;padding:2px 8px;">${urgent?'⚠️ ':''}${fmtDate(dateVal)}${days>=0&&days<=60?` · ${days===0?'Today':days===1?'Tomorrow':days+' days'}`:''}</span>`;
  }

  const isSelChecked = sacSelected[prog].has(item.id);
  let h = `<div class="couple-card" style="border-left:4px solid var(--gold);">
    <div class="couple-header" style="gap:10px;">
      <input type="checkbox" class="sac-sel-cb" data-prog="${prog}" data-id="${item.id}" ${isSelChecked?'checked':''} onchange="sacToggleOne('${prog}','${item.id}',this.checked)" onclick="event.stopPropagation()" style="width:14px;height:14px;accent-color:var(--cardinal);cursor:pointer;flex-shrink:0;" />
      <div style="flex:1;" onclick="toggleSacramental('${prog}','${item.id}')">
        <div class="couple-name">${item.name||'—'}</div>
        <div style="display:flex;gap:6px;margin-top:5px;flex-wrap:wrap;align-items:center;">
          ${badge}${dateChip}
          ${progress!==null?(progress===100?'<span style="font-size:11px;color:#2D6A4F;">✅ docs complete</span>':`<span style="font-size:11px;color:#922B21;">${docsDone}/${docs.length} docs</span>`):''}
        </div>
      </div>
      <span style="font-size:16px;color:#B0A090;">${exp?'▲':'▼'}</span>
    </div>`;

  if(exp) {
    h += `<div class="couple-body">`;
    h += `<div style="margin-top:10px;">`;
    const extras = {dob:'🎂',father:'👨',mother:'👩',godfather:'✝',godmother:'✝',parent1:'👨',parent2:'👩',grade:'📚',sponsor:'✝',prior_church:'⛪'};
    cfg.extraFields.forEach(f => {
      if(item[f.id]) h += `<span class="detail-chip">${extras[f.id]||'·'} ${item[f.id]}</span>`;
    });
    h += `</div>`;

    if(item.phone||item.email) {
      h += `<div style="margin-top:8px;">`;
      if(item.phone) h += `<a href="tel:${item.phone}" class="contact-chip">📞 ${item.phone}</a>`;
      if(item.email) h += `<a href="mailto:${item.email}" class="contact-chip">✉️ ${item.email}</a>`;
      h += `</div>`;
    }

    const hasNotes = !!(item.notes&&item.notes.trim());
    h += `<div style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;margin-bottom:4px;">
      ${hasNotes?'<span class="couple-section-label" style="margin:0;">Notes</span>':'<span></span>'}
      <button onclick="toggleSacNoteForm('${prog}','${item.id}')" style="font-size:12px;color:var(--cardinal);background:none;border:none;cursor:pointer;font-family:'Inter',sans-serif;padding:0;">+ Add note</button>
    </div>`;
    h += `<div id="sac-note-form-${item.id}" style="display:none;margin-bottom:.5rem;">
      <textarea id="sac-note-text-${item.id}" placeholder="Add a note…" rows="2" style="width:100%;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .75rem;font-size:13px;font-family:'Inter',sans-serif;background:#FFFFFF;outline:none;resize:vertical;margin-bottom:6px;"></textarea>
      <div style="display:flex;gap:8px;">
        <button class="btn-primary" style="padding:.35rem .9rem;font-size:12px;" onclick="appendSacNote('${prog}','${item.id}')">Save</button>
        <button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="toggleSacNoteForm('${prog}','${item.id}')">Cancel</button>
      </div>
    </div>`;
    if(hasNotes) {
      const entries = item.notes.split('\n\n').filter(n=>n.trim());
      h += entries.map((n,i) => `<div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:6px;padding:8px 12px;background:#FFF8EE;border-left:3px solid var(--gold);border-radius:3px;">
        <div style="font-size:13px;color:#555;font-style:italic;flex:1;white-space:pre-wrap;">${n}</div>
        <button onclick="deleteSacNote('${prog}','${item.id}',${i})" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:13px;padding:0;flex-shrink:0;line-height:1.4;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#CCC'">✕</button>
      </div>`).join('');
    }

    h += `<div style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;margin-bottom:4px;">
      <span class="couple-section-label" style="margin:0;">Documents</span>
      <button onclick="toggleSacDocForm('${prog}','${item.id}')" style="font-size:12px;color:var(--cardinal);background:none;border:none;cursor:pointer;font-family:'Inter',sans-serif;padding:0;">+ Add document</button>
    </div>`;
    h += `<div id="sac-doc-form-${item.id}" style="display:none;margin-bottom:.5rem;">
      <input type="text" id="sac-doc-name-${item.id}" placeholder="Document name…" style="width:100%;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .75rem;font-size:13px;font-family:'Inter',sans-serif;background:#FFFFFF;outline:none;margin-bottom:6px;" />
      <div style="display:flex;gap:8px;">
        <button class="btn-primary" style="padding:.35rem .9rem;font-size:12px;" onclick="addSacDoc('${prog}','${item.id}')">Save</button>
        <button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="toggleSacDocForm('${prog}','${item.id}')">Cancel</button>
      </div>
    </div>`;
    if(docs.length) {
      if(progress!==null) {
        h += `<div class="prog-bar-wrap"><div class="prog-bar-fill" style="width:${progress}%;background:${progress===100?'#2D6A4F':'var(--gold)'};"></div></div>`;
        h += `<div style="font-size:11px;color:#888;margin-bottom:6px;">${progress}% complete</div>`;
      }
      h += docs.map((d,i) => `<div class="doc-item" style="padding:4px 6px;border-radius:var(--radius-sm);transition:background .12s;" onmouseover="this.style.background='var(--parch)'" onmouseout="this.style.background='transparent'">
        <span style="font-size:15px;cursor:pointer;" onclick="toggleSacDoc('${prog}','${item.id}',${i})">${d.done?'✅':'❌'}</span>
        <span style="color:${d.done?'#2D6A4F':'#922B21'};flex:1;cursor:pointer;" onclick="toggleSacDoc('${prog}','${item.id}',${i})">${d.name}</span>
        <button onclick="deleteSacDoc('${prog}','${item.id}',${i})" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:13px;padding:0 0 0 8px;flex-shrink:0;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#CCC'">✕</button>
      </div>`).join('');
    }

    const tl = item.timeline||[];
    h += `<div style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;margin-bottom:4px;">
      <span class="couple-section-label" style="margin:0;">Timeline</span>
      <button onclick="toggleSacTlForm('${prog}','${item.id}')" style="font-size:12px;color:var(--cardinal);background:none;border:none;cursor:pointer;font-family:'Inter',sans-serif;padding:0;">+ Add update</button>
    </div>`;
    h += `<div id="sac-tl-form-${item.id}" style="display:none;background:var(--parch);border:.5px solid var(--stone);border-radius:var(--radius-sm);padding:.75rem;margin-bottom:.75rem;">
      <input type="date" id="sac-tl-date-${item.id}" value="${todayCST()}" style="width:100%;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .75rem;font-size:13px;font-family:'Inter',sans-serif;background:#FFFFFF;outline:none;margin-bottom:6px;" />
      <input type="text" id="sac-tl-event-${item.id}" placeholder="Update comment…" style="width:100%;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .75rem;font-size:13px;font-family:'Inter',sans-serif;background:#FFFFFF;outline:none;margin-bottom:6px;" />
      <div style="display:flex;gap:8px;">
        <button class="btn-primary" style="padding:.35rem .9rem;font-size:12px;" onclick="addSacTlEntry('${prog}','${item.id}')">Save</button>
        <button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="toggleSacTlForm('${prog}','${item.id}')">Cancel</button>
      </div>
    </div>`;
    if(tl.length) {
      h += `<div class="tl-wrap">`;
      h += tl.map((e,i) => `<div class="tl-item" style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
        <div style="flex:1;"><div class="tl-dot"></div>${e.date?`<div class="tl-date">${fmtDate(e.date)}</div>`:''}<div class="tl-event">${e.event}</div></div>
        <button onclick="deleteSacTlEntry('${prog}','${item.id}',${i})" style="background:none;border:none;cursor:pointer;color:#AAA;font-size:14px;padding:0;flex-shrink:0;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#AAA'">✕</button>
      </div>`).join('');
      h += `</div>`;
    } else {
      h += `<div style="font-size:13px;color:#6B7280;font-style:italic;padding:.25rem 0;">No timeline entries yet.</div>`;
    }

    if(item.updated_at) {
      const upd = new Date(item.updated_at);
      h += `<div style="font-size:11px;color:#AAA;margin-top:10px;margin-bottom:8px;">Last updated: ${upd.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</div>`;
    }
    h += `<div style="margin-top:4px;display:flex;gap:8px;">
      <button class="btn-primary" onclick="openSacramentalModal('${prog}','${item.id}')">Edit</button>
    </div>`;
    h += `</div>`;
  }
  h += `</div>`;
  return h;
}

function toggleSacramental(prog, id) {sacExpanded[prog]=sacExpanded[prog]===id?null:id;renderSacramental(prog);}

async function quickSacramentalStatus(prog, id, val) {
  const cfg = SACRAMENTAL_CFG[prog];
  const item = sacData[prog].find(i => i.id===id);
  if(!item) return;
  const {error} = await sb.from(cfg.table).update({status_code:val,updated_at:new Date().toISOString()}).eq('id',id);
  if(error){console.error('[sacramental] quickStatus error:', error);alert('Save failed: '+error.message);return;}
  item.status_code = val;
  updateSacramentalStats(prog);
  renderSacramental(prog);
}

function toggleSacNoteForm(prog, id) {const f=document.getElementById('sac-note-form-'+id);if(!f)return;f.style.display=f.style.display==='none'?'block':'none';if(f.style.display==='block')document.getElementById('sac-note-text-'+id).focus();}

async function appendSacNote(prog, id) {
  const cfg = SACRAMENTAL_CFG[prog];
  const item = sacData[prog].find(i => i.id===id);
  if(!item) return;
  const txt = document.getElementById('sac-note-text-'+id).value.trim();
  if(!txt){alert('Please enter a note.');return;}
  const now = new Date(new Date().toLocaleString('en-US',{timeZone:'America/Chicago'}));
  const ds = `${now.getMonth()+1}/${now.getDate()}/${now.getFullYear()}`;
  const newNotes = item.notes?`${item.notes}\n\n[${ds}] ${txt}`:`[${ds}] ${txt}`;
  const {error} = await sb.from(cfg.table).update({notes:newNotes,updated_at:new Date().toISOString()}).eq('id',id);
  if(error){console.error('[sacramental] appendNote error:', error);alert('Save failed: '+error.message);return;}
  item.notes = newNotes;
  renderSacramental(prog);
}

async function deleteSacNote(prog, id, idx) {
  const cfg = SACRAMENTAL_CFG[prog];
  const item = sacData[prog].find(i => i.id===id);
  if(!item||!confirm('Delete this note?')) return;
  const entries = item.notes.split('\n\n').filter(n=>n.trim());
  entries.splice(idx,1);
  const newNotes = entries.join('\n\n');
  const {error} = await sb.from(cfg.table).update({notes:newNotes,updated_at:new Date().toISOString()}).eq('id',id);
  if(error){console.error('[sacramental] deleteNote error:', error);alert('Delete failed: '+error.message);return;}
  item.notes = newNotes;
  renderSacramental(prog);
}

function toggleSacDocForm(prog, id) {const f=document.getElementById('sac-doc-form-'+id);if(!f)return;f.style.display=f.style.display==='none'?'block':'none';if(f.style.display==='block')document.getElementById('sac-doc-name-'+id).focus();}

async function addSacDoc(prog, id) {
  const cfg = SACRAMENTAL_CFG[prog];
  const item = sacData[prog].find(i => i.id===id);
  if(!item) return;
  const name = document.getElementById('sac-doc-name-'+id).value.trim();
  if(!name){alert('Please enter a document name.');return;}
  const docs = JSON.parse(JSON.stringify(item.documents||[]));
  docs.push({name, done:false});
  const {error} = await sb.from(cfg.table).update({documents:docs,updated_at:new Date().toISOString()}).eq('id',id);
  if(error){console.error('[sacramental] addDoc error:', error);alert('Save failed: '+error.message);return;}
  item.documents = docs;
  renderSacramental(prog);
}

async function toggleSacDoc(prog, id, idx) {
  const cfg = SACRAMENTAL_CFG[prog];
  const item = sacData[prog].find(i => i.id===id);
  if(!item) return;
  const docs = JSON.parse(JSON.stringify(item.documents||[]));
  docs[idx].done = !docs[idx].done;
  const {error} = await sb.from(cfg.table).update({documents:docs,updated_at:new Date().toISOString()}).eq('id',id);
  if(error){console.error('[sacramental] toggleDoc error:', error);return;}
  item.documents = docs;
  renderSacramental(prog);
}

async function deleteSacDoc(prog, id, idx) {
  const cfg = SACRAMENTAL_CFG[prog];
  const item = sacData[prog].find(i => i.id===id);
  if(!item||!confirm(`Delete "${item.documents[idx].name}"?`)) return;
  const docs = JSON.parse(JSON.stringify(item.documents||[]));
  docs.splice(idx,1);
  const {error} = await sb.from(cfg.table).update({documents:docs,updated_at:new Date().toISOString()}).eq('id',id);
  if(error){console.error('[sacramental] deleteDoc error:', error);alert('Delete failed: '+error.message);return;}
  item.documents = docs;
  renderSacramental(prog);
}

function toggleSacTlForm(prog, id) {const f=document.getElementById('sac-tl-form-'+id);if(!f)return;f.style.display=f.style.display==='none'?'block':'none';if(f.style.display==='block')document.getElementById('sac-tl-event-'+id).focus();}

async function addSacTlEntry(prog, id) {
  const cfg = SACRAMENTAL_CFG[prog];
  const item = sacData[prog].find(i => i.id===id);
  if(!item) return;
  const date = document.getElementById('sac-tl-date-'+id).value||null;
  const event = document.getElementById('sac-tl-event-'+id).value.trim();
  if(!event){alert('Please enter a comment.');return;}
  const tl = JSON.parse(JSON.stringify(item.timeline||[]));
  tl.push({date, event});
  const {error} = await sb.from(cfg.table).update({timeline:tl,updated_at:new Date().toISOString()}).eq('id',id);
  if(error){console.error('[sacramental] addTimeline error:', error);alert('Save failed: '+error.message);return;}
  item.timeline = tl;
  renderSacramental(prog);
}

async function deleteSacTlEntry(prog, id, idx) {
  const cfg = SACRAMENTAL_CFG[prog];
  const item = sacData[prog].find(i => i.id===id);
  if(!item||!confirm('Delete this timeline entry?')) return;
  const tl = JSON.parse(JSON.stringify(item.timeline||[]));
  tl.splice(idx,1);
  const {error} = await sb.from(cfg.table).update({timeline:tl,updated_at:new Date().toISOString()}).eq('id',id);
  if(error){console.error('[sacramental] deleteTimeline error:', error);alert('Delete failed: '+error.message);return;}
  item.timeline = tl;
  renderSacramental(prog);
}

function openSacramentalModal(prog, id) {
  const cfg = SACRAMENTAL_CFG[prog];
  const item = id?sacData[prog].find(i=>i.id===id):null;
  const statusSel = cfg.statusOptions?`<label>Stage</label><select id="sac-f-status">${cfg.statusOptions.map(s=>`<option value="${s.value}"${item?.status_code===s.value?' selected':''}>${s.label}</option>`).join('')}</select>`:'';
  const extraInputs = cfg.extraFields.map(f => {
    if(f.type==='select') {
      const opts = f.options.map(o=>`<option${item&&item[f.id]===o?' selected':''}>${o}</option>`).join('');
      return `<label>${f.label}</label><select id="sac-f-${f.id}">${opts}</select>`;
    }
    return `<label>${f.label}</label><input id="sac-f-${f.id}" value="${item?item[f.id]||'':''}" />`;
  }).join('');
  const dateField = 'sacrament_date';
  document.getElementById('modal-content').innerHTML = `
    <div class="modal-title">${item?'Edit — '+item.name:'Add — '+cfg.nameLabel}</div>
    <label>${cfg.nameLabel}</label><input id="sac-f-name" value="${item?.name||''}" />
    <label>${cfg.dateLabel}</label><input type="date" id="sac-f-date" value="${item?item[dateField]||'':''}" />
    ${statusSel}
    ${extraInputs}
    <label>Notes</label><textarea id="sac-f-notes">${item?.notes||''}</textarea>
    <label><input type="checkbox" id="sac-f-arch" ${item?.archived?'checked':''} style="margin-right:6px;">Archived</label>
    <div class="modal-actions" style="justify-content:space-between;">
      ${item?`<button class="btn-delete" onclick="deleteSacramental('${prog}','${item.id}')">Delete</button>`:'<span></span>'}
      <div style="display:flex;gap:8px;">
        <button class="btn-secondary" onclick="closeModal()">Cancel</button>
        <button class="btn-primary" onclick="saveSacramental('${prog}',${item?`'${item.id}'`:null})">Save</button>
      </div>
    </div>`;
  document.getElementById('modal-overlay').classList.add('open');
}

async function saveSacramental(prog, id) {
  const cfg = SACRAMENTAL_CFG[prog];
  const name = document.getElementById('sac-f-name').value.trim();
  if(!name){alert('Name is required.');return;}
  const payload = {
    name,
    sacrament_date:document.getElementById('sac-f-date').value||null,
    notes:document.getElementById('sac-f-notes').value.trim(),
    archived:document.getElementById('sac-f-arch').checked,
    updated_at:new Date().toISOString(),
  };
  if(cfg.statusOptions) payload.status_code = document.getElementById('sac-f-status').value;
  cfg.extraFields.forEach(f => {const el=document.getElementById('sac-f-'+f.id);if(el)payload[f.id]=el.value.trim()||null;});
  let err;
  if(id) {
    const r = await sb.from(cfg.table).update(payload).eq('id',id); err = r.error;
  } else {
    payload.documents = [];
    payload.timeline = [{date:todayCST(), event:'Record created'}];
    const r = await sb.from(cfg.table).insert(payload); err = r.error;
  }
  if(err){console.error('[sacramental] save error:', err);alert('Save failed: '+err.message);return;}
  if (!id && prog === 'baptism') {
    const { data: { user: _me } } = await sb.auth.getUser();
    const _uids = await getUserIdsForSacrament('baptism');
    notifyUsers(_uids, _me?.id, `New baptismal prep child added: ${name}`, 'info', 'baptism');
  }
  closeModal();
  loadSacramental(prog);
}

async function deleteSacramental(prog, id) {
  const cfg = SACRAMENTAL_CFG[prog];
  if(!confirm('Permanently delete this record? This cannot be undone.')) return;
  const {error} = await sb.from(cfg.table).delete().eq('id',id);
  if(error){console.error('[sacramental] delete error:', error);alert('Delete failed: '+error.message);return;}
  closeModal();
  loadSacramental(prog);
}

function sacToggleOne(prog, id, checked) {
  if (checked) sacSelected[prog].add(id);
  else sacSelected[prog].delete(id);
  // Update select-all checkbox without full re-render
  const cfg = SACRAMENTAL_CFG[prog];
  const items = sacData[prog].filter(i => !i.archived);
  const allChecked = items.length > 0 && items.every(i => sacSelected[prog].has(i.id));
  const allCb = document.getElementById(`sac-sel-all-${prog}`);
  if (allCb) allCb.checked = allChecked;
  _renderSacBulkBar(prog);
}

function sacToggleAll(prog, checked) {
  const cfg = SACRAMENTAL_CFG[prog];
  const q = (document.getElementById(cfg.searchEl)?.value||'').toLowerCase();
  const f = sacFilter[prog];
  sacData[prog].filter(i => {
    const matchQ = !q||(i.name||'').toLowerCase().includes(q);
    let matchF = true;
    if(f==='active') matchF = !i.archived;
    else if(f==='archived') matchF = i.archived;
    return matchQ && matchF;
  }).forEach(i => { if(checked) sacSelected[prog].add(i.id); else sacSelected[prog].delete(i.id); });
  document.querySelectorAll(`.sac-sel-cb[data-prog="${prog}"]`).forEach(cb => { cb.checked = checked; });
  _renderSacBulkBar(prog);
}

function sacClearSelection(prog) {
  sacSelected[prog].clear();
  document.getElementById(`sac-bulk-bar-${prog}`)?.remove();
  renderSacramental(prog);
}

async function sacApplyBulk(prog) {
  const action = document.getElementById(`sac-bulk-action-${prog}`)?.value;
  if (!action) { alert('Select an action first.'); return; }
  const ids = [...sacSelected[prog]];
  if (!ids.length) return;
  const cfg = SACRAMENTAL_CFG[prog];
  const archived = action === 'archive';
  const { error } = await sb.from(cfg.table).update({ archived, updated_at: new Date().toISOString() }).in('id', ids);
  if (error) { console.error('[sacramental] bulkArchive error:', error); alert('Bulk update failed: ' + error.message); return; }
  ids.forEach(id => {
    const item = sacData[prog].find(i => i.id === id);
    if (item) item.archived = archived;
  });
  sacSelected[prog].clear();
  document.getElementById(`sac-bulk-bar-${prog}`)?.remove();
  updateSacramentalStats(prog);
  renderSacramental(prog);
}

Object.assign(window, {
  renderSacramental, setSacramentalFilter, toggleSacramental, quickSacramentalStatus,
  toggleSacNoteForm, appendSacNote, deleteSacNote,
  toggleSacDocForm, addSacDoc, toggleSacDoc, deleteSacDoc,
  toggleSacTlForm, addSacTlEntry, deleteSacTlEntry,
  openSacramentalModal, saveSacramental, deleteSacramental,
  sacToggleOne, sacToggleAll, sacClearSelection, sacApplyBulk,
});
