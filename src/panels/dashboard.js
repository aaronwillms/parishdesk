import { sb } from '../supabase.js';
import { store } from '../store.js';
import { fmtDate } from '../utils.js';

// TODO: During local dev with `npm run dev` (Vite only), the calendar endpoint
// returns 404 and renders "Could not load schedule" gracefully. Use `netlify dev`
// to run the calendar function locally.
const CAL_COLOR_MAP = {'2':'school','3':'conf','5':'mass','7':'personal'};

function dotClass(colorId) {
  if(colorId && CAL_COLOR_MAP[colorId]) return CAL_COLOR_MAP[colorId];
  return 'personal';
}

export async function loadCalendar() {
  const c = document.getElementById('calendar-sched');
  c.innerHTML = '<span class="pulse"></span>';
  try {
    const res = await fetch('/.netlify/functions/calendar');
    if(!res.ok) throw new Error('Calendar fetch failed: ' + res.status);
    const events = await res.json();
    if(!events.length) {
      c.innerHTML = '<div style="font-size:13px;color:#6B7280;font-style:italic;">No events today.</div>';
      return;
    }
    c.innerHTML = events.map(e => `<div class="sched-item"><span class="sched-time">${e.time}</span><span class="sched-dot dot-${dotClass(e.colorId)}"></span><div class="sched-desc">${e.title}</div></div>`).join('');
  } catch(e) {
    console.error('Calendar error:', e);
    c.innerHTML = '<div style="font-size:13px;color:#922B21;">Could not load schedule — check console.</div>';
  }
}

export function updateProjectStats() {
  const counts = {deadline:0, action:0, waiting:0};
  store.allProjects.forEach(p => { if(counts[p.status_code] !== undefined) counts[p.status_code]++; });
  document.getElementById('stat-deadlines').textContent = counts.deadline;
  document.getElementById('stat-action').textContent = counts.action;
  document.getElementById('stat-waiting').textContent = counts.waiting;
  const pDl = document.getElementById('pstat-deadlines');
  if(pDl) {
    pDl.textContent = counts.deadline;
    document.getElementById('pstat-action').textContent = counts.action;
    document.getElementById('pstat-waiting').textContent = counts.waiting;
  }
}

export function renderDashProjects() {
  const c = document.getElementById('dash-projects');
  const today = new Date(new Date().toLocaleString('en-US', {timeZone:'America/Chicago'}));
  const in14 = new Date(today); in14.setDate(in14.getDate() + 14);
  const deadlines = store.allProjects.filter(p => p.status_code==='deadline' && p.due_date && new Date(p.due_date)<=in14).slice(0,5);
  const actions = store.allProjects.filter(p => p.status_code==='action').slice(0,3);
  let html = '';
  if(deadlines.length) {
    html += `<div class="sec-label">Deadlines — next 14 days</div>`;
    deadlines.forEach(p => { html += `<div class="proj-row"><span class="sched-dot" style="background:#D4AC0D;flex-shrink:0;margin-top:4px;"></span><span class="proj-title">${p.title}</span><span class="badge badge-urgent">${fmtDate(p.due_date)}</span></div>`; });
  }
  const upcoming = store.allProjects.filter(p => p.status_code==='deadline' && p.due_date && new Date(p.due_date)>in14).slice(0,3);
  if(upcoming.length) html += `<div style="font-size:12px;color:#6B7280;padding:.25rem 0 .125rem;font-style:italic;">Approaching: ${upcoming.map(p=>`${p.title.split('—')[0].trim()} ${fmtDate(p.due_date)}`).join(' · ')}</div>`;
  if(actions.length) {
    html += `<div class="sec-label" style="margin-top:10px;">My action</div>`;
    actions.forEach(p => { html += `<div class="proj-row"><span class="sched-dot dot-personal" style="flex-shrink:0;margin-top:4px;"></span><span class="proj-title">${p.title}</span><span class="badge badge-active">Action</span></div>`; });
  }
  c.innerHTML = html || '<div style="font-size:13px;color:#6B7280;">No active items.</div>';
}

export async function loadInit() {
  const now = new Date(new Date().toLocaleString('en-US', {timeZone:'America/Chicago'}));
  const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const topbar = document.getElementById('topbar-season');
  try {
    const [projRes, caseRes, coupleRes, collectRes, alertRes] = await Promise.all([
      sb.from('projects').select('id,title,status_code,due_date,date_note,type,owner').order('sort_order').order('due_date',{nullsFirst:false}),
      // Expanded select so store.allCases has petitioner/respondent for OCIA dropdowns
      sb.from('annulment_cases').select('id,status_code,archived,petitioner,respondent'),
      sb.from('couples').select('id,status_code,archived'),
      sb.from('collect_cache').select('collect_text').eq('feast_date',dateStr).maybeSingle(),
      sb.from('alerts').select('*').eq('active',true)
    ]);
    if(projRes.error)   console.error('projects error:',   projRes.error.message);
    if(caseRes.error)   console.error('cases error:',      caseRes.error.message);
    if(coupleRes.error) console.error('couples error:',    coupleRes.error.message);
    if(collectRes.error)console.error('collect error:',    collectRes.error.message);
    if(alertRes.error)  console.error('alerts error:',     alertRes.error.message);

    store.allProjects = projRes.data || [];
    updateProjectStats();
    renderDashProjects();

    store.allCases = caseRes.data || [];
    const activeCases = store.allCases.filter(c => !c.archived);
    document.getElementById('stat-cases').textContent = activeCases.length;
    document.getElementById('stat-tribunal').textContent = activeCases.filter(c => ['tribunal','affirm','negative'].includes(c.status_code)).length;
    document.getElementById('stat-prep').textContent = activeCases.filter(c => c.status_code==='prep').length;

    const activeCouples = (coupleRes.data||[]).filter(c => !c.archived);
    document.getElementById('stat-couples').textContent = activeCouples.length;
    document.getElementById('stat-nearly').textContent = activeCouples.filter(c => c.status_code==='complete').length;
    document.getElementById('stat-needs-attention').textContent = activeCouples.filter(c => c.status_code==='inprogress').length;

    const cc = document.getElementById('collect-container');
    if(collectRes.data?.collect_text) {
      cc.innerHTML = `<p style="font-family:'Cormorant Garamond',serif;font-size:18px;line-height:1.9;color:var(--navy);font-style:italic;margin:0;">${collectRes.data.collect_text}</p>`;
    } else {
      cc.innerHTML = `<p style="font-family:'Cormorant Garamond',serif;font-size:15px;line-height:1.9;color:#6B7280;margin:0;">Collect not yet in database for ${dateStr}.</p>`;
    }

    const ac = document.getElementById('alert-strip-container');
    if(alertRes.data?.length) {
      ac.innerHTML = alertRes.data.map(a => `<div class="alert-strip"><i class="ti ti-alert-triangle"></i><div class="alert-text">${a.message}</div></div>`).join('');
    }

    if(topbar) topbar.style.display = '';
  } catch(e) {
    console.error('loadInit failed:', e);
    if(topbar) topbar.textContent = '⚠ Database error — reload to retry';
  }
}

Object.assign(window, { loadCalendar });
