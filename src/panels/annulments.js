import { sb } from '../supabase.js';
import { createNotification, notifyUsers, getUserIdsForSacrament } from '../notifications.js';
import { store } from '../store.js';
import { fmtDate, todayCST } from '../utils.js';

export const CASE_STATUS = {
  prep:     {label:'Preparing',               color:'#1B4F72', bg:'#D6EAF8', dot:'#1B4F72'},
  tribunal: {label:'In Tribunal',             color:'#7D6608', bg:'#FEF9E7', dot:'#D4AC0D'},
  affirm:   {label:'Affirmative Judgement',   color:'#2D6A4F', bg:'#D8F3DC', dot:'#2D6A4F'},
  negative: {label:'Negative Judgement',      color:'#922B21', bg:'#FDEDEC', dot:'#E74C3C'},
  archived: {label:'Inactive',                color:'#616A6B', bg:'#F2F3F4', dot:'#AAB7B8'},
};

let allCases = [], caseFilter = 'all', expandedCaseId = null;

function setCaseFilter(f, el) {
  caseFilter = f;
  document.querySelectorAll('#panel-annulments .cf-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  renderCases();
}

export async function loadCases() {
  const {data, error} = await sb.from('annulment_cases').select('*');
  if(!error && data) {
    const order = {affirm:0,negative:1,tribunal:2,prep:3,archived:4};
    data.sort((a,b) => (order[a.status_code]??5)-(order[b.status_code]??5)||(a.sort_order||0)-(b.sort_order||0));
  }
  if(error){console.error(error);return;}
  allCases = data||[];
  store.allCases = allCases;
  updateCaseStats();
  renderAnnulmentAlerts();
  renderCases();
}

function updateCaseStats() {
  const active = allCases.filter(c => !c.archived);
  document.getElementById('stat-cases').textContent = active.length;
  document.getElementById('stat-tribunal').textContent = active.filter(c => ['tribunal','affirm','negative'].includes(c.status_code)).length;
  document.getElementById('stat-prep').textContent = active.filter(c => c.status_code==='prep').length;
}

function renderAnnulmentAlerts() {
  const c = document.getElementById('annulment-alerts');
  const needsAttn = allCases.filter(p => {
    if(p.archived) return false;
    if(p.status_code==='affirm'||p.status_code==='negative') return false;
    const docs = p.documents||[];
    return p.status_code==='prep' && docs.filter(d=>!d.done).length>0;
  });
  if(!needsAttn.length){c.innerHTML='';return;}
  c.innerHTML = `<div class="alert-strip" style="margin-bottom:1rem;flex-direction:column;align-items:flex-start;">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;"><i class="ti ti-alert-triangle" style="color:var(--gold);font-size:15px;"></i><strong style="font-size:13px;">Priority actions</strong></div>
    ${needsAttn.map(p => {
      const out = (p.documents||[]).filter(d=>!d.done).map(d=>d.name);
      return `<div style="font-size:13px;color:var(--navy);margin-bottom:3px;">· <strong>${p.petitioner}</strong> — outstanding: ${out.slice(0,3).join(', ')}${out.length>3?` +${out.length-3} more`:''}</div>`;
    }).join('')}
  </div>`;
}

function renderCases() {
  const q = (document.getElementById('case-search')?.value||'').toLowerCase();
  const items = allCases.filter(c => {
    const mf = caseFilter==='all'?true:caseFilter==='active'?!c.archived:caseFilter==='tribunal'?['tribunal','affirm','negative'].includes(c.status_code)&&!c.archived:caseFilter==='prep'?c.status_code==='prep':caseFilter==='affirm'?c.status_code==='affirm':caseFilter==='archived'?c.archived:true;
    return mf && (!q||(c.petitioner||'').toLowerCase().includes(q)||(c.respondent||'').toLowerCase().includes(q));
  });
  const el = document.getElementById('cases-list');
  if(!items.length){el.innerHTML='<div style="font-size:13px;color:#6B7280;padding:.5rem 0;">No cases match.</div>';return;}
  const activeCases = items.filter(c => !c.archived);
  const archivedCases = items.filter(c => c.archived);
  let html = activeCases.map(c => renderCaseCard(c)).join('');
  if(archivedCases.length) {
    html += `<div style="display:flex;align-items:center;gap:10px;margin:18px 0 10px;"><div style="flex:1;height:.5px;background:var(--stone);"></div><span style="font-size:11px;color:#6B7280;letter-spacing:.07em;text-transform:uppercase;font-weight:500;white-space:nowrap;">Archived</span><div style="flex:1;height:.5px;background:var(--stone);"></div></div>`;
    html += archivedCases.map(c => renderCaseCard(c)).join('');
  }
  el.innerHTML = html;
}

function renderCaseCard(c) {
  const sm = CASE_STATUS[c.status_code]||CASE_STATUS.prep;
  const docs = c.documents||[];
  const docsDone = docs.filter(d=>d.done).length;
  const progress = docs.length>0?Math.round((docsDone/docs.length)*100):null;
  const exp = expandedCaseId===c.id;

  let h = `<div id="case-card-${c.id}" class="couple-card" style="border-left:4px solid ${sm.dot};">
    <div class="couple-header" onclick="toggleCase('${c.id}')">
      <div style="flex:1;">
        <div style="display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;">
          <span class="couple-name">${c.petitioner}</span>
          ${c.type==='Briefer Process'&&c.co_petitioner
            ? `<span style="font-size:12px;color:#888;">v.</span><span style="font-size:13px;color:#1B4F72;font-style:italic;">${c.co_petitioner} <span style="font-size:11px;">(Co-Petitioner)</span></span>`
            : c.respondent
              ? `<span style="font-size:12px;color:#888;">v.</span><span style="font-size:13px;color:#555;">${c.respondent}</span>`
              : ''
          }
        </div>
        <div style="display:flex;gap:6px;margin-top:5px;flex-wrap:wrap;align-items:center;">
          <span style="background:${sm.bg};color:${sm.color};border-radius:20px;padding:2px 10px;font-size:11px;font-weight:600;letter-spacing:.04em;display:inline-flex;align-items:center;gap:5px;border:1px solid ${sm.color}33;"><span style="width:7px;height:7px;border-radius:50%;background:${sm.dot};display:inline-block;"></span>${sm.label}</span>
          <span style="font-size:11px;color:#777;background:#EFEFEF;border-radius:20px;padding:2px 8px;">${c.type||'Annulment Type Not Specified'}</span>
          ${progress!==null?(progress===100?`<span style="font-size:11px;color:#2D6A4F;">✅ docs complete</span>`:`<span style="font-size:11px;color:#922B21;">${docsDone}/${docs.length} docs</span>`):''}
          ${(()=>{const opened=(c.timeline||[]).find(e=>e.event&&e.event.toLowerCase().includes('case opened'));return opened&&opened.date?`<span style="font-size:11px;color:#AAA;">Opened ${fmtDate(opened.date)}</span>`:'';})()}
        </div>
      </div>
      <span style="font-size:16px;color:#B0A090;margin-top:2px;">${exp?'▲':'▼'}</span>
    </div>`;

  if(exp) {
    h += `<div class="couple-body">`;
    const showJudgement = c.status_code==='affirm'||c.status_code==='negative';
    if(showJudgement) {
      h += `<div style="margin-top:10px;">`;
      if(c.judgement_finalized==='yes') h += `<span class="detail-chip" style="background:#D8F3DC;color:#2D6A4F;">Judgement finalized</span>`;
      else h += `<span class="detail-chip" style="background:#FDEDEC;color:#922B21;">Judgement not yet finalized</span>`;
      h += `</div>`;
    }
    if(c.petitioner_dob) {
      h += `<div style="font-size:12.5px;color:#6B7280;margin-top:8px;">🎂 Date of birth: <strong style="color:var(--navy);">${c.petitioner_dob}</strong></div>`;
    }
    if(c.contact_phone||c.contact_email) {
      h += `<div class="couple-section-label">Petitioner contact</div>`;
      if(c.contact_phone) h += `<a href="tel:${c.contact_phone}" class="contact-chip">📞 ${c.contact_phone}</a>`;
      if(c.contact_email) h += `<a href="mailto:${c.contact_email}" class="contact-chip">✉️ ${c.contact_email}</a>`;
    }
    const _hasNotes = !!(c.notes&&c.notes.trim());
    h += `<div style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;margin-bottom:4px;">
      ${_hasNotes?`<span class="couple-section-label" style="margin:0;">Notes</span>`:'<span></span>'}
      <button onclick="toggleNoteForm('${c.id}')" style="font-size:12px;color:var(--cardinal);background:none;border:none;cursor:pointer;font-family:'Inter',sans-serif;padding:0;">+ Add note</button>
    </div>`;
    h += `<div id="note-form-${c.id}" style="display:none;margin-bottom:.5rem;">
      <textarea id="note-text-${c.id}" placeholder="Add a note…" rows="2" style="width:100%;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .75rem;font-size:13px;font-family:'Inter',sans-serif;background:#FFFFFF;outline:none;resize:vertical;margin-bottom:6px;"></textarea>
      <div style="display:flex;gap:8px;">
        <button class="btn-primary" style="padding:.35rem .9rem;font-size:12px;" onclick="appendNote('${c.id}')">Save</button>
        <button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="toggleNoteForm('${c.id}')">Cancel</button>
      </div>
    </div>`;
    if(_hasNotes) {
      const noteEntries = c.notes.split('\n\n').filter(n=>n.trim());
      h += noteEntries.map((n,i) => `<div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:6px;padding:8px 12px;background:#FFF8EE;border-left:3px solid var(--gold);border-radius:3px;">
        <div style="font-size:13px;color:#555;font-style:italic;flex:1;white-space:pre-wrap;">${n}</div>
        <button onclick="deleteCaseNote('${c.id}',${i})" title="Delete note" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:13px;padding:0;flex-shrink:0;line-height:1.4;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#CCC'">✕</button>
      </div>`).join('');
    }
    h += `<div style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;margin-bottom:4px;">
      <span class="couple-section-label" style="margin:0;">Documentation checklist</span>
      <button onclick="toggleDocForm('${c.id}')" style="font-size:12px;color:var(--cardinal);background:none;border:none;cursor:pointer;font-family:'Inter',sans-serif;padding:0;">+ Add document</button>
    </div>`;
    h += `<div id="doc-form-${c.id}" style="display:none;margin-bottom:.5rem;">
      <input type="text" id="doc-name-${c.id}" placeholder="Document name…" style="width:100%;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .75rem;font-size:13px;font-family:'Inter',sans-serif;background:#FFFFFF;outline:none;margin-bottom:6px;" />
      <div style="display:flex;gap:8px;">
        <button class="btn-primary" style="padding:.35rem .9rem;font-size:12px;" onclick="addCaseDoc('${c.id}')">Save</button>
        <button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="toggleDocForm('${c.id}')">Cancel</button>
      </div>
    </div>`;
    if(docs.length) {
      if(progress!==null) {
        h += `<div class="prog-bar-wrap"><div class="prog-bar-fill" style="width:${progress}%;background:${progress===100?'#2D6A4F':'var(--gold)'};"></div></div>`;
        h += `<div style="font-size:11px;color:#888;margin-bottom:6px;">${progress}% complete</div>`;
      }
      h += docs.map((d,i) => {
        const isBaptismal = d.name.toLowerCase().includes('baptismal')||d.name.toLowerCase().includes('baptism');
        const church = d.church||''; const city = d.city||'';
        const petDob = c.petitioner_dob||'';
        let row = `<div style="border-radius:var(--radius-sm);margin-bottom:2px;">
          <div class="doc-item" style="padding:4px 6px;transition:background .12s;" onmouseover="this.style.background='var(--parch)'" onmouseout="this.style.background='transparent'">
            <span style="font-size:15px;cursor:pointer;" onclick="toggleCaseDoc('${c.id}',${i})">${d.done?'✅':'❌'}</span>
            <span style="color:${d.done?'#2D6A4F':'#922B21'};flex:1;cursor:pointer;" onclick="toggleCaseDoc('${c.id}',${i})">${d.name}</span>
            ${isBaptismal?`<button onclick="toggleBaptismalForm('${c.id}',${i})" title="Church details" style="background:none;border:none;cursor:pointer;font-size:11px;color:var(--cardinal);padding:0 6px;font-family:'Inter',sans-serif;white-space:nowrap;">⛪ Details</button>`:''}
            <button onclick="deleteCaseDoc('${c.id}',${i})" title="Delete" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:13px;padding:0 0 0 4px;flex-shrink:0;line-height:1;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#CCC'">✕</button>
          </div>`;
        if(isBaptismal) {
          const hasDetails = church||city;
          row += `<div style="margin:2px 0 4px 28px;font-size:12px;color:#6B7280;">
            ${church?`<span style="margin-right:10px;">⛪ ${church}</span>`:''}
            ${city?`<span style="margin-right:10px;">📍 ${city}</span>`:''}
            ${petDob?`<span style="margin-right:10px;">🎂 ${petDob}</span>`:''}
            ${hasDetails?`<a href="${buildBaptismalEmail(c.petitioner,church,city,petDob)}" style="margin-left:6px;font-size:11.5px;color:var(--cardinal);font-weight:500;">✉ Request records</a>`:`<span style="color:#AAA;font-style:italic;">Enter church details below</span>`}
          </div>`;
          row += `<div id="baptismal-form-${c.id}-${i}" style="display:none;margin:4px 0 6px 28px;background:var(--parch);border:.5px solid var(--stone);border-radius:var(--radius-sm);padding:.625rem;">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px;">
              <input type="text" placeholder="Church name" value="${church}" id="b-church-${c.id}-${i}" style="border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.35rem .6rem;font-size:12.5px;font-family:'Inter',sans-serif;background:#FFFFFF;outline:none;" />
              <input type="text" placeholder="City, State" value="${city}" id="b-city-${c.id}-${i}" style="border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.35rem .6rem;font-size:12.5px;font-family:'Inter',sans-serif;background:#FFFFFF;outline:none;" />
            </div>
            <div style="display:flex;gap:6px;">
              <button class="btn-primary" style="padding:.3rem .8rem;font-size:12px;" onclick="saveBaptismalDetails('${c.id}',${i})">Save</button>
              <button class="btn-secondary" style="padding:.3rem .8rem;font-size:12px;" onclick="toggleBaptismalForm('${c.id}',${i})">Cancel</button>
            </div>
          </div>`;
        }
        row += `</div>`;
        return row;
      }).join('');
    }
    const tl = c.timeline||[];
    h += `<div style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;margin-bottom:4px;">
      <span class="couple-section-label" style="margin:0;">Tribunal timeline</span>
      <button onclick="toggleTlForm('${c.id}')" style="font-size:12px;color:var(--cardinal);background:none;border:none;cursor:pointer;font-family:'Inter',sans-serif;padding:0;">+ Add update</button>
    </div>`;
    h += `<div id="tl-form-${c.id}" style="display:none;background:var(--parch);border:.5px solid var(--stone);border-radius:var(--radius-sm);padding:.75rem;margin-bottom:.75rem;">
      <input type="date" id="tl-date-${c.id}" value="${todayCST()}" style="width:100%;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .75rem;font-size:13px;font-family:'Inter',sans-serif;background:#FFFFFF;outline:none;margin-bottom:6px;" />
      <input type="text" id="tl-event-${c.id}" placeholder="Update comment…" style="width:100%;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .75rem;font-size:13px;font-family:'Inter',sans-serif;background:#FFFFFF;outline:none;margin-bottom:6px;" />
      <div style="display:flex;gap:8px;">
        <button class="btn-primary" style="padding:.35rem .9rem;font-size:12px;" onclick="addTlEntry('${c.id}')">Save</button>
        <button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="toggleTlForm('${c.id}')">Cancel</button>
      </div>
    </div>`;
    if(tl.length) {
      h += `<div class="tl-wrap">`;
      h += tl.map((e,i) => `<div class="tl-item" style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
        <div style="flex:1;">
          <div class="tl-dot"></div>
          ${e.date?`<div class="tl-date">${fmtDate(e.date)}</div>`:''}
          <div class="tl-event">${e.event}</div>
        </div>
        <button onclick="deleteTlEntry('${c.id}',${i})" title="Delete" style="background:none;border:none;cursor:pointer;color:#AAA;font-size:14px;padding:0;flex-shrink:0;line-height:1;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#AAA'">✕</button>
      </div>`).join('');
      h += `</div>`;
    } else {
      h += `<div style="font-size:13px;color:#6B7280;font-style:italic;padding:.25rem 0;">No timeline entries yet.</div>`;
    }
    if(c.updated_at) {
      const upd = new Date(c.updated_at);
      const now = new Date(new Date().toLocaleString('en-US',{timeZone: store.parishSettings?.timezone || 'America/Chicago'}));
      const daysSince = Math.floor((now-upd)/86400000);
      const updStr = upd.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
      let agingChip = '';
      if(daysSince>=60&&!c.archived&&c.status_code==='prep') {
        agingChip = `<span style="font-size:11px;background:#FDF8EE;color:#854F0B;border-radius:20px;padding:2px 9px;margin-left:8px;">Inactive ${daysSince} days</span>`;
      }
      h += `<div style="font-size:11px;color:#AAA;margin-top:10px;margin-bottom:8px;">Last updated: ${updStr}${agingChip}</div>`;
    }
    h += `<div style="margin-top:4px;"><button class="btn-primary" onclick="openCaseEdit('${c.id}')">Edit</button></div>`;
    h += `</div>`;
  }
  h += `</div>`;
  return h;
}

function toggleCase(id) {expandedCaseId=expandedCaseId===id?null:id;renderCases();}

// Called from other panels (e.g. OCIA) to navigate to and expand a specific case
export async function expandCase(id) {
  console.log('[expandCase] called with id:', id, 'expandedCaseId set to:', id);
  expandedCaseId = id;
  console.log('[expandCase] calling switchPanel, window.switchPanel=', typeof window.switchPanel);
  window.switchPanel('annulments');
  console.log('[expandCase] awaiting loadCases');
  await loadCases();
  const card = document.getElementById('case-card-' + id);
  console.log('[expandCase] card element:', card);
  card?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function quickStatusChange(caseId, newStatus) {
  const cas = allCases.find(c => c.id===caseId);
  if(!cas||cas.status_code===newStatus) return;
  const {error} = await sb.from('annulment_cases').update({status_code:newStatus,updated_at:new Date().toISOString()}).eq('id',caseId);
  if(error){alert('Save failed: '+error.message);return;}
  cas.status_code = newStatus;
  updateCaseStats();
  renderAnnulmentAlerts();
  renderCases();
}

function toggleTlForm(caseId) {
  const f = document.getElementById('tl-form-'+caseId);
  if(!f) return;
  f.style.display = f.style.display==='none'?'block':'none';
  if(f.style.display==='block') document.getElementById('tl-event-'+caseId).focus();
}

async function addTlEntry(caseId) {
  const cas = allCases.find(c => c.id===caseId);
  if(!cas) return;
  const date = document.getElementById('tl-date-'+caseId).value||null;
  const event = document.getElementById('tl-event-'+caseId).value.trim();
  if(!event){alert('Please enter a comment.');return;}
  const tl = JSON.parse(JSON.stringify(cas.timeline||[]));
  tl.push({date, event});
  const {error} = await sb.from('annulment_cases').update({timeline:tl,updated_at:new Date().toISOString()}).eq('id',caseId);
  if(error){alert('Save failed: '+error.message);return;}
  cas.timeline = tl;
  renderCases();
}

async function deleteTlEntry(caseId, index) {
  const cas = allCases.find(c => c.id===caseId);
  if(!cas) return;
  if(!confirm('Delete this timeline entry?')) return;
  const tl = JSON.parse(JSON.stringify(cas.timeline||[]));
  tl.splice(index,1);
  const {error} = await sb.from('annulment_cases').update({timeline:tl,updated_at:new Date().toISOString()}).eq('id',caseId);
  if(error){alert('Delete failed: '+error.message);return;}
  cas.timeline = tl;
  renderCases();
}

function openCaseEdit(id) {
  const c = allCases.find(p => p.id===id);
  if(c){document.getElementById('modal-content').innerHTML=caseForm(c);document.getElementById('modal-overlay').classList.add('open');}
}

function onCaseTypeChange(val) {
  const label = document.getElementById('f-res-label');
  if(!label) return;
  label.textContent = val==='Briefer Process'?'Co-petitioner':'Respondent';
}

function onCaseStatusChange(val) {
  const wrap = document.getElementById('f-jf-wrap');
  if(!wrap) return;
  wrap.style.display = (val==='affirm'||val==='negative') ? 'block' : 'none';
}

async function toggleCaseDoc(caseId, docIndex) {
  const cas = allCases.find(c => c.id===caseId);
  if(!cas) return;
  const docs = JSON.parse(JSON.stringify(cas.documents||[]));
  docs[docIndex].done = !docs[docIndex].done;
  const {error} = await sb.from('annulment_cases').update({documents:docs,updated_at:new Date().toISOString()}).eq('id',caseId);
  if(error){console.error(error);return;}
  cas.documents = docs;
  renderCases();
}

async function deleteCaseDoc(caseId, docIndex) {
  const cas = allCases.find(c => c.id===caseId);
  if(!cas) return;
  if(!confirm(`Delete "${cas.documents[docIndex].name}"?`)) return;
  const docs = JSON.parse(JSON.stringify(cas.documents||[]));
  docs.splice(docIndex,1);
  const {error} = await sb.from('annulment_cases').update({documents:docs,updated_at:new Date().toISOString()}).eq('id',caseId);
  if(error){alert('Delete failed: '+error.message);return;}
  cas.documents = docs;
  renderCases();
}

async function deleteCaseNote(caseId, noteIndex) {
  const cas = allCases.find(c => c.id===caseId);
  if(!cas) return;
  if(!confirm('Delete this note?')) return;
  const entries = cas.notes.split('\n\n').filter(n=>n.trim());
  entries.splice(noteIndex,1);
  const newNotes = entries.join('\n\n');
  const {error} = await sb.from('annulment_cases').update({notes:newNotes,updated_at:new Date().toISOString()}).eq('id',caseId);
  if(error){alert('Delete failed: '+error.message);return;}
  cas.notes = newNotes;
  renderCases();
}

export function buildBaptismalEmail(petitioner, church, city, dob) {
  const internal = ['basilica of saint mary','assumption catholic church'];
  const isInternal = church&&internal.some(n=>church.toLowerCase().includes(n));
  const verb = isInternal?'make a baptismal certificate for':'request baptismal records for';
  const bodyText = 'Please '+verb+' '+petitioner+' from '+(church||'[church name]')+' in '+(city||'[city, state]')+'. The date of birth is: '+(dob||'[date of birth]')+'.\n\nThank you,\nFr. Aaron';
  return 'mailto:secretary@stmarybasilica.org?subject='+encodeURIComponent('Baptismal Record Request')+'&body='+encodeURIComponent(bodyText);
}

function toggleBaptismalForm(caseId, docIndex) {
  const f = document.getElementById(`baptismal-form-${caseId}-${docIndex}`);
  if(!f) return;
  f.style.display = f.style.display==='none'?'block':'none';
  if(f.style.display==='block') document.getElementById(`b-church-${caseId}-${docIndex}`).focus();
}

async function saveBaptismalDetails(caseId, docIndex) {
  const cas = allCases.find(c => c.id===caseId);
  if(!cas) return;
  const church = document.getElementById(`b-church-${caseId}-${docIndex}`).value.trim();
  const city = document.getElementById(`b-city-${caseId}-${docIndex}`).value.trim();
  const docs = JSON.parse(JSON.stringify(cas.documents||[]));
  docs[docIndex] = {...docs[docIndex], church, city};
  const {error} = await sb.from('annulment_cases').update({documents:docs,updated_at:new Date().toISOString()}).eq('id',caseId);
  if(error){alert('Save failed: '+error.message);return;}
  cas.documents = docs;
  renderCases();
  requestAnimationFrame(() => {
    const f = document.getElementById(`baptismal-form-${caseId}-${docIndex}`);
    if(f) {
      f.style.display = 'block';
      const btn = f.querySelector('.btn-primary');
      if(btn){btn.textContent='Saved ✓';btn.style.background='#2D6A4F';setTimeout(()=>{btn.textContent='Save';btn.style.background='';},1800);}
    }
  });
}

function toggleDocForm(caseId) {
  const f = document.getElementById('doc-form-'+caseId);
  if(!f) return;
  f.style.display = f.style.display==='none'?'block':'none';
  if(f.style.display==='block') document.getElementById('doc-name-'+caseId).focus();
}

async function addCaseDoc(caseId) {
  const cas = allCases.find(c => c.id===caseId);
  if(!cas) return;
  const name = document.getElementById('doc-name-'+caseId).value.trim();
  if(!name){alert('Please enter a document name.');return;}
  const docs = JSON.parse(JSON.stringify(cas.documents||[]));
  docs.push({name, done:false});
  const {error} = await sb.from('annulment_cases').update({documents:docs,updated_at:new Date().toISOString()}).eq('id',caseId);
  if(error){alert('Save failed: '+error.message);return;}
  cas.documents = docs;
  renderCases();
}

function toggleNoteForm(caseId) {
  const f = document.getElementById('note-form-'+caseId);
  if(!f) return;
  f.style.display = f.style.display==='none'?'block':'none';
  if(f.style.display==='block') document.getElementById('note-text-'+caseId).focus();
}

async function appendNote(caseId) {
  const cas = allCases.find(c => c.id===caseId);
  if(!cas) return;
  const addition = document.getElementById('note-text-'+caseId).value.trim();
  if(!addition){alert('Please enter a note.');return;}
  const now = new Date(new Date().toLocaleString('en-US',{timeZone: store.parishSettings?.timezone || 'America/Chicago'}));
  const dateStr = `${now.getMonth()+1}/${now.getDate()}/${now.getFullYear()}`;
  const newNotes = cas.notes?`${cas.notes}\n\n[${dateStr}] ${addition}`:`[${dateStr}] ${addition}`;
  const {error} = await sb.from('annulment_cases').update({notes:newNotes,updated_at:new Date().toISOString()}).eq('id',caseId);
  if(error){alert('Save failed: '+error.message);return;}
  cas.notes = newNotes;
  renderCases();
}

export function caseForm(data) {
  const statuses = Object.entries(CASE_STATUS).map(([k,v]) => `<option value="${k}"${data?.status_code===k?' selected':''}>${v.label}</option>`).join('');
  const types = ['Formal Case','Lack of Form','Petrine Privilege','Pauline Privilege','Briefer Process'];
  const typeOpts = types.map(t => `<option value="${t}"${data?.type===t?' selected':''}>${t}</option>`).join('');
  const isBriefer = data?.type==='Briefer Process';
  return `<div class="modal-title">${data?'Edit — '+data.petitioner:'Add case'}</div>
  <label>Petitioner</label><input id="f-pet" value="${data?.petitioner||''}" />
  <label>Petitioner date of birth</label><input type="text" id="f-dob" value="${data?.petitioner_dob||''}" placeholder="e.g. 15 Mar 1985" />
  <label id="f-res-label">${isBriefer?'Co-petitioner':'Respondent'}</label><input id="f-res" value="${isBriefer?(data?.co_petitioner||''):(data?.respondent||'')}" />
  <label>Type</label>
  <select id="f-type" onchange="onCaseTypeChange(this.value)">
    <option value="">— Select type —</option>
    ${typeOpts}
  </select>
  <label>Status</label><select id="f-sc" onchange="onCaseStatusChange(this.value)">${statuses}</select>
  <div id="f-jf-wrap" style="display:${(data?.status_code==='affirm'||data?.status_code==='negative')?'block':'none'};">
  <label>Judgement finalized</label>
  <select id="f-jf">
    <option value="no"${!data?.judgement_finalized||data?.judgement_finalized==='no'?' selected':''}>No</option>
    <option value="yes"${data?.judgement_finalized==='yes'?' selected':''}>Yes</option>
  </select>
  </div>
  <label>Contact phone</label><input id="f-cp" value="${data?.contact_phone||''}" />
  <label>Contact email</label><input id="f-ce" value="${data?.contact_email||''}" />
  <label>Notes</label><textarea id="f-notes">${data?.notes||''}</textarea>
  <label><input type="checkbox" id="f-arch" ${data?.archived?'checked':''} style="margin-right:6px;">Archived</label>
  <div class="modal-actions" style="justify-content:space-between;">
    ${data?`<button class="btn-delete" onclick="deleteCase('${data.id}')">Delete</button>`:'<span></span>'}
    <div style="display:flex;gap:8px;">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" onclick="saveCase(${data?`'${data.id}'`:null})">Save</button>
    </div>
  </div>`;
}

async function deleteCase(id) {
  if(!confirm('Permanently delete this case? This cannot be undone.')) return;
  const {error} = await sb.from('annulment_cases').delete().eq('id',id);
  if(error){alert('Delete failed: '+error.message);return;}
  closeModal(); loadCases();
}

async function saveCase(id) {
  const payload = {
    petitioner:document.getElementById('f-pet').value.trim(),
    petitioner_dob:document.getElementById('f-dob').value.trim()||null,
    respondent:document.getElementById('f-type').value==='Briefer Process'?null:document.getElementById('f-res').value.trim(),
    co_petitioner:document.getElementById('f-type').value==='Briefer Process'?document.getElementById('f-res').value.trim()||null:null,
    type:document.getElementById('f-type').value||null,
    status_code:document.getElementById('f-sc').value,
    judgement_finalized:document.getElementById('f-jf').value,
    contact_phone:document.getElementById('f-cp').value.trim()||null,
    contact_email:document.getElementById('f-ce').value.trim()||null,
    notes:document.getElementById('f-notes').value.trim(),
    archived:document.getElementById('f-arch').checked,
    updated_at:new Date().toISOString()
  };
  if(!payload.petitioner){alert('Petitioner name is required.');return;}
  let err;
  if(id) {
    const r = await sb.from('annulment_cases').update(payload).eq('id',id);
    err = r.error;
  } else {
    const today = new Date(new Date().toLocaleString('en-US',{timeZone: store.parishSettings?.timezone || 'America/Chicago'}));
    const dateStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
    payload.timeline = [{date:dateStr, event:'Case opened'}];
    const baseDocs = [
      {name:'Completed Petition',done:false},
      {name:'Baptismal Records',done:false},
      {name:'Marriage License',done:false},
      {name:'Divorce Decree',done:false},
    ];
    if(payload.type!=='Lack of Form') baseDocs.push({name:'Personal Testimony',done:false});
    payload.documents = baseDocs;
    const r = await sb.from('annulment_cases').insert(payload);
    err = r.error;
  }
  if(err){alert('Save failed: '+err.message);return;}
  if(id && payload.status_code==='affirm' && payload.judgement_finalized==='yes') {
    const prior = allCases.find(c=>c.id===id);
    const wasAlreadyFinal = prior?.status_code==='affirm' && prior?.judgement_finalized==='yes';
    console.log('[annulments] affirm+finalized save — wasAlreadyFinal:', wasAlreadyFinal, '| prior:', prior?.status_code, prior?.judgement_finalized);
    if(!wasAlreadyFinal) {
      const resp = payload.respondent ? ` v. ${payload.respondent}` : '';
      const { data: { user: _me } } = await sb.auth.getUser();
      const _uids = await getUserIdsForSacrament('annulments');
      notifyUsers(_uids, _me?.id, `Annulment rendered final judgment: ${payload.petitioner}${resp}`, 'success', 'annulments', id);
    }
  }
  closeModal(); loadCases();
}

Object.assign(window, {
  renderCases, setCaseFilter, toggleCase, quickStatusChange,
  toggleTlForm, addTlEntry, deleteTlEntry,
  openCaseEdit, onCaseTypeChange, onCaseStatusChange, toggleCaseDoc, deleteCaseDoc,
  deleteCaseNote, buildBaptismalEmail, toggleBaptismalForm, saveBaptismalDetails,
  toggleDocForm, addCaseDoc, toggleNoteForm, appendNote,
  saveCase, deleteCase,
});
