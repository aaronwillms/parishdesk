import { sb } from '../supabase.js';
import { fmtDate, fmtDateYear, daysUntil, todayCST, logActivity } from '../utils.js';
import { store } from '../store.js';
import { expandCase } from './annulments.js';
import { notifyUsers, getUserIdsForSacrament } from '../notifications.js';

export const COUPLE_STATUS = {
  inprogress:{label:'In progress',  color:'#7D6608', bg:'#FEF9E7', dot:'#D4AC0D'},
  complete:  {label:'Complete',     color:'#2D6A4F', bg:'#D8F3DC', dot:'#2D6A4F'},
  external:  {label:'External',     color:'#616A6B', bg:'#F2F3F4', dot:'#AAB7B8'},
  inactive:  {label:'Inactive',     color:'#922B21', bg:'#FCEBEB', dot:'#A32D2D'},
};

const MARRIAGE_TYPES = ['Nuptial Mass', 'Marriage Outside Mass', 'Convalidation'];

let allCouples = [], coupleFilter = 'all', expandedCoupleId = null;

function setCoupleFilter(f, el) {
  coupleFilter = f;
  document.querySelectorAll('.cf-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  renderCouples();
}

export async function loadCouples() {
  const {data, error} = await sb.from('couples').select('*');
  if(error){console.error(error);return;}
  const active = (data||[]).filter(c=>!c.archived).sort((a,b)=>{
    if(!a.wedding_date&&!b.wedding_date) return 0;
    if(!a.wedding_date) return 1;
    if(!b.wedding_date) return -1;
    return new Date(a.wedding_date)-new Date(b.wedding_date);
  });
  const archived = (data||[]).filter(c=>c.archived).sort((a,b)=>{
    if(!a.wedding_date&&!b.wedding_date) return 0;
    if(!a.wedding_date) return 1;
    if(!b.wedding_date) return -1;
    return new Date(b.wedding_date)-new Date(a.wedding_date);
  });
  allCouples = [...active, ...archived];
  updateCoupleStats();
  renderMarriageAlerts();
  renderCouples();
}

function marriageCaseIsConfirmed(caseId) {
  if(!caseId) return false;
  const c = (store.allCases||[]).find(c => c.id===caseId);
  return !!(c && c.status_code==='affirm' && c.judgement_finalized==='yes');
}

function pmResolved(p) {
  return p.annulment_granted || marriageCaseIsConfirmed(p.annulment_case_id);
}

function hasMissingAnnulment(c) {
  return (c.prior_marriages||[]).some(p => !pmResolved(p));
}

function updateCoupleStats() {
  const active = allCouples.filter(c => !c.archived);
  document.getElementById('stat-couples').textContent = active.length;
  document.getElementById('stat-nearly').textContent = active.filter(c => c.status_code==='complete').length;
  document.getElementById('stat-needs-attention').textContent = active.filter(c => c.status_code==='inprogress').length;
}

function renderMarriageAlerts() {
  const c = document.getElementById('marriage-alerts');
  const urgent = allCouples.filter(p => {
    if(p.archived||p.status_code==='inactive') return false;
    const docs = p.documents||[];
    const days = daysUntil(p.wedding_date);
    return (days!==null&&days<=30&&docs.filter(d=>!d.done).length>0)||(days!==null&&days<=7)||hasMissingAnnulment(p);
  });
  if(!urgent.length){c.innerHTML='';return;}
  c.innerHTML = '<div class="alert-strip" style="margin-bottom:1rem;flex-direction:column;align-items:flex-start;">'
    + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;"><i class="ti ti-alert-triangle" style="color:var(--gold);font-size:15px;"></i><strong style="font-size:13px;">Priority actions</strong></div>'
    + urgent.map(p=>{
        const docs = p.documents||[];
        const out = docs.filter(d=>!d.done).map(d=>d.name);
        const days = daysUntil(p.wedding_date);
        const ds = days===0?'TODAY':days===1?'tomorrow':`${days} days`;
        const annulmentAlert = hasMissingAnnulment(p) ? ' · ⚠️ annulment required' : '';
        return '<div style="font-size:13px;color:var(--navy);margin-bottom:3px;">· <strong>'+p.groom+' &amp; '+p.bride+'</strong>'+(days!==null?' — wedding '+ds:'')+(out.length?' · outstanding: '+out.slice(0,3).join(', ')+(out.length>3?' +'+( out.length-3)+' more':''):'')+(annulmentAlert)+'</div>';
      }).join('')
    + '</div>';
}

function renderCouples() {
  const q = (document.getElementById('couple-search')?.value||'').toLowerCase();
  const items = allCouples.filter(c => {
    const mf = coupleFilter==='all'?true:coupleFilter==='active'?!c.archived:coupleFilter==='inprogress'?c.status_code==='inprogress'&&!c.archived:coupleFilter==='complete'?c.status_code==='complete'&&!c.archived:coupleFilter==='external'?c.status_code==='external':coupleFilter==='archived'?c.archived:true;
    return mf && (!q||(c.groom||'').toLowerCase().includes(q)||(c.bride||'').toLowerCase().includes(q));
  });
  const el = document.getElementById('couples-list');
  if(!items.length){el.innerHTML='<div style="font-size:13px;color:#6B7280;padding:.5rem 0;">No couples match.</div>';return;}
  const active = items.filter(c => !c.archived);
  const archived = items.filter(c => c.archived);
  let html = active.map(c => renderCoupleCard(c)).join('');
  if(archived.length) {
    html += '<div style="display:flex;align-items:center;gap:10px;margin:18px 0 10px;"><div style="flex:1;height:.5px;background:var(--stone);"></div><span style="font-size:11px;color:#6B7280;letter-spacing:.07em;text-transform:uppercase;font-weight:500;white-space:nowrap;">Archived</span><div style="flex:1;height:.5px;background:var(--stone);"></div></div>';
    html += archived.map(c => renderCoupleCard(c)).join('');
  }
  el.innerHTML = html;
}

function renderPriorMarriages(c) {
  const pm = c.prior_marriages||[];
  if(!pm.length) return '';
  const brideList = pm.filter(p => p.spouse==='bride');
  const groomList = pm.filter(p => p.spouse==='groom');
  function renderList(list, spouseName) {
    if(!list.length) return '';
    let out = '<div style="margin-top:8px;">';
    out += '<div style="font-size:11px;color:#AAA;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;">'+spouseName+' — Prior Marriage'+(list.length>1?'s':'')+'</div>';
    out += list.map(p => {
      const linkedCase = p.annulment_case_id ? (store.allCases||[]).find(ca=>ca.id===p.annulment_case_id) : null;
      const autoConfirmed = marriageCaseIsConfirmed(p.annulment_case_id);
      const resolved = p.annulment_granted || autoConfirmed;
      const caseLink = linkedCase
        ? ' — <span onclick="window.expandCase(\''+linkedCase.id+'\')" style="cursor:pointer;text-decoration:underline;"><strong>'+linkedCase.petitioner+(linkedCase.respondent?' v. '+linkedCase.respondent:'')+'</strong></span>'
        : '';
      let annulmentLine;
      if(autoConfirmed) {
        annulmentLine = '<span style="color:#2D6A4F;font-size:12px;">✅ Annulment confirmed — case resolved'+caseLink+'</span>';
      } else if(p.annulment_granted) {
        annulmentLine = '<span style="color:#2D6A4F;font-size:12px;">✅ Annulment granted'+caseLink+'</span>';
      } else {
        annulmentLine = '<span style="color:#922B21;font-size:12px;">⚠️ No annulment'+caseLink+'</span>';
      }
      return '<div style="font-size:13px;color:#555;margin-bottom:5px;padding:6px 10px;background:#FFF8EE;border-left:3px solid '+(resolved?'#2D6A4F':'#922B21')+';border-radius:3px;">'
        + '<div style="font-weight:600;">'+(p.ex_spouse_name||'(unnamed)')+'</div>'
        + '<div>'+annulmentLine+'</div>'
        + '</div>';
    }).join('');
    out += '</div>';
    return out;
  }
  return renderList(brideList, c.bride) + renderList(groomList, c.groom);
}

function renderCoupleCard(c) {
  const days = daysUntil(c.wedding_date);
  const missingAnnulment = hasMissingAnnulment(c);
  const urgent = (days!==null&&days>=0&&days<=7) || missingAnnulment;
  const sm = COUPLE_STATUS[c.status_code]||COUPLE_STATUS.inprogress;
  const docs = c.documents||[];
  const docsDone = docs.filter(d=>d.done).length;
  const progress = docs.length>0?Math.round((docsDone/docs.length)*100):null;
  const exp = expandedCoupleId===c.id;
  const dayStr = days===null?'':(days===0?' · Today!':days===1?' · Tomorrow!':days>=0?' · '+days+' days':'');
  let h = '<div class="couple-card'+(urgent?' urgent':'')+'" id="couple-card-'+c.id+'" style="border-left:4px solid '+(missingAnnulment?'#922B21':sm.dot)+';">';
  h += '<div class="couple-header" onclick="toggleCouple(\''+c.id+'\')">';
  h += '<div style="flex:1;">';
  h += '<div class="couple-name">'+c.groom+' &amp; '+c.bride+'</div>';
  h += '<div style="display:flex;gap:6px;margin-top:5px;flex-wrap:wrap;align-items:center;">';
  h += '<span style="background:'+sm.bg+';color:'+sm.color+';border-radius:20px;padding:2px 10px;font-size:11px;font-weight:600;letter-spacing:.04em;display:inline-flex;align-items:center;gap:5px;border:1px solid '+sm.color+'33;"><span style="width:7px;height:7px;border-radius:50%;background:'+sm.dot+';display:inline-block;"></span>'+sm.label+'</span>';
  if(c.wedding_date) {
    const dateUrgent = urgent&&!missingAnnulment;
    h += '<span style="font-size:11px;color:'+(dateUrgent?'#C0392B':'#777')+';background:'+(dateUrgent?'#FDEDEC':'#EFEFEF')+';border-radius:20px;padding:2px 8px;font-weight:'+(dateUrgent?700:400)+';">'+(dateUrgent?'⚠️ ':'')+fmtDateYear(c.wedding_date)+(c.wedding_time?' · '+c.wedding_time:'')+dayStr+'</span>';
  }
  if(c.marriage_type) h += '<span style="font-size:11px;color:#555;background:#F0ECE8;border-radius:20px;padding:2px 8px;">⛪ '+c.marriage_type+'</span>';
  if(missingAnnulment) h += '<span style="font-size:11px;color:#922B21;background:#FCEBEB;border-radius:20px;padding:2px 8px;font-weight:600;">⚠️ Annulment required</span>';
  if(progress!==null) h += progress===100?'<span style="font-size:11px;color:#2D6A4F;">✅ docs complete</span>':'<span style="font-size:11px;color:#922B21;">'+docsDone+'/'+docs.length+' docs</span>';
  h += '</div></div>';
  h += '<span style="font-size:16px;color:#B0A090;margin-top:2px;">'+(exp?'▲':'▼')+'</span>';
  h += '</div></div>';

  if(exp) {
    h += '<div class="couple-body">';
    h += '<div style="margin-top:10px;">';
    if(c.location) h += '<span class="detail-chip">📍 '+c.location+'</span>';
    if(c.celebrant) h += '<span class="detail-chip">✝ '+c.celebrant+'</span>';
    if(c.fee) h += '<span class="detail-chip" style="background:#FEF9E7;">💰 '+c.fee+'</span>';
    h += '</div>';
    if(missingAnnulment) {
      h += '<div class="alert-strip" style="margin-top:10px;margin-bottom:6px;"><i class="ti ti-alert-triangle" style="color:#922B21;font-size:14px;"></i><span style="font-size:13px;color:#922B21;font-weight:600;">Prior marriage without annulment — resolve before wedding</span></div>';
    }
    const pmHtml = renderPriorMarriages(c);
    if(pmHtml) h += '<div class="couple-section-label">Prior Marriages</div>'+pmHtml;
    const hc = c.bride_email||c.bride_phone||c.groom_email||c.groom_phone;
    if(hc) {
      h += '<div class="couple-section-label">Contact</div>';
      if(c.bride_email||c.bride_phone) {
        h += '<div style="font-size:11px;color:#AAA;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;">Bride — '+c.bride+'</div>';
        if(c.bride_phone) h += '<a href="tel:'+c.bride_phone+'" class="contact-chip">📞 '+c.bride_phone+'</a>';
        if(c.bride_email) h += '<a href="mailto:'+c.bride_email+'" class="contact-chip">✉️ '+c.bride_email+'</a>';
      }
      if(c.groom_email||c.groom_phone) {
        h += '<div style="font-size:11px;color:#AAA;text-transform:uppercase;letter-spacing:.05em;margin:6px 0 4px;">Groom — '+c.groom+'</div>';
        if(c.groom_phone) h += '<a href="tel:'+c.groom_phone+'" class="contact-chip">📞 '+c.groom_phone+'</a>';
        if(c.groom_email) h += '<a href="mailto:'+c.groom_email+'" class="contact-chip">✉️ '+c.groom_email+'</a>';
      }
    }
    const _coupleHasNotes = !!(c.notes&&c.notes.trim());
    h += '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;margin-bottom:4px;">';
    h += _coupleHasNotes?'<span class="couple-section-label" style="margin:0;">Notes</span>':'<span></span>';
    h += '<button onclick="toggleCoupleNoteForm(\''+c.id+'\')" style="font-size:12px;color:var(--cardinal);background:none;border:none;cursor:pointer;font-family:\'Inter\',sans-serif;padding:0;">+ Add note</button></div>';
    h += '<div id="couple-note-form-'+c.id+'" style="display:none;margin-bottom:.5rem;">';
    h += '<textarea id="couple-note-text-'+c.id+'" placeholder="Add a note…" rows="2" style="width:100%;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .75rem;font-size:13px;font-family:\'Inter\',sans-serif;background:#FFFFFF;outline:none;resize:vertical;margin-bottom:6px;"></textarea>';
    h += '<div style="display:flex;gap:8px;"><button class="btn-primary" style="padding:.35rem .9rem;font-size:12px;" onclick="appendCoupleNote(\''+c.id+'\')">Save</button><button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="toggleCoupleNoteForm(\''+c.id+'\')">Cancel</button></div></div>';
    if(_coupleHasNotes) {
      const noteEntries = c.notes.split('\n\n').filter(n=>n.trim());
      h += noteEntries.map((n,i) => '<div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:6px;padding:8px 12px;background:#FFF8EE;border-left:3px solid var(--gold);border-radius:3px;"><div style="font-size:13px;color:#555;font-style:italic;flex:1;white-space:pre-wrap;">'+n+'</div><button onclick="deleteCoupleNote(\''+c.id+'\','+i+')" title="Delete note" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:13px;padding:0;flex-shrink:0;line-height:1.4;" onmouseover="this.style.color=\'#E74C3C\'" onmouseout="this.style.color=\'#CCC\'">✕</button></div>').join('');
    }
    h += '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;margin-bottom:4px;"><span class="couple-section-label" style="margin:0;">Preparation checklist</span><button onclick="toggleCoupleDocForm(\''+c.id+'\')" style="font-size:12px;color:var(--cardinal);background:none;border:none;cursor:pointer;font-family:\'Inter\',sans-serif;padding:0;">+ Add document</button></div>';
    h += '<div id="couple-doc-form-'+c.id+'" style="display:none;margin-bottom:.5rem;"><input type="text" id="couple-doc-name-'+c.id+'" placeholder="Document name…" style="width:100%;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .75rem;font-size:13px;font-family:\'Inter\',sans-serif;background:#FFFFFF;outline:none;margin-bottom:6px;" /><div style="display:flex;gap:8px;"><button class="btn-primary" style="padding:.35rem .9rem;font-size:12px;" onclick="addCoupleDoc(\''+c.id+'\')">Save</button><button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="toggleCoupleDocForm(\''+c.id+'\')">Cancel</button></div></div>';
    if(docs.length) {
      if(progress!==null) {
        h += '<div class="prog-bar-wrap"><div class="prog-bar-fill" style="width:'+progress+'%;background:'+(progress===100?'#2D6A4F':'var(--gold)')+';">'+'</div></div>';
        h += '<div style="font-size:11px;color:#888;margin-bottom:6px;">'+progress+'% complete</div>';
      }
      h += docs.map((d,i) => '<div class="doc-item"><span style="font-size:15px;cursor:pointer;" onclick="toggleDoc(\''+c.id+'\','+i+')">'+(d.done?'✅':'❌')+'</span><span style="color:'+(d.done?'#2D6A4F':'#922B21')+';cursor:pointer;" onclick="toggleDoc(\''+c.id+'\','+i+'\')">'+d.name+'</span><button class="doc-del-btn" onclick="deleteCoupleDoc(\''+c.id+'\','+i+'\')">✕</button></div>').join('');
    }
    const _tl = c.timeline||[];
    h += '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;margin-bottom:4px;"><span class="couple-section-label" style="margin:0;">Timeline</span><button onclick="toggleCoupleTlForm(\''+c.id+'\')" style="font-size:12px;color:var(--cardinal);background:none;border:none;cursor:pointer;font-family:\'Inter\',sans-serif;padding:0;">+ Add update</button></div>';
    h += '<div id="couple-tl-form-'+c.id+'" style="display:none;background:var(--parch);border:.5px solid var(--stone);border-radius:var(--radius-sm);padding:.75rem;margin-bottom:.75rem;"><input type="date" id="couple-tl-date-'+c.id+'" value="'+todayCST()+'" style="width:100%;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .75rem;font-size:13px;font-family:\'Inter\',sans-serif;background:#FFFFFF;outline:none;margin-bottom:6px;" /><input type="text" id="couple-tl-event-'+c.id+'" placeholder="Update comment…" style="width:100%;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .75rem;font-size:13px;font-family:\'Inter\',sans-serif;background:#FFFFFF;outline:none;margin-bottom:6px;" /><div style="display:flex;gap:8px;"><button class="btn-primary" style="padding:.35rem .9rem;font-size:12px;" onclick="addCoupleTlEntry(\''+c.id+'\')">Save</button><button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="toggleCoupleTlForm(\''+c.id+'\')">Cancel</button></div></div>';
    if(_tl.length) {
      h += '<div class="tl-wrap">';
      h += _tl.map((e,i) => '<div class="tl-item" style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;"><div style="flex:1;"><div class="tl-dot"></div>'+(e.date?'<div class="tl-date">'+fmtDate(e.date)+'</div>':'')+'<div class="tl-event">'+e.event+'</div></div><button onclick="deleteCoupleTlEntry(\''+c.id+'\','+i+')" title="Delete" style="background:none;border:none;cursor:pointer;color:#AAA;font-size:14px;padding:0;flex-shrink:0;line-height:1;" onmouseover="this.style.color=\'#E74C3C\'" onmouseout="this.style.color=\'#AAA\'">✕</button></div>').join('');
      h += '</div>';
    } else {
      h += '<div style="font-size:13px;color:#6B7280;font-style:italic;padding:.25rem 0;">No timeline entries yet.</div>';
    }
    if(c.updated_at) {
      const _upd = new Date(c.updated_at);
      const _now = new Date(new Date().toLocaleString('en-US',{timeZone: store.parishSettings?.timezone || 'America/Chicago'}));
      const _days = Math.floor((_now-_upd)/86400000);
      const _updStr = _upd.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
      let _aging = '';
      if(_days>=60&&!c.archived&&c.status_code==='inprogress') {
        _aging = '<span style="font-size:11px;background:#FDF8EE;color:#854F0B;border-radius:20px;padding:2px 9px;margin-left:8px;">Inactive '+_days+' days</span>';
      }
      h += '<div style="font-size:11px;color:#AAA;margin-top:10px;margin-bottom:8px;">Last updated: '+_updStr+_aging+'</div>';
    }
    h += '<div style="margin-top:4px;"><button class="btn-primary" onclick="openCoupleEdit(\''+c.id+'\')">Edit</button></div>';
    h += '</div>';
  }
  h += '</div>';
  return h;
}

function toggleCouple(id) {expandedCoupleId=expandedCoupleId===id?null:id;renderCouples();}

// Called from other surfaces (e.g. message links) to navigate to & expand a couple
export async function expandCouple(id) {
  expandedCoupleId = id;
  window.switchPanel('marriage');
  await loadCouples();
  document.getElementById('couple-card-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function toggleDoc(coupleId, docIndex) {
  const couple = allCouples.find(c => c.id===coupleId);
  if(!couple) return;
  const docs = JSON.parse(JSON.stringify(couple.documents||[]));
  docs[docIndex].done = !docs[docIndex].done;
  const {error} = await sb.from('couples').update({documents:docs, updated_at:new Date().toISOString()}).eq('id',coupleId);
  if(error){console.error('[marriage] toggleDoc error:', error);return;}
  couple.documents = docs;
  renderCouples();
}

async function quickCoupleStatusChange(coupleId, newStatus) {
  const couple = allCouples.find(c => c.id===coupleId);
  if(!couple||couple.status_code===newStatus) return;
  const {error} = await sb.from('couples').update({status_code:newStatus,updated_at:new Date().toISOString()}).eq('id',coupleId);
  if(error){console.error('[marriage] statusChange error:', error);alert('Save failed: '+error.message);return;}
  couple.status_code = newStatus;
  if (newStatus === 'complete') {
    const { data: { user: _me } } = await sb.auth.getUser();
    const _uids = await getUserIdsForSacrament('marriage');
    const coupleName = [couple.groom, couple.bride].filter(Boolean).join(' & ');
    notifyUsers(_uids, _me?.id, `Marriage marked complete: ${coupleName}`, 'success', 'marriage', coupleId);
  }
  updateCoupleStats();
  renderMarriageAlerts();
  renderCouples();
}

function toggleCoupleNoteForm(coupleId) {
  const f = document.getElementById('couple-note-form-'+coupleId);
  if(!f) return;
  f.style.display = f.style.display==='none'?'block':'none';
  if(f.style.display==='block') document.getElementById('couple-note-text-'+coupleId).focus();
}

async function appendCoupleNote(coupleId) {
  const couple = allCouples.find(c => c.id===coupleId);
  if(!couple) return;
  const addition = document.getElementById('couple-note-text-'+coupleId).value.trim();
  if(!addition){alert('Please enter a note.');return;}
  const now = new Date(new Date().toLocaleString('en-US',{timeZone: store.parishSettings?.timezone || 'America/Chicago'}));
  const dateStr = (now.getMonth()+1)+'/'+now.getDate()+'/'+now.getFullYear();
  const newNotes = couple.notes?(couple.notes+'\n\n['+dateStr+'] '+addition):('['+dateStr+'] '+addition);
  const {error} = await sb.from('couples').update({notes:newNotes,updated_at:new Date().toISOString()}).eq('id',coupleId);
  if(error){console.error('[marriage] appendNote error:', error);alert('Save failed: '+error.message);return;}
  couple.notes = newNotes;
  renderCouples();
}

async function deleteCoupleNote(coupleId, noteIndex) {
  const couple = allCouples.find(c => c.id===coupleId);
  if(!couple) return;
  if(!confirm('Delete this note?')) return;
  const entries = couple.notes.split('\n\n').filter(n=>n.trim());
  entries.splice(noteIndex,1);
  const newNotes = entries.join('\n\n');
  const {error} = await sb.from('couples').update({notes:newNotes,updated_at:new Date().toISOString()}).eq('id',coupleId);
  if(error){console.error('[marriage] deleteNote error:', error);alert('Delete failed: '+error.message);return;}
  couple.notes = newNotes;
  renderCouples();
}

function toggleCoupleDocForm(coupleId) {
  const f = document.getElementById('couple-doc-form-'+coupleId);
  if(!f) return;
  f.style.display = f.style.display==='none'?'block':'none';
  if(f.style.display==='block') document.getElementById('couple-doc-name-'+coupleId).focus();
}

async function addCoupleDoc(coupleId) {
  const couple = allCouples.find(c => c.id===coupleId);
  if(!couple) return;
  const name = document.getElementById('couple-doc-name-'+coupleId).value.trim();
  if(!name){alert('Please enter a document name.');return;}
  const docs = JSON.parse(JSON.stringify(couple.documents||[]));
  docs.push({name, done:false});
  const {error} = await sb.from('couples').update({documents:docs,updated_at:new Date().toISOString()}).eq('id',coupleId);
  if(error){console.error('[marriage] addDoc error:', error);alert('Save failed: '+error.message);return;}
  couple.documents = docs;
  renderCouples();
}

async function deleteCoupleDoc(coupleId, docIndex) {
  const couple = allCouples.find(c => c.id===coupleId);
  if(!couple) return;
  if(!confirm('"'+couple.documents[docIndex].name+'" — delete?')) return;
  const docs = JSON.parse(JSON.stringify(couple.documents||[]));
  docs.splice(docIndex,1);
  const {error} = await sb.from('couples').update({documents:docs,updated_at:new Date().toISOString()}).eq('id',coupleId);
  if(error){console.error('[marriage] deleteDoc error:', error);alert('Delete failed: '+error.message);return;}
  couple.documents = docs;
  renderCouples();
}

function toggleCoupleTlForm(coupleId) {
  const f = document.getElementById('couple-tl-form-'+coupleId);
  if(!f) return;
  f.style.display = f.style.display==='none'?'block':'none';
  if(f.style.display==='block') document.getElementById('couple-tl-event-'+coupleId).focus();
}

async function addCoupleTlEntry(coupleId) {
  const couple = allCouples.find(c => c.id===coupleId);
  if(!couple) return;
  const date = document.getElementById('couple-tl-date-'+coupleId).value||null;
  const event = document.getElementById('couple-tl-event-'+coupleId).value.trim();
  if(!event){alert('Please enter a comment.');return;}
  const tl = JSON.parse(JSON.stringify(couple.timeline||[]));
  tl.push({date, event});
  const {error} = await sb.from('couples').update({timeline:tl,updated_at:new Date().toISOString()}).eq('id',coupleId);
  if(error){console.error('[marriage] addTimeline error:', error);alert('Save failed: '+error.message);return;}
  couple.timeline = tl;
  renderCouples();
}

async function deleteCoupleTlEntry(coupleId, index) {
  const couple = allCouples.find(c => c.id===coupleId);
  if(!couple) return;
  if(!confirm('Delete this timeline entry?')) return;
  const tl = JSON.parse(JSON.stringify(couple.timeline||[]));
  tl.splice(index,1);
  const {error} = await sb.from('couples').update({timeline:tl,updated_at:new Date().toISOString()}).eq('id',coupleId);
  if(error){console.error('[marriage] deleteTimeline error:', error);alert('Delete failed: '+error.message);return;}
  couple.timeline = tl;
  renderCouples();
}

// -- Prior-marriage modal helpers --

function pmCaseOptions(selectedId) {
  const cases = store.allCases||[];
  return '<option value="">-- none --</option>'+cases.map(ca =>
    '<option value="'+ca.id+'"'+(selectedId===ca.id?' selected':'')+'>'+ca.petitioner+(ca.respondent?' v. '+ca.respondent:'')+'</option>'
  ).join('');
}

function renderPmEditor(pmList, containerId) {
  const el = document.getElementById(containerId);
  if(!el) return;
  el.innerHTML = pmList.map((p, i) =>
    '<div style="background:var(--parch);border:.5px solid var(--stone);border-radius:var(--radius-sm);padding:.65rem .75rem;margin-bottom:.5rem;">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;"><span style="font-size:12px;font-weight:600;color:#555;">Prior marriage '+(i+1)+'</span><button type="button" onclick="removePm(\''+containerId+'\','+i+')" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:13px;padding:0;" onmouseover="this.style.color=\'#E74C3C\'" onmouseout="this.style.color=\'#CCC\'">✕ Remove</button></div>'
    + '<label style="font-size:12px;color:#555;display:block;margin-bottom:3px;">Ex-spouse name</label>'
    + '<input type="text" data-pm="'+containerId+'-'+i+'-name" value="'+(p.ex_spouse_name||'')+'" style="width:100%;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.35rem .6rem;font-size:13px;margin-bottom:6px;font-family:\'Inter\',sans-serif;background:#fff;outline:none;" />'
    + '<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#555;margin-bottom:6px;cursor:pointer;"><input type="checkbox" data-pm="'+containerId+'-'+i+'-granted" '+(p.annulment_granted?'checked':'')+' style="cursor:pointer;" /> Annulment granted</label>'
    + '<label style="font-size:12px;color:#555;display:block;margin-bottom:3px;">Linked annulment case</label>'
    + '<select data-pm="'+containerId+'-'+i+'-case" style="width:100%;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.35rem .6rem;font-size:13px;font-family:\'Inter\',sans-serif;background:#fff;outline:none;">'+pmCaseOptions(p.annulment_case_id||'')+'</select>'
    + '</div>'
  ).join('');
}

function readPmEditor(containerId, spouse) {
  const el = document.getElementById(containerId);
  if(!el) return [];
  const items = [];
  el.querySelectorAll('[data-pm]').forEach(input => {
    const key = input.getAttribute('data-pm');
    const lastDash = key.lastIndexOf('-');
    const field = key.slice(lastDash+1);
    const withoutField = key.slice(0, lastDash);
    const secondLastDash = withoutField.lastIndexOf('-');
    const idx = parseInt(withoutField.slice(secondLastDash+1));
    if(!items[idx]) items[idx] = {spouse};
    if(field==='name') items[idx].ex_spouse_name = input.value.trim();
    if(field==='granted') items[idx].annulment_granted = input.checked;
    if(field==='case') items[idx].annulment_case_id = input.value||null;
  });
  return items.filter(Boolean);
}

function addPm(containerId, spouse) {
  const existing = readPmEditor(containerId, spouse);
  existing.push({spouse, ex_spouse_name:'', annulment_granted:false, annulment_case_id:null});
  renderPmEditor(existing, containerId);
}

function removePm(containerId, idx) {
  const spouse = containerId.includes('bride') ? 'bride' : 'groom';
  const existing = readPmEditor(containerId, spouse);
  existing.splice(idx,1);
  renderPmEditor(existing, containerId);
}

// -- Form --

export function coupleForm(data) {
  const statuses = Object.entries(COUPLE_STATUS).map(([k,v]) => '<option value="'+k+'"'+(data?.status_code===k?' selected':'')+'>'+v.label+'</option>').join('');
  const marriageTypeOptions = '<option value="">-- select --</option>'+MARRIAGE_TYPES.map(t => '<option value="'+t+'"'+(data?.marriage_type===t?' selected':'')+'>'+t+'</option>').join('');
  return '<div class="modal-title">'+(data?'Edit — '+data.groom+' & '+data.bride:'Add couple')+'</div>'
  + '<label>Groom name</label><input id="f-groom" value="'+(data?.groom||'')+'" />'
  + '<label>Bride name</label><input id="f-bride" value="'+(data?.bride||'')+'" />'
  + '<label>Wedding date</label><input type="date" id="f-wd" value="'+(data?.wedding_date||'')+'" />'
  + '<label>Wedding time</label><input id="f-wt" value="'+(data?.wedding_time||'')+'" placeholder="e.g. 3:00 PM" />'
  + '<label>Location</label><input id="f-loc" value="'+(data?.location||'')+'" />'
  + '<label>Celebrant</label><input id="f-cel" value="'+(data?.celebrant||'')+'" />'
  + '<label>Type of marriage</label><select id="f-mtype">'+marriageTypeOptions+'</select>'
  + '<label>Status</label><select id="f-st">'+statuses+'</select>'
  + '<label>Bride phone</label><input id="f-bp" value="'+(data?.bride_phone||'')+'" />'
  + '<label>Bride email</label><input id="f-be" value="'+(data?.bride_email||'')+'" />'
  + '<label>Groom phone</label><input id="f-gp" value="'+(data?.groom_phone||'')+'" />'
  + '<label>Groom email</label><input id="f-ge" value="'+(data?.groom_email||'')+'" />'
  + '<label>Fee</label><input id="f-fee" value="'+(data?.fee||'')+'" />'
  + '<label>Notes</label><textarea id="f-notes">'+(data?.notes||'')+'</textarea>'
  + '<div style="margin-top:.5rem;margin-bottom:.25rem;font-size:13px;font-weight:600;color:var(--navy);border-top:.5px solid var(--stone);padding-top:.75rem;">Prior marriages — Bride</div>'
  + '<div id="pm-bride-list"></div>'
  + '<button type="button" onclick="addPm(\'pm-bride-list\',\'bride\')" style="font-size:12px;color:var(--cardinal);background:none;border:none;cursor:pointer;font-family:\'Inter\',sans-serif;padding:0;margin-bottom:.75rem;">+ Add prior marriage</button>'
  + '<div style="margin-top:.25rem;margin-bottom:.25rem;font-size:13px;font-weight:600;color:var(--navy);border-top:.5px solid var(--stone);padding-top:.75rem;">Prior marriages — Groom</div>'
  + '<div id="pm-groom-list"></div>'
  + '<button type="button" onclick="addPm(\'pm-groom-list\',\'groom\')" style="font-size:12px;color:var(--cardinal);background:none;border:none;cursor:pointer;font-family:\'Inter\',sans-serif;padding:0;margin-bottom:.75rem;">+ Add prior marriage</button>'
  + '<label><input type="checkbox" id="f-arch" '+(data?.archived?'checked':'')+' style="margin-right:6px;">Archived</label>'
  + '<div class="modal-actions" style="justify-content:space-between;">'
  + (data?'<button class="btn-delete" onclick="deleteCouple(\''+data.id+'\')">Delete</button>':'<span></span>')
  + '<div style="display:flex;gap:8px;"><button class="btn-secondary" onclick="closeModal()">Cancel</button><button class="btn-primary" onclick="saveCouple('+(data?'\''+data.id+'\'':'null')+')">Save</button></div>'
  + '</div>';
}

function initPmEditors(data) {
  const bridePm = (data?.prior_marriages||[]).filter(p=>p.spouse==='bride');
  const groomPm = (data?.prior_marriages||[]).filter(p=>p.spouse==='groom');
  renderPmEditor(bridePm, 'pm-bride-list');
  renderPmEditor(groomPm, 'pm-groom-list');
}

async function deleteCouple(id) {
  if(!confirm('Permanently delete this couple? This cannot be undone.')) return;
  const {error} = await sb.from('couples').delete().eq('id',id);
  if(error){console.error('[marriage] deleteCouple error:', error);alert('Delete failed: '+error.message);return;}
  closeModal(); loadCouples();
}

async function saveCouple(id) {
  const bridePm = readPmEditor('pm-bride-list', 'bride');
  const groomPm = readPmEditor('pm-groom-list', 'groom');
  const payload = {
    groom:document.getElementById('f-groom').value.trim(),
    bride:document.getElementById('f-bride').value.trim(),
    wedding_date:document.getElementById('f-wd').value||null,
    wedding_time:document.getElementById('f-wt').value.trim()||null,
    location:document.getElementById('f-loc').value.trim(),
    celebrant:document.getElementById('f-cel').value.trim(),
    marriage_type:document.getElementById('f-mtype').value||null,
    status_code:document.getElementById('f-st').value,
    bride_phone:document.getElementById('f-bp').value.trim()||null,
    bride_email:document.getElementById('f-be').value.trim()||null,
    groom_phone:document.getElementById('f-gp').value.trim()||null,
    groom_email:document.getElementById('f-ge').value.trim()||null,
    fee:document.getElementById('f-fee').value.trim()||null,
    notes:document.getElementById('f-notes').value.trim(),
    prior_marriages:[...bridePm, ...groomPm],
    archived:document.getElementById('f-arch').checked,
    updated_at:new Date().toISOString()
  };
  if(!payload.groom||!payload.bride){alert('Groom and bride names are required.');return;}
  let err;
  if(id){const r=await sb.from('couples').update(payload).eq('id',id);err=r.error;}
  else{const r=await sb.from('couples').insert(payload);err=r.error;}
  if(err){console.error('[marriage] saveCouple error:', err);alert('Save failed: '+err.message);return;}
  const coupleName = [payload.groom, payload.bride].filter(Boolean).join(' & ');
  logActivity({ action: id ? 'updated marriage prep record' : 'created marriage prep record', entityType: 'marriage', entityName: coupleName, contextType: 'couple', contextId: id || null });
  closeModal(); loadCouples();
}

function openCoupleEdit(id) {
  const c = allCouples.find(p => p.id===id);
  if(!c) return;
  document.getElementById('modal-content').innerHTML = coupleForm(c);
  document.getElementById('modal-overlay').classList.add('open');
  initPmEditors(c);
}

export function openCoupleAdd() {
  document.getElementById('modal-content').innerHTML = coupleForm(null);
  document.getElementById('modal-overlay').classList.add('open');
  initPmEditors(null);
}

Object.assign(window, {
  renderCouples, toggleCouple, openCoupleEdit, openCoupleAdd,
  toggleDoc, quickCoupleStatusChange,
  toggleCoupleNoteForm, appendCoupleNote, deleteCoupleNote,
  toggleCoupleDocForm, addCoupleDoc, deleteCoupleDoc,
  toggleCoupleTlForm, addCoupleTlEntry, deleteCoupleTlEntry,
  setCoupleFilter, saveCouple, deleteCouple,
  addPm, removePm,
  expandCase, expandCouple,
});
