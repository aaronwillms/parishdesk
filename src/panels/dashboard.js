import { sb } from '../supabase.js';
import { store } from '../store.js';
import { fmtDate, todayCST } from '../utils.js';

const CAL_COLOR_MAP = { '2': 'school', '3': 'conf', '5': 'mass', '7': 'personal' };

function dotClass(colorId) {
  return (colorId && CAL_COLOR_MAP[colorId]) ? CAL_COLOR_MAP[colorId] : 'personal';
}

export async function loadCalendar() {
  const c = document.getElementById('calendar-sched');
  c.innerHTML = '<span class="pulse"></span>';
  try {
    const res = await fetch('/.netlify/functions/calendar');
    if (!res.ok) throw new Error('Calendar fetch failed: ' + res.status);
    const events = await res.json();
    if (!events.length) {
      c.innerHTML = '<div style="font-size:13px;color:#6B7280;font-style:italic;">No events today.</div>';
      return;
    }
    c.innerHTML = events.map(e =>
      `<div class="sched-item"><span class="sched-time">${e.time}</span><span class="sched-dot dot-${dotClass(e.colorId)}"></span><div class="sched-desc">${e.title}</div></div>`
    ).join('');
  } catch (e) {
    console.error('Calendar error:', e);
    c.innerHTML = '<div style="font-size:13px;color:#922B21;">Could not load schedule — check console.</div>';
  }
}

// ── Project stats ──────────────────────────────────────────────────────────

export function updateProjectStats() {
  const counts = { in_progress: 0, blocked: 0, complete: 0 };
  store.allProjects.forEach(p => {
    if (counts[p.status_code] !== undefined) counts[p.status_code]++;
  });

  // Dashboard stat cards
  const ds_ip = document.getElementById('stat-inprogress');
  const ds_bl = document.getElementById('stat-blocked');
  const ds_co = document.getElementById('stat-complete');
  if (ds_ip) ds_ip.textContent = counts.in_progress;
  if (ds_bl) ds_bl.textContent = counts.blocked;
  if (ds_co) ds_co.textContent = counts.complete;

  // Projects panel stat cards
  const ps_ip = document.getElementById('pstat-inprogress');
  const ps_bl = document.getElementById('pstat-blocked');
  const ps_co = document.getElementById('pstat-complete');
  if (ps_ip) ps_ip.textContent = counts.in_progress;
  if (ps_bl) ps_bl.textContent = counts.blocked;
  if (ps_co) ps_co.textContent = counts.complete;
}

export function renderDashProjects() {
  const c = document.getElementById('dash-projects');
  if (!c) return;
  const blocked    = store.allProjects.filter(p => p.status_code === 'blocked').slice(0, 3);
  const inProgress = store.allProjects.filter(p => p.status_code === 'in_progress').slice(0, 4);
  let html = '';
  if (blocked.length) {
    html += `<div class="sec-label" style="color:#922B21;">Blocked</div>`;
    blocked.forEach(p => {
      html += `<div class="proj-row"><span class="sched-dot" style="background:#922B21;flex-shrink:0;margin-top:4px;"></span>
        <span class="proj-title">${p.title}</span>
        ${p.due_date ? `<span class="badge badge-urgent">${fmtDate(p.due_date)}</span>` : ''}
      </div>`;
    });
  }
  if (inProgress.length) {
    html += `<div class="sec-label" style="${blocked.length ? 'margin-top:10px;' : ''}">In progress</div>`;
    inProgress.forEach(p => {
      html += `<div class="proj-row"><span class="sched-dot dot-personal" style="flex-shrink:0;margin-top:4px;"></span>
        <span class="proj-title">${p.title}</span>
        ${p.due_date ? `<span class="badge badge-active">${fmtDate(p.due_date)}</span>` : ''}
      </div>`;
    });
  }
  c.innerHTML = html || '<div style="font-size:13px;color:#6B7280;">No active items.</div>';
}

// ── Tasks today ────────────────────────────────────────────────────────────

export function renderDashTasks() {
  const c = document.getElementById('dash-tasks');
  if (!c) return;
  const today = todayCST();
  const due = (store.allTasks || []).filter(t => !t.completed && t.due_date === today);
  const overdue = (store.allTasks || []).filter(t => !t.completed && t.due_date && t.due_date < today);
  if (!due.length && !overdue.length) {
    c.innerHTML = '<div style="font-size:13px;color:#6B7280;font-style:italic;">No tasks due today.</div>';
    return;
  }
  let html = '';
  if (overdue.length) {
    html += `<div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:#922B21;text-transform:uppercase;margin-bottom:.35rem;">Overdue</div>`;
    overdue.slice(0, 3).forEach(t => {
      html += `<div class="proj-row"><span class="sched-dot" style="background:#922B21;flex-shrink:0;margin-top:4px;"></span>
        <span class="proj-title">${t.title}</span>
        <span class="badge badge-urgent">${fmtDate(t.due_date)}</span>
      </div>`;
    });
  }
  if (due.length) {
    html += `<div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:#1B4F72;text-transform:uppercase;margin-bottom:.35rem;${overdue.length ? 'margin-top:8px;' : ''}">Today</div>`;
    due.slice(0, 5).forEach(t => {
      html += `<div class="proj-row"><span class="sched-dot dot-personal" style="flex-shrink:0;margin-top:4px;"></span>
        <span class="proj-title">${t.title}</span>
      </div>`;
    });
  }
  c.innerHTML = html;
}

// ── loadInit ───────────────────────────────────────────────────────────────

export async function loadInit() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const topbar = document.getElementById('topbar-season');
  try {
    const [projRes, caseRes, coupleRes, collectRes, alertRes, tasksRes] = await Promise.all([
      sb.from('projects').select('id,title,status_code,due_date,assigned_to,team_id').order('due_date', { nullsFirst: false }),
      sb.from('annulment_cases').select('id,status_code,archived,petitioner,respondent,judgement_finalized'),
      sb.from('couples').select('id,status_code,archived'),
      sb.from('collect_cache').select('collect_text').eq('feast_date', dateStr).maybeSingle(),
      sb.from('alerts').select('*').eq('active', true),
      sb.from('tasks').select('id,title,due_date,completed,assigned_to,team_id,visibility').order('due_date', { nullsFirst: false }),
    ]);

    if (projRes.error)   console.error('projects error:',   projRes.error.message);
    if (caseRes.error)   console.error('cases error:',      caseRes.error.message);
    if (coupleRes.error) console.error('couples error:',    coupleRes.error.message);
    if (collectRes.error)console.error('collect error:',    collectRes.error.message);
    if (alertRes.error)  console.error('alerts error:',     alertRes.error.message);
    if (tasksRes.error)  console.error('tasks error:',      tasksRes.error.message);

    store.allProjects = projRes.data || [];
    updateProjectStats();
    renderDashProjects();

    store.allCases = caseRes.data || [];
    const activeCases = store.allCases.filter(c => !c.archived);
    document.getElementById('stat-cases').textContent     = activeCases.length;
    document.getElementById('stat-tribunal').textContent  = activeCases.filter(c => ['tribunal', 'affirm', 'negative'].includes(c.status_code)).length;
    document.getElementById('stat-prep').textContent      = activeCases.filter(c => c.status_code === 'prep').length;

    const activeCouples = (coupleRes.data || []).filter(c => !c.archived);
    document.getElementById('stat-couples').textContent       = activeCouples.length;
    document.getElementById('stat-nearly').textContent        = activeCouples.filter(c => c.status_code === 'complete').length;
    document.getElementById('stat-needs-attention').textContent = activeCouples.filter(c => c.status_code === 'inprogress').length;

    store.allTasks = tasksRes.data || [];
    renderDashTasks();

    const cc = document.getElementById('collect-container');
    if (collectRes.data?.collect_text) {
      cc.innerHTML = `<p style="font-family:'Cormorant Garamond',serif;font-size:18px;line-height:1.9;color:var(--navy);font-style:italic;margin:0;">${collectRes.data.collect_text}</p>`;
    } else {
      cc.innerHTML = `<p style="font-family:'Cormorant Garamond',serif;font-size:15px;line-height:1.9;color:#6B7280;margin:0;">Collect not yet in database for ${dateStr}.</p>`;
    }

    const ac = document.getElementById('alert-strip-container');
    if (alertRes.data?.length) {
      ac.innerHTML = alertRes.data.map(a =>
        `<div class="alert-strip"><i class="ti ti-alert-triangle"></i><div class="alert-text">${a.message}</div></div>`
      ).join('');
    }

    if (topbar) topbar.style.display = '';
  } catch (e) {
    console.error('loadInit failed:', e);
    if (topbar) topbar.textContent = '⚠ Database error — reload to retry';
  }
}

Object.assign(window, { loadCalendar });
