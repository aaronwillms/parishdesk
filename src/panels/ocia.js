import { sb } from '../supabase.js';
import { store } from '../store.js';
import { fmtDate, todayCST } from '../utils.js';
import { CASE_STATUS, expandCase } from './annulments.js';
import { createNotification } from '../notifications.js';

const OCIA_STATUS = {
  inquirer:    {label:'Inquirer',                color:'#4A1D96', bg:'#EDE9FE', dot:'#7C3AED'},
  preparation: {label:'In Preparation',          color:'#7D6608', bg:'#FEF9E7', dot:'#D4AC0D'},
  complete:    {label:'Completed Preparation',   color:'#2D6A4F', bg:'#D8F3DC', dot:'#2D6A4F'},
  received:    {label:'Received',                color:'#1B4F72', bg:'#D6EAF8', dot:'#1B4F72'},
  inactive:    {label:'Inactive',                color:'#616A6B', bg:'#F2F3F4', dot:'#AAB7B8'},
};

let allOcia = [];
let ociaFilter = 'all';
let ociaExpanded = null;

// Anonymous Gregorian algorithm for Easter Sunday
function easterDate(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day   = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function nextEaster() {
  const today = new Date(new Date().toLocaleString('en-US', {timeZone: 'America/Chicago'}));
  const yr = today.getFullYear();
  const e = easterDate(yr);
  return today <= e ? e : easterDate(yr + 1);
}

function fmtEasterChip(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', {month: 'long', day: 'numeric', year: 'numeric'});
}

function setOciaFilter(f, el) {
  ociaFilter = f;
  document.querySelectorAll('#panel-ocia .cf-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  renderOcia();
}

export async function loadOcia() {
  const {data, error} = await sb.from('sacramental_ocia').select('*').order('created_at',{ascending:false});
  if(error){console.error('OCIA load error:',error.message);return;}
  allOcia = data||[];
  updateOciaStats();
  renderOciaAlerts();
  renderOcia();
}

function updateOciaStats() {
  const active = allOcia.filter(p => !p.archived&&p.status_code!=='inactive');
  document.getElementById('stat-ocia-total').textContent = active.length;
  document.getElementById('stat-ocia-prep').textContent = active.filter(p => p.status_code==='preparation'||p.status_code==='complete').length;
  const yr = new Date().getFullYear();
  document.getElementById('stat-ocia-received').textContent = allOcia.filter(p => p.status_code==='received'&&p.reception_date&&p.reception_date.startsWith(yr)).length;
}

function ociaAge(dob) {
  if(!dob) return null;
  const d = new Date(dob);
  if(isNaN(d)) return null;
  const now = new Date(new Date().toLocaleString('en-US',{timeZone:'America/Chicago'}));
  let age = now.getFullYear()-d.getFullYear();
  const m = now.getMonth()-d.getMonth();
  if(m<0||(m===0&&now.getDate()<d.getDate())) age--;
  return age;
}

function caseIsConfirmed(caseId) {
  if(!caseId) return false;
  const c = store.allCases.find(c => c.id===caseId);
  return !!(c && c.status_code==='affirm' && c.judgement_finalized==='yes');
}

function pmIsResolved(m) {
  return m.annulment_granted || caseIsConfirmed(m.annulment_case_id);
}

function ociaHasAnnulmentIssue(person) {
  const pm = person.prior_marriages||[];
  if(person.marriage_status==='married'&&person.remarried&&pm.some(m=>!pmIsResolved(m))) return true;
  if(person.marriage_status==='divorced'&&pm.some(m=>!pmIsResolved(m))) return true;
  return false;
}

function ociaIsMinor(person) {
  const age = ociaAge(person.dob);
  return age!==null&&age<18;
}

function oiciaPossibleCases(person) {
  if(!person.name) return [];
  const parts = person.name.toLowerCase().split(' ');
  return store.allCases.filter(c => {
    const pet = (c.petitioner||'').toLowerCase();
    return parts.some(p => p.length>2&&pet.includes(p));
  });
}

function renderOciaAlerts() {
  const el = document.getElementById('ocia-alerts');
  if(!el) return;
  const flags = allOcia.filter(p => {
    if(p.archived||p.status_code==='inactive') return false;
    if(ociaHasAnnulmentIssue(p)) return true;
    if(ociaIsMinor(p)&&!p.parental_consent) return true;
    return false;
  });
  if(!flags.length){el.innerHTML='';return;}
  el.innerHTML = `<div class="alert-strip" style="margin-bottom:1rem;flex-direction:column;align-items:flex-start;">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;"><i class="ti ti-alert-triangle" style="color:var(--gold);font-size:15px;"></i><strong style="font-size:13px;">Attention required</strong></div>
    ${flags.map(p => {
      const age = ociaAge(p.dob);
      const reasons = [];
      if(ociaHasAnnulmentIssue(p)) reasons.push('annulment needed');
      if(ociaIsMinor(p)&&!p.parental_consent) reasons.push('parental consent outstanding');
      return `<div style="font-size:13px;color:var(--navy);margin-bottom:3px;">· <strong>${p.name}${age!==null?' ('+age+')':''}</strong> — ${reasons.join(', ')}</div>`;
    }).join('')}
  </div>`;
}

function renderOcia() {
  const q = (document.getElementById('ocia-search')?.value||'').toLowerCase();
  const items = allOcia.filter(p => {
    const mf = ociaFilter==='all'?true:p.status_code===ociaFilter;
    return mf&&(!q||(p.name||'').toLowerCase().includes(q));
  });
  const el = document.getElementById('ocia-list');
  if(!items.length){el.innerHTML='<div style="font-size:13px;color:#6B7280;padding:.5rem 0;">No records found.</div>';return;}
  const activeOcia = items.filter(p => !p.archived);
  const archivedOcia = items.filter(p => p.archived);
  let html = activeOcia.map(p => renderOciaCard(p)).join('');
  if(archivedOcia.length) {
    html += `<div style="display:flex;align-items:center;gap:10px;margin:18px 0 10px;"><div style="flex:1;height:.5px;background:var(--stone);"></div><span style="font-size:11px;color:#6B7280;letter-spacing:.07em;text-transform:uppercase;font-weight:500;white-space:nowrap;">Archived</span><div style="flex:1;height:.5px;background:var(--stone);"></div></div>`;
    html += archivedOcia.map(p => renderOciaCard(p)).join('');
  }
  el.innerHTML = html;
}

function renderOciaCard(person) {
  const sm = OCIA_STATUS[person.status_code]||OCIA_STATUS.inquirer;
  const age = ociaAge(person.dob);
  const hasAnnulmentIssue = ociaHasAnnulmentIssue(person);
  const isMinorNoConsent = ociaIsMinor(person)&&!person.parental_consent;
  const flagged = hasAnnulmentIssue||isMinorNoConsent;
  const exp = ociaExpanded===person.id;
  const docs = person.documents||[];
  const docsDone = docs.filter(d=>d.done).length;
  const progress = docs.length>0?Math.round((docsDone/docs.length)*100):null;

  const notActiveLabel = person.status_code==='inquirer'||person.status_code==='inactive';
  const roleLabel = !notActiveLabel?(person.baptismal_status==='unbaptized'?'Catechumen':'Candidate for Full Communion'):null;

  let h = `<div class="couple-card${flagged?' urgent':''}" style="border-left:4px solid ${sm.dot};">
    <div class="couple-header" onclick="toggleOcia('${person.id}')">
      <div style="flex:1;">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span class="couple-name">${person.name||'—'}${age!==null?` <span style="font-size:12px;color:#6B7280;font-weight:400;">(${age})</span>`:''}</span>
        </div>
        <div style="display:flex;gap:6px;margin-top:5px;flex-wrap:wrap;align-items:center;">
          <span style="background:${sm.bg};color:${sm.color};border-radius:20px;padding:2px 10px;font-size:11px;font-weight:600;letter-spacing:.04em;display:inline-flex;align-items:center;gap:5px;border:1px solid ${sm.color}33;"><span style="width:7px;height:7px;border-radius:50%;background:${sm.dot};display:inline-block;"></span>${sm.label}</span>
          ${roleLabel?`<span style="font-size:11px;color:#1B4F72;background:#D6EAF8;border-radius:20px;padding:2px 8px;">${roleLabel}</span>`:''}
          ${person.preparation_type==='special'?`<span style="font-size:11px;background:#FEF9E7;color:#7D6608;border-radius:20px;padding:2px 8px;">Special preparation</span>`:person.preparation_type==='enrolled'&&person.status_code==='preparation'?`<span style="font-size:11px;background:#FEF9E7;color:#7D6608;border-radius:20px;padding:2px 8px;">Enrolled in OCIA class</span>`:''}
          ${progress!==null?(progress===100?'<span style="font-size:11px;color:#2D6A4F;">✅ docs complete</span>':`<span style="font-size:11px;color:#922B21;">${docsDone}/${docs.length} docs</span>`):''}
          ${(()=>{
            if(person.reception_date_type==='easter'&&person.reception_date) {
              const yr = new Date(person.reception_date+'T00:00:00').getFullYear();
              return `<span style="font-size:11px;background:#FEF9E7;color:#7D6608;border-radius:20px;padding:2px 8px;">🕊 Easter ${yr}</span>`;
            }
            if(person.reception_date_type==='custom'&&person.reception_date) {
              return `<span style="font-size:11px;background:#FEF9E7;color:#7D6608;border-radius:20px;padding:2px 8px;">🕊 ${fmtEasterChip(person.reception_date)}</span>`;
            }
            return '';
          })()}
        </div>
        ${(()=>{
          const flags=[];
          const pm=person.prior_marriages||[];
          pm.forEach(m=>{if(!pmIsResolved(m)&&m.ex_name) flags.push(`<div style="margin-top:5px;background:#FDEDEC;border-left:3px solid #E74C3C;border-radius:3px;padding:4px 10px;font-size:12px;font-weight:600;color:#922B21;">❗ Annulment needed — ${m.ex_name}</div>`);});
          if(ociaIsMinor(person)&&!person.parental_consent) flags.push(`<div style="margin-top:5px;background:#FEF9E7;border-left:3px solid #D4AC0D;border-radius:3px;padding:4px 10px;font-size:12px;font-weight:600;color:#7D6608;">⚠ Parental consent outstanding</div>`);
          return flags.join('');
        })()}
      </div>
      <span style="font-size:16px;color:#B0A090;">${exp?'▲':'▼'}</span>
    </div>`;

  if(exp) {
    h += `<div class="couple-body">`;
    h += `<div style="margin-top:10px;">`;
    if(person.dob) h += `<span class="detail-chip">🎂 ${person.dob}</span>`;
    if(person.place_of_birth) h += `<span class="detail-chip">📍 ${person.place_of_birth}</span>`;
    if(person.marriage_status) h += `<span class="detail-chip">${{single:'Single',married:'Married',divorced:'Divorced'}[person.marriage_status]||person.marriage_status}</span>`;
    h += `</div>`;

    if(person.phone||person.email) {
      h += `<div style="margin-top:8px;">`;
      if(person.phone) h += `<a href="tel:${person.phone}" class="contact-chip">📞 ${person.phone}</a>`;
      if(person.email) h += `<a href="mailto:${person.email}" class="contact-chip">✉️ ${person.email}</a>`;
      h += `</div>`;
    }

    const pm = person.prior_marriages||[];
    if(pm.length||person.spouse_name) {
      h += `<div class="couple-section-label">Marriage history</div>`;
      if(person.marriage_status==='married'&&person.spouse_name) {
        h += `<div style="font-size:13px;margin-bottom:4px;">Spouse: <strong>${person.spouse_name}</strong></div>`;
      }
      pm.forEach((m,i) => {
        const linkedCase = m.annulment_case_id?store.allCases.find(c=>c.id===m.annulment_case_id):null;
        const autoConfirmed = caseIsConfirmed(m.annulment_case_id);
        const resolved = m.annulment_granted || autoConfirmed;
        const bgColor = resolved?'#F8F7F4':'#FEF9E7';
        const borderColor = resolved?'var(--stone)':'#D4AC0D';
        let annulmentLine;
        if(autoConfirmed) {
          annulmentLine = `<div style="font-size:11px;margin-top:2px;color:#2D6A4F;">✅ Annulment confirmed — case resolved</div>`;
        } else if(m.annulment_granted) {
          annulmentLine = `<div style="font-size:11px;margin-top:2px;color:#2D6A4F;">✅ Annulment granted</div>`;
        } else {
          annulmentLine = `<div style="font-size:11px;margin-top:2px;color:#854F0B;">⚠ Annulment needed</div>`;
        }
        h += `<div style="padding:6px 10px;background:${bgColor};border-left:3px solid ${borderColor};border-radius:3px;margin-bottom:6px;font-size:13px;">
          <div>Prior marriage ${i+1}: <strong>${m.ex_name||'—'}</strong></div>
          ${annulmentLine}
          ${linkedCase
            ? `<div style="font-size:11px;color:#1B4F72;margin-top:4px;display:flex;align-items:center;gap:6px;">🔗 <span onclick="window.expandCase('${linkedCase.id}')" style="cursor:pointer;text-decoration:underline;text-underline-offset:2px;"><strong>${linkedCase.petitioner}${linkedCase.respondent?' v. '+linkedCase.respondent:''}</strong></span> <button onclick="unlinkOciaPriorCase('${person.id}',${i})" style="background:none;border:none;cursor:pointer;color:#AAA;font-size:11px;padding:0;margin-left:4px;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#AAA'">✕ unlink</button></div>`
            : `<div style="margin-top:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <select id="ocia-pm-case-${person.id}-${i}" style="font-size:12px;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.3rem .6rem;font-family:'Inter',sans-serif;background:#FFFFFF;outline:none;flex:1;min-width:0;">
                  <option value="">— Link to annulment case —</option>
                  ${store.allCases.filter(c=>!c.archived).map(c=>`<option value="${c.id}">${c.petitioner}${c.respondent?' v. '+c.respondent:''}</option>`).join('')}
                </select>
                <button onclick="linkOciaPriorCase('${person.id}',${i})" class="btn-primary" style="padding:.3rem .75rem;font-size:12px;white-space:nowrap;">Link</button>
              </div>`
          }
        </div>`;
      });
    }


    if(ociaIsMinor(person)&&person.parental_consent) {
      h += `<div style="margin-top:8px;padding:6px 10px;background:#D8F3DC;border-left:3px solid #2D6A4F;border-radius:3px;font-size:13px;color:#2D6A4F;">✅ Parental consent received${person.consent_parent_name?' — '+person.consent_parent_name:''}${person.consent_date?' on '+fmtDate(person.consent_date):''}</div>`;
    }

    if(person.baptismal_status==='baptized') {
      h += `<div class="couple-section-label">Baptismal record</div>`;
      if(person.baptism_church||person.baptism_city_state) {
        h += `<div style="font-size:13px;margin-bottom:4px;">`;
        if(person.baptism_church) h += `⛪ ${person.baptism_church}`;
        if(person.baptism_city_state) h += `<span style="margin-left:8px;">📍 ${person.baptism_city_state}</span>`;
        h += `<span style="margin-left:8px;font-size:11px;color:${person.baptism_record_received?'#2D6A4F':'#922B21'};">${person.baptism_record_received?'✅ Record received':'❌ Record not yet received'}</span>`;
        h += `</div>`;
      }
      if(person.sponsor1) h += `<div style="font-size:13px;">Sponsor: <strong>${person.sponsor1}</strong></div>`;
    } else {
      if(person.sponsor1) h += `<div style="font-size:13px;margin-top:6px;">Godparent 1: <strong>${person.sponsor1}</strong></div>`;
      if(person.sponsor2) h += `<div style="font-size:13px;">Godparent 2: <strong>${person.sponsor2}</strong></div>`;
    }

    const hasNotes = !!(person.notes&&person.notes.trim());
    h += `<div style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;margin-bottom:4px;">
      ${hasNotes?'<span class="couple-section-label" style="margin:0;">Notes</span>':'<span></span>'}
      <button onclick="toggleOciaNoteForm('${person.id}')" style="font-size:12px;color:var(--cardinal);background:none;border:none;cursor:pointer;font-family:'Inter',sans-serif;padding:0;">+ Add note</button>
    </div>`;
    h += `<div id="ocia-note-form-${person.id}" style="display:none;margin-bottom:.5rem;">
      <textarea id="ocia-note-text-${person.id}" placeholder="Add a note…" rows="2" style="width:100%;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .75rem;font-size:13px;font-family:'Inter',sans-serif;background:#FFFFFF;outline:none;resize:vertical;margin-bottom:6px;"></textarea>
      <div style="display:flex;gap:8px;">
        <button class="btn-primary" style="padding:.35rem .9rem;font-size:12px;" onclick="appendOciaNote('${person.id}')">Save</button>
        <button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="toggleOciaNoteForm('${person.id}')">Cancel</button>
      </div>
    </div>`;
    if(hasNotes) {
      const entries = person.notes.split('\n\n').filter(n=>n.trim());
      h += entries.map((n,i) => `<div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:6px;padding:8px 12px;background:#FFF8EE;border-left:3px solid var(--gold);border-radius:3px;">
        <div style="font-size:13px;color:#555;font-style:italic;flex:1;white-space:pre-wrap;">${n}</div>
        <button onclick="deleteOciaNote('${person.id}',${i})" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:13px;padding:0;flex-shrink:0;line-height:1.4;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#CCC'">✕</button>
      </div>`).join('');
    }

    h += `<div style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;margin-bottom:4px;">
      <span class="couple-section-label" style="margin:0;">Documents</span>
      <button onclick="toggleOciaDocForm('${person.id}')" style="font-size:12px;color:var(--cardinal);background:none;border:none;cursor:pointer;font-family:'Inter',sans-serif;padding:0;">+ Add document</button>
    </div>`;
    h += `<div id="ocia-doc-form-${person.id}" style="display:none;margin-bottom:.5rem;">
      <input type="text" id="ocia-doc-name-${person.id}" placeholder="Document name…" style="width:100%;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .75rem;font-size:13px;font-family:'Inter',sans-serif;background:#FFFFFF;outline:none;margin-bottom:6px;" />
      <div style="display:flex;gap:8px;">
        <button class="btn-primary" style="padding:.35rem .9rem;font-size:12px;" onclick="addOciaDoc('${person.id}')">Save</button>
        <button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="toggleOciaDocForm('${person.id}')">Cancel</button>
      </div>
    </div>`;
    if(docs.length) {
      if(progress!==null) {
        h += `<div class="prog-bar-wrap"><div class="prog-bar-fill" style="width:${progress}%;background:${progress===100?'#2D6A4F':'var(--gold)'};"></div></div>`;
        h += `<div style="font-size:11px;color:#888;margin-bottom:6px;">${progress}% complete</div>`;
      }
      h += docs.map((d,i) => `<div class="doc-item" style="padding:4px 6px;border-radius:var(--radius-sm);transition:background .12s;" onmouseover="this.style.background='var(--parch)'" onmouseout="this.style.background='transparent'">
        <span style="font-size:15px;cursor:pointer;" onclick="toggleOciaDoc('${person.id}',${i})">${d.done?'✅':'❌'}</span>
        <span style="color:${d.done?'#2D6A4F':'#922B21'};flex:1;cursor:pointer;" onclick="toggleOciaDoc('${person.id}',${i})">${d.name}</span>
        <button onclick="deleteOciaDoc('${person.id}',${i})" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:13px;padding:0 0 0 8px;flex-shrink:0;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#CCC'">✕</button>
      </div>`).join('');
    }

    const tl = person.timeline||[];
    h += `<div style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;margin-bottom:4px;">
      <span class="couple-section-label" style="margin:0;">Timeline</span>
      <button onclick="toggleOciaTlForm('${person.id}')" style="font-size:12px;color:var(--cardinal);background:none;border:none;cursor:pointer;font-family:'Inter',sans-serif;padding:0;">+ Add update</button>
    </div>`;
    h += `<div id="ocia-tl-form-${person.id}" style="display:none;background:var(--parch);border:.5px solid var(--stone);border-radius:var(--radius-sm);padding:.75rem;margin-bottom:.75rem;">
      <input type="date" id="ocia-tl-date-${person.id}" value="${todayCST()}" style="width:100%;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .75rem;font-size:13px;font-family:'Inter',sans-serif;background:#FFFFFF;outline:none;margin-bottom:6px;" />
      <input type="text" id="ocia-tl-event-${person.id}" placeholder="Update comment…" style="width:100%;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .75rem;font-size:13px;font-family:'Inter',sans-serif;background:#FFFFFF;outline:none;margin-bottom:6px;" />
      <div style="display:flex;gap:8px;">
        <button class="btn-primary" style="padding:.35rem .9rem;font-size:12px;" onclick="addOciaTlEntry('${person.id}')">Save</button>
        <button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="toggleOciaTlForm('${person.id}')">Cancel</button>
      </div>
    </div>`;
    if(tl.length) {
      h += `<div class="tl-wrap">`;
      h += tl.map((e,i) => `<div class="tl-item" style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
        <div style="flex:1;"><div class="tl-dot"></div>${e.date?`<div class="tl-date">${fmtDate(e.date)}</div>`:''}<div class="tl-event">${e.event}</div></div>
        <button onclick="deleteOciaTlEntry('${person.id}',${i})" style="background:none;border:none;cursor:pointer;color:#AAA;font-size:14px;padding:0;flex-shrink:0;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#AAA'">✕</button>
      </div>`).join('');
      h += `</div>`;
    } else {
      h += `<div style="font-size:13px;color:#6B7280;font-style:italic;padding:.25rem 0;">No timeline entries yet.</div>`;
    }

    if(person.updated_at) {
      const upd = new Date(person.updated_at);
      h += `<div style="font-size:11px;color:#AAA;margin-top:10px;margin-bottom:8px;">Last updated: ${upd.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</div>`;
    }
    h += `<div style="margin-top:4px;"><button class="btn-primary" onclick="openOciaModal('${person.id}')">Edit</button></div>`;
    h += `</div>`;
  }
  h += `</div>`;
  return h;
}

function toggleOcia(id) {ociaExpanded=ociaExpanded===id?null:id;renderOcia();}

async function linkOciaPriorCase(personId, pmIndex) {
  const person = allOcia.find(p => p.id===personId);
  if(!person) return;
  const sel = document.getElementById(`ocia-pm-case-${personId}-${pmIndex}`);
  if(!sel||!sel.value){alert('Please select a case to link.');return;}
  const pm = JSON.parse(JSON.stringify(person.prior_marriages||[]));
  pm[pmIndex].annulment_case_id = sel.value;
  const {error} = await sb.from('sacramental_ocia').update({prior_marriages:pm,updated_at:new Date().toISOString()}).eq('id',personId);
  if(error){alert('Save failed: '+error.message);return;}
  person.prior_marriages = pm;
  if(caseIsConfirmed(sel.value)) {
    createNotification(`${person.name}'s annulment has been confirmed — review OCIA status`, 'success', 'ocia', personId);
  }
  renderOcia();
}

async function unlinkOciaPriorCase(personId, pmIndex) {
  const person = allOcia.find(p => p.id===personId);
  if(!person||!confirm('Remove this case link?')) return;
  const pm = JSON.parse(JSON.stringify(person.prior_marriages||[]));
  pm[pmIndex].annulment_case_id = null;
  const {error} = await sb.from('sacramental_ocia').update({prior_marriages:pm,updated_at:new Date().toISOString()}).eq('id',personId);
  if(error){alert('Save failed: '+error.message);return;}
  person.prior_marriages = pm;
  renderOcia();
}

function toggleOciaNoteForm(id) {const f=document.getElementById('ocia-note-form-'+id);if(!f)return;f.style.display=f.style.display==='none'?'block':'none';if(f.style.display==='block')document.getElementById('ocia-note-text-'+id).focus();}

async function appendOciaNote(id) {
  const p = allOcia.find(x => x.id===id); if(!p) return;
  const txt = document.getElementById('ocia-note-text-'+id).value.trim(); if(!txt){alert('Please enter a note.');return;}
  const now = new Date(new Date().toLocaleString('en-US',{timeZone:'America/Chicago'}));
  const ds = `${now.getMonth()+1}/${now.getDate()}/${now.getFullYear()}`;
  const newNotes = p.notes?`${p.notes}\n\n[${ds}] ${txt}`:`[${ds}] ${txt}`;
  const {error} = await sb.from('sacramental_ocia').update({notes:newNotes,updated_at:new Date().toISOString()}).eq('id',id);
  if(error){alert('Save failed: '+error.message);return;}
  p.notes = newNotes; renderOcia();
}

async function deleteOciaNote(id, idx) {
  const p = allOcia.find(x => x.id===id); if(!p||!confirm('Delete this note?')) return;
  const entries = p.notes.split('\n\n').filter(n=>n.trim()); entries.splice(idx,1);
  const newNotes = entries.join('\n\n');
  const {error} = await sb.from('sacramental_ocia').update({notes:newNotes,updated_at:new Date().toISOString()}).eq('id',id);
  if(error){alert('Delete failed: '+error.message);return;}
  p.notes = newNotes; renderOcia();
}

function toggleOciaDocForm(id) {const f=document.getElementById('ocia-doc-form-'+id);if(!f)return;f.style.display=f.style.display==='none'?'block':'none';if(f.style.display==='block')document.getElementById('ocia-doc-name-'+id).focus();}

async function addOciaDoc(id) {
  const p = allOcia.find(x => x.id===id); if(!p) return;
  const name = document.getElementById('ocia-doc-name-'+id).value.trim(); if(!name){alert('Please enter a document name.');return;}
  const docs = JSON.parse(JSON.stringify(p.documents||[])); docs.push({name,done:false});
  const {error} = await sb.from('sacramental_ocia').update({documents:docs,updated_at:new Date().toISOString()}).eq('id',id);
  if(error){alert('Save failed: '+error.message);return;}
  p.documents = docs; renderOcia();
}

async function toggleOciaDoc(id, idx) {
  const p = allOcia.find(x => x.id===id); if(!p) return;
  const docs = JSON.parse(JSON.stringify(p.documents||[])); docs[idx].done = !docs[idx].done;
  const {error} = await sb.from('sacramental_ocia').update({documents:docs,updated_at:new Date().toISOString()}).eq('id',id);
  if(error) return; p.documents = docs; renderOcia();
}

async function deleteOciaDoc(id, idx) {
  const p = allOcia.find(x => x.id===id); if(!p||!confirm(`Delete "${p.documents[idx].name}"?`)) return;
  const docs = JSON.parse(JSON.stringify(p.documents||[])); docs.splice(idx,1);
  const {error} = await sb.from('sacramental_ocia').update({documents:docs,updated_at:new Date().toISOString()}).eq('id',id);
  if(error){alert('Delete failed: '+error.message);return;}
  p.documents = docs; renderOcia();
}

function toggleOciaTlForm(id) {const f=document.getElementById('ocia-tl-form-'+id);if(!f)return;f.style.display=f.style.display==='none'?'block':'none';if(f.style.display==='block')document.getElementById('ocia-tl-event-'+id).focus();}

async function addOciaTlEntry(id) {
  const p = allOcia.find(x => x.id===id); if(!p) return;
  const date = document.getElementById('ocia-tl-date-'+id).value||null;
  const event = document.getElementById('ocia-tl-event-'+id).value.trim(); if(!event){alert('Please enter a comment.');return;}
  const tl = JSON.parse(JSON.stringify(p.timeline||[])); tl.push({date,event});
  const {error} = await sb.from('sacramental_ocia').update({timeline:tl,updated_at:new Date().toISOString()}).eq('id',id);
  if(error){alert('Save failed: '+error.message);return;}
  p.timeline = tl; renderOcia();
}

async function deleteOciaTlEntry(id, idx) {
  const p = allOcia.find(x => x.id===id); if(!p||!confirm('Delete this timeline entry?')) return;
  const tl = JSON.parse(JSON.stringify(p.timeline||[])); tl.splice(idx,1);
  const {error} = await sb.from('sacramental_ocia').update({timeline:tl,updated_at:new Date().toISOString()}).eq('id',id);
  if(error){alert('Delete failed: '+error.message);return;}
  p.timeline = tl; renderOcia();
}

function openOciaModal(id) {
  const person = id?allOcia.find(p => p.id===id):null;
  const pm = person?.prior_marriages||[];
  const isMinor = ociaIsMinor(person||{});

  document.getElementById('modal-content').innerHTML = `
    <div class="modal-title">${person?'Edit — '+person.name:'Add person'}</div>

    <label>Full legal name</label><input id="of-name" value="${person?.name||''}" />
    <label>Date of birth</label><input id="of-dob" value="${person?.dob||''}" placeholder="e.g. 15 Mar 1985" />
    <label>Place of birth</label><input id="of-pob" value="${person?.place_of_birth||''}" placeholder="City, State / Country" />
    <label>Phone</label><input id="of-phone" value="${person?.phone||''}" />
    <label>Email</label><input id="of-email" value="${person?.email||''}" />

    <label>Status</label>
    <select id="of-status" onchange="ociaModalStatusChange()">
      ${Object.entries(OCIA_STATUS).map(([k,v]) => `<option value="${k}"${person?.status_code===k?' selected':''}>${v.label}</option>`).join('')}
    </select>

    <div id="of-prep-wrap" style="${person?.status_code==='preparation'?'':'display:none'}">
      <label>Preparation type</label>
      <select id="of-prep">
        <option value="enrolled"${person?.preparation_type==='enrolled'?' selected':''}>Enrolled in OCIA class</option>
        <option value="special"${person?.preparation_type==='special'?' selected':''}>Special preparation</option>
      </select>
    </div>

    <label>Baptismal status</label>
    <select id="of-bap-status" onchange="ociaModalBapChange()">
      <option value="unbaptized"${person?.baptismal_status==='unbaptized'?' selected':''}>Unbaptized</option>
      <option value="baptized"${person?.baptismal_status==='baptized'?' selected':''}>Baptized</option>
    </select>

    <div id="of-bap-section" style="${person?.baptismal_status==='baptized'?'':'display:none'}">
      <label>Church of baptism</label><input id="of-bap-church" value="${person?.baptism_church||''}" />
      <label>City / State</label><input id="of-bap-city" value="${person?.baptism_city_state||''}" />
      <label><input type="checkbox" id="of-bap-rec" ${person?.baptism_record_received?'checked':''} style="margin-right:6px;">Baptismal record received</label>
      <label>Sponsor name</label><input id="of-sponsor1" value="${person?.sponsor1||''}" />
    </div>

    <div id="of-godparent-section" style="${person?.baptismal_status==='baptized'?'display:none':''}">
      <label>Godparent 1</label><input id="of-godparent1" value="${person?.sponsor1||''}" />
      <label>Godparent 2 (optional)</label><input id="of-godparent2" value="${person?.sponsor2||''}" />
    </div>

    <label>Marriage status</label>
    <select id="of-marr" onchange="ociaModalMarrChange()">
      <option value="">— Select —</option>
      <option value="single"${person?.marriage_status==='single'?' selected':''}>Single</option>
      <option value="married"${person?.marriage_status==='married'?' selected':''}>Married</option>
      <option value="divorced"${person?.marriage_status==='divorced'?' selected':''}>Divorced</option>
    </select>

    <div id="of-spouse-wrap" style="${person?.marriage_status==='married'?'':'display:none'}">
      <label>Spouse name</label><input id="of-spouse" value="${person?.spouse_name||''}" />
      <label><input type="checkbox" id="of-remarried" ${person?.remarried?'checked':''} onchange="ociaModalRemarrChange()" style="margin-right:6px;">Remarried?</label>
    </div>

    <div id="of-prior-marriages">
      ${pm.map((m,i) => ociaModalPriorMarriageRow(i,m)).join('')}
    </div>
    <div id="of-add-pm-wrap" style="${person?.marriage_status==='married'&&person?.remarried||person?.marriage_status==='divorced'?'':'display:none'}">
      <button type="button" class="btn-secondary" style="font-size:12px;padding:.3rem .8rem;margin-top:6px;" onclick="ociaAddPriorMarriage()">+ Add prior marriage</button>
    </div>

    <div id="of-minor-wrap" style="${isMinor?'':'display:none'}">
      <label style="margin-top:12px;font-weight:600;color:var(--navy);">Minor — Parental/Guardian consent</label>
      <label><input type="checkbox" id="of-consent" ${person?.parental_consent?'checked':''} onchange="ociaModalConsentChange()" style="margin-right:6px;">Parental/guardian consent received</label>
      <div id="of-consent-details" style="${person?.parental_consent?'':'display:none'}">
        <label>Parent/guardian name</label><input id="of-consent-name" value="${person?.consent_parent_name||''}" />
        <label>Parent/guardian phone</label><input id="of-consent-phone" value="${person?.consent_parent_phone||''}" />
        <label>Parent/guardian email</label><input id="of-consent-email" value="${person?.consent_parent_email||''}" />
        <label>Date received</label><input type="date" id="of-consent-date" value="${person?.consent_date||''}" />
      </div>
    </div>


    <div id="of-rec-wrap" style="${['preparation','complete'].includes(person?.status_code)?'':'display:none;'}margin-top:10px;">
      <label>Anticipated reception date</label>
      ${(()=>{
        const easter = nextEaster();
        const easterYr = easter.getFullYear();
        const easterVal = easter.toISOString().slice(0,10);
        const isCustom = person?.reception_date_type === 'custom';
        return `<select id="of-rec-type" onchange="ociaModalReceptionChange()" data-easter-val="${easterVal}">
          <option value="easter" ${!isCustom?'selected':''}>Easter ${easterYr}</option>
          <option value="custom" ${isCustom?'selected':''}>Custom date</option>
        </select>
        <div id="of-rec-custom" style="${isCustom?'':'display:none;'}margin-top:4px;">
          <input type="date" id="of-rec-date" value="${isCustom&&person?.reception_date?person.reception_date:''}" />
        </div>`;
      })()}
    </div>

    <label><input type="checkbox" id="of-arch" ${person?.archived?'checked':''} style="margin-right:6px;">Archived</label>

    <div class="modal-actions" style="justify-content:space-between;">
      ${person?`<button class="btn-delete" onclick="deleteOciaPerson('${person.id}')">Delete</button>`:'<span></span>'}
      <div style="display:flex;gap:8px;">
        <button class="btn-secondary" onclick="closeModal()">Cancel</button>
        <button class="btn-primary" onclick="saveOcia(${person?`'${person.id}'`:null})">Save</button>
      </div>
    </div>`;

  document.getElementById('modal-overlay').classList.add('open');
  ociaModalStatusChange();
  ociaModalBapChange();
  ociaModalMarrChange();
  if(person?.remarried) ociaModalRemarrChange();
  if(person?.parental_consent) ociaModalConsentChange();
  const dobEl = document.getElementById('of-dob');
  if(dobEl) dobEl.addEventListener('input', () => {
    const age = ociaAge(dobEl.value);
    document.getElementById('of-minor-wrap').style.display = age!==null&&age<18?'':'none';
  });
}

function ociaModalPriorMarriageRow(i, m) {
  m = m||{};
  return `<div id="of-pm-${i}" style="padding:8px 10px;background:var(--parch);border-radius:var(--radius-sm);border:.5px solid var(--stone);margin-top:6px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
      <span style="font-size:11px;font-weight:600;color:var(--navy);text-transform:uppercase;letter-spacing:.06em;">Prior marriage ${i+1}</span>
      <button type="button" onclick="ociaRemovePriorMarriage(${i})" style="background:none;border:none;cursor:pointer;color:#AAA;font-size:13px;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#AAA'">✕</button>
    </div>
    <label>Ex-spouse name</label><input id="of-pm-name-${i}" value="${m.ex_name||''}" style="width:100%;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.35rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#FFFFFF;outline:none;margin-bottom:4px;" />
    <label><input type="checkbox" id="of-pm-ann-${i}" ${m.annulment_granted?'checked':''} style="margin-right:6px;">Annulment granted</label>
    ${store.allCases.length?`<label>Link to annulment case</label>
    <select id="of-pm-case-${i}" style="width:100%;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.35rem .6rem;font-size:12px;font-family:'Inter',sans-serif;background:#FFFFFF;outline:none;margin-top:2px;">
      <option value="">— None —</option>
      ${store.allCases.map(c => `<option value="${c.id}"${m.annulment_case_id===c.id?' selected':''}>${c.petitioner}${c.respondent?' v. '+c.respondent:''}</option>`).join('')}
    </select>`:''}
  </div>`;
}

let _ociaPriorCount = 0;
function ociaAddPriorMarriage() {
  const i = _ociaPriorCount++;
  const container = document.getElementById('of-prior-marriages');
  const div = document.createElement('div');
  div.innerHTML = ociaModalPriorMarriageRow(i,{});
  container.appendChild(div.firstElementChild);
}
function ociaRemovePriorMarriage(i) {
  const el = document.getElementById('of-pm-'+i);
  if(el) el.remove();
}

function ociaModalStatusChange() {
  const v = document.getElementById('of-status')?.value;
  const prepWrap = document.getElementById('of-prep-wrap');
  if(prepWrap) prepWrap.style.display = (v==='preparation')?'':'none';
  const recWrap = document.getElementById('of-rec-wrap');
  if(recWrap) recWrap.style.display = ['preparation','complete'].includes(v)?'':'none';
}
function ociaModalBapChange() {
  const v = document.getElementById('of-bap-status')?.value;
  const bap = document.getElementById('of-bap-section');
  const god = document.getElementById('of-godparent-section');
  if(bap) bap.style.display = v==='baptized'?'':'none';
  if(god) god.style.display = v==='baptized'?'none':'';
}
function ociaModalMarrChange() {
  const v = document.getElementById('of-marr')?.value;
  const sw = document.getElementById('of-spouse-wrap');
  const pmw = document.getElementById('of-add-pm-wrap');
  const remarried = document.getElementById('of-remarried')?.checked;
  if(sw) sw.style.display = v==='married'?'':'none';
  if(pmw) pmw.style.display = (v==='divorced'||(v==='married'&&remarried))?'':'none';
  if(v==='divorced') {
    const container = document.getElementById('of-prior-marriages');
    if(container&&container.children.length===0) ociaAddPriorMarriage();
  }
}
function ociaModalRemarrChange() {
  const remarried = document.getElementById('of-remarried')?.checked;
  const pmw = document.getElementById('of-add-pm-wrap');
  if(pmw) pmw.style.display = remarried?'':'none';
  if(remarried) {
    const container = document.getElementById('of-prior-marriages');
    if(container&&container.children.length===0) ociaAddPriorMarriage();
  }
}
function ociaModalConsentChange() {
  const checked = document.getElementById('of-consent')?.checked;
  const det = document.getElementById('of-consent-details');
  if(det) det.style.display = checked?'':'none';
}
function ociaModalReceptionChange() {
  const isCustom = document.getElementById('of-rec-type')?.value === 'custom';
  const wrap = document.getElementById('of-rec-custom');
  if(wrap) wrap.style.display = isCustom ? '' : 'none';
}

function ociaCollectPriorMarriages() {
  const pms = [];
  let i = 0;
  while(document.getElementById('of-pm-'+i)!==null) {
    const nameEl = document.getElementById('of-pm-name-'+i);
    const annEl = document.getElementById('of-pm-ann-'+i);
    const caseEl = document.getElementById('of-pm-case-'+i);
    if(nameEl) {
      pms.push({
        ex_name:nameEl.value.trim()||null,
        annulment_granted:annEl?.checked||false,
        annulment_case_id:caseEl?.value||null,
      });
    }
    i++;
  }
  return pms;
}

async function saveOcia(id) {
  const name = document.getElementById('of-name').value.trim();
  if(!name){alert('Full legal name is required.');return;}
  const marr = document.getElementById('of-marr')?.value||null;
  const remarried = document.getElementById('of-remarried')?.checked||false;
  const bapStatus = document.getElementById('of-bap-status')?.value||'unbaptized';
  const consentChecked = document.getElementById('of-consent')?.checked||false;
  const pm = ociaCollectPriorMarriages();
  const payload = {
    name,
    dob:document.getElementById('of-dob').value.trim()||null,
    place_of_birth:document.getElementById('of-pob').value.trim()||null,
    phone:document.getElementById('of-phone').value.trim()||null,
    email:document.getElementById('of-email').value.trim()||null,
    status_code:document.getElementById('of-status').value,
    preparation_type:document.getElementById('of-prep')?.value||null,
    baptismal_status:bapStatus,
    baptism_church:bapStatus==='baptized'?document.getElementById('of-bap-church')?.value.trim()||null:null,
    baptism_city_state:bapStatus==='baptized'?document.getElementById('of-bap-city')?.value.trim()||null:null,
    baptism_record_received:bapStatus==='baptized'?(document.getElementById('of-bap-rec')?.checked||false):false,
    sponsor1:bapStatus==='baptized'?document.getElementById('of-sponsor1')?.value.trim()||null:document.getElementById('of-godparent1')?.value.trim()||null,
    sponsor2:bapStatus==='baptized'?null:document.getElementById('of-godparent2')?.value.trim()||null,
    marriage_status:marr||null,
    spouse_name:marr==='married'?document.getElementById('of-spouse')?.value.trim()||null:null,
    remarried:marr==='married'?remarried:false,
    prior_marriages:pm,
    parental_consent:consentChecked,
    consent_parent_name:consentChecked?document.getElementById('of-consent-name')?.value.trim()||null:null,
    consent_parent_phone:consentChecked?document.getElementById('of-consent-phone')?.value.trim()||null:null,
    consent_parent_email:consentChecked?document.getElementById('of-consent-email')?.value.trim()||null:null,
    consent_date:consentChecked?document.getElementById('of-consent-date')?.value||null:null,
    archived:document.getElementById('of-arch').checked,
    updated_at:new Date().toISOString(),
  };

  const recSelect = document.getElementById('of-rec-type');
  const recType = recSelect?.value || 'easter';
  payload.reception_date_type = recType;
  payload.reception_date = recType === 'easter'
    ? (recSelect?.dataset.easterVal || null)
    : (document.getElementById('of-rec-date')?.value || null);

  let err;
  if(id) {
    const r = await sb.from('sacramental_ocia').update(payload).eq('id',id); err = r.error;
  } else {
    payload.documents = [];
    payload.timeline = [{date:todayCST(), event:'Record created'}];
    const r = await sb.from('sacramental_ocia').insert(payload); err = r.error;
  }
  if(err){alert('Save failed: '+err.message);return;}
  closeModal();
  loadOcia();
}

async function deleteOciaPerson(id) {
  if(!confirm('Permanently delete this record? This cannot be undone.')) return;
  const {error} = await sb.from('sacramental_ocia').delete().eq('id',id);
  if(error){alert('Delete failed: '+error.message);return;}
  closeModal(); loadOcia();
}

Object.assign(window, {
  renderOcia, setOciaFilter, toggleOcia, expandCase,
  linkOciaPriorCase, unlinkOciaPriorCase,
  toggleOciaNoteForm, appendOciaNote, deleteOciaNote,
  toggleOciaDocForm, addOciaDoc, toggleOciaDoc, deleteOciaDoc,
  toggleOciaTlForm, addOciaTlEntry, deleteOciaTlEntry,
  openOciaModal, ociaModalPriorMarriageRow,
  ociaAddPriorMarriage, ociaRemovePriorMarriage,
  ociaModalStatusChange, ociaModalBapChange, ociaModalMarrChange,
  ociaModalRemarrChange, ociaModalConsentChange, ociaModalReceptionChange,
  saveOcia, deleteOciaPerson,
});
