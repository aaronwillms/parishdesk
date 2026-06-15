import { sb } from '../supabase.js';
import { store } from '../store.js';
import { fmtDate, todayCST } from '../utils.js';
import { getUserScope, isVisible } from '../ui/userScope.js';

const CAL_COLOR_MAP = { '2': 'school', '3': 'conf', '5': 'mass', '7': 'personal' };

let currentUserId = null;

function dotClass(colorId) {
  return (colorId && CAL_COLOR_MAP[colorId]) ? CAL_COLOR_MAP[colorId] : 'personal';
}

// ── Calendar ───────────────────────────────────────────────────────────────

export async function loadCalendar() {
  const c = document.getElementById('calendar-sched');
  if (!c) return;
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
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('stat-inprogress',  counts.in_progress);
  set('stat-blocked',     counts.blocked);
  set('stat-complete',    counts.complete);
  set('pstat-inprogress', counts.in_progress);
  set('pstat-blocked',    counts.blocked);
  set('pstat-complete',   counts.complete);
}

// ── Active Projects ────────────────────────────────────────────────────────

export function renderDashProjects() {
  const c = document.getElementById('dash-projects');
  if (!c) return;
  const blocked    = store.allProjects.filter(p => p.status_code === 'blocked').slice(0, 3);
  const inProgress = store.allProjects.filter(p => p.status_code === 'in_progress').slice(0, 5);
  let html = '';
  if (blocked.length) {
    html += `<div class="sec-label" style="color:#922B21;margin-bottom:.4rem;">Blocked</div>`;
    blocked.forEach(p => {
      html += `<div class="proj-row">
        <span class="sched-dot" style="background:#922B21;flex-shrink:0;margin-top:4px;"></span>
        <span class="proj-title">${p.title}</span>
        ${p.due_date ? `<span class="badge badge-urgent">${fmtDate(p.due_date)}</span>` : ''}
      </div>`;
    });
  }
  if (inProgress.length) {
    html += `<div class="sec-label" style="${blocked.length ? 'margin-top:10px;' : ''}margin-bottom:.4rem;">In progress</div>`;
    inProgress.forEach(p => {
      html += `<div class="proj-row">
        <span class="sched-dot dot-personal" style="flex-shrink:0;margin-top:4px;"></span>
        <span class="proj-title">${p.title}</span>
        ${p.due_date ? `<span class="badge badge-active">${fmtDate(p.due_date)}</span>` : ''}
      </div>`;
    });
  }
  c.innerHTML = html || '<div style="font-size:13px;color:#6B7280;font-style:italic;">No active projects.</div>';
}

// ── Announcements ──────────────────────────────────────────────────────────

let announcements = [];
let dismissedIds  = new Set();

export async function loadAnnouncements() {
  const today = todayCST();
  const [annRes, dimRes] = await Promise.all([
    sb.from('announcements')
      .select('*')
      .eq('active', true)
      .or(`expires_at.is.null,expires_at.gte.${today}`)
      .order('pinned', { ascending: false })
      .order('created_at', { ascending: false }),
    currentUserId
      ? sb.from('announcement_dismissals').select('announcement_id').eq('user_id', currentUserId)
      : Promise.resolve({ data: [] }),
  ]);
  if (annRes.error) console.error('[announcements] load error:', annRes.error);
  announcements = annRes.data || [];
  dismissedIds  = new Set((dimRes.data || []).map(d => d.announcement_id));
  renderAnnouncements();
}

function _teamName(id) {
  return (store.teams || []).find(t => t.id === id)?.name || null;
}

function _visibilityLabel(a) {
  if (!a.visible_to?.length) return '';
  const names = a.visible_to.map(id => _teamName(id)).filter(Boolean);
  if (!names.length) return '';
  return `<span style="font-size:11px;color:#8FA8BF;margin-left:4px;">· 👥 ${names.join(', ')}</span>`;
}

function renderAnnouncements() {
  const c = document.getElementById('dash-announcements');
  if (!c) return;
  const visible = announcements.filter(a => !dismissedIds.has(a.id));
  if (!visible.length) {
    c.innerHTML = '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No announcements.</div>';
    return;
  }
  c.innerHTML = visible.map(a => `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:.5rem 0;border-bottom:.5px solid var(--stone);" class="annc-item">
      <div style="flex:1;min-width:0;">
        ${a.pinned ? `<span style="font-size:10px;font-weight:700;letter-spacing:.06em;color:#922B21;text-transform:uppercase;margin-right:6px;">📌 Pinned</span>` : ''}
        <span style="font-size:14px;color:var(--navy);line-height:1.5;">${a.message}</span>
        <div style="font-size:11px;color:#9CA3AF;margin-top:3px;">
          ${timeAgo(a.created_at)}${a.expires_at ? ` · expires ${fmtDate(a.expires_at)}` : ''}${_visibilityLabel(a)}
        </div>
      </div>
      <button onclick="dismissAnnouncement('${a.id}')" title="Dismiss" style="background:none;border:none;cursor:pointer;color:#D1D5DB;font-size:14px;padding:0;flex-shrink:0;line-height:1;margin-top:2px;" onmouseover="this.style.color='#6B7280'" onmouseout="this.style.color='#D1D5DB'">✕</button>
    </div>`).join('');
}

async function dismissAnnouncement(id) {
  dismissedIds.add(id);
  renderAnnouncements();
  if (!currentUserId) return;
  const { error } = await sb.from('announcement_dismissals').insert({ announcement_id: id, user_id: currentUserId });
  if (error && error.code !== '23505') console.error('[announcements] dismiss error:', error);
}

function openAnnouncementModal(data) {
  document.getElementById('modal-content').innerHTML = announcementForm(data);
  document.getElementById('modal-overlay').classList.add('open');
}

function announcementForm(data) {
  const existingTeamIds = new Set(data?.visible_to || []);
  const visAll = !existingTeamIds.size;
  const teams  = store.teams || [];

  const teamCheckboxes = teams.length
    ? teams.map(t => `
        <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:.5px solid #F0EDE8;cursor:pointer;">
          <input type="checkbox" class="af-team-cb" value="${t.id}" ${existingTeamIds.has(t.id) ? 'checked' : ''}
            style="width:14px;height:14px;accent-color:var(--cardinal);flex-shrink:0;margin:0;cursor:pointer;" />
          <span style="font-size:13px;color:var(--navy);">${t.name}</span>
        </div>`).join('')
    : '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No teams found.</div>';

  return `<div class="modal-title">${data ? 'Edit announcement' : 'Add announcement'}</div>
  <label>Message</label><textarea id="af-msg" rows="3">${data?.message || ''}</textarea>
  <label>Expires (optional)</label><input type="date" id="af-exp" value="${data?.expires_at || ''}" />
  <div style="display:flex;align-items:center;gap:8px;margin:.5rem 0;">
    <input type="checkbox" id="af-pin" ${data?.pinned ? 'checked' : ''} style="width:15px;height:15px;accent-color:var(--cardinal);" />
    <label for="af-pin" style="margin:0;cursor:pointer;">Pin to top</label>
  </div>
  <label>Visible to</label>
  <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px;">
    <div style="display:flex;align-items:center;gap:8px;cursor:pointer;" onclick="document.getElementById('af-vis-all').click()">
      <input type="radio" name="af-vis" id="af-vis-all" value="all" ${visAll ? 'checked' : ''}
        style="accent-color:var(--cardinal);margin:0;flex-shrink:0;cursor:pointer;"
        onchange="document.getElementById('af-teams-wrap').style.display='none'" />
      <span style="font-size:13px;cursor:pointer;">All staff</span>
    </div>
    <div style="display:flex;align-items:center;gap:8px;cursor:pointer;" onclick="document.getElementById('af-vis-teams').click()">
      <input type="radio" name="af-vis" id="af-vis-teams" value="teams" ${!visAll ? 'checked' : ''}
        style="accent-color:var(--cardinal);margin:0;flex-shrink:0;cursor:pointer;"
        onchange="document.getElementById('af-teams-wrap').style.display='block'" />
      <span style="font-size:13px;cursor:pointer;">Specific teams…</span>
    </div>
  </div>
  <div id="af-teams-wrap" style="display:${visAll ? 'none' : 'block'};background:var(--parch);border:.5px solid var(--stone);border-radius:var(--radius-sm);padding:.6rem .75rem;margin-bottom:8px;max-height:200px;overflow-y:auto;">
    ${teamCheckboxes}
  </div>
  <div class="modal-actions" style="justify-content:space-between;">
    ${data ? `<button class="btn-delete" onclick="deleteAnnouncement('${data.id}')">Delete</button>` : '<span></span>'}
    <div style="display:flex;gap:8px;">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" onclick="saveAnnouncement(${data ? `'${data.id}'` : null})">Save</button>
    </div>
  </div>`;
}

async function saveAnnouncement(id) {
  const message = document.getElementById('af-msg').value.trim();
  if (!message) { alert('Message is required.'); return; }

  const visAll = document.getElementById('af-vis-all')?.checked !== false &&
                 document.querySelector('input[name="af-vis"]:checked')?.value !== 'teams';
  let visible_to = null;
  if (!visAll) {
    const checked = Array.from(document.querySelectorAll('.af-team-cb:checked')).map(cb => cb.value);
    visible_to = checked.length ? checked : null;
  }

  const payload = {
    message,
    expires_at: document.getElementById('af-exp').value || null,
    pinned:     !!document.getElementById('af-pin').checked,
    visible_to,
    active:     true,
  };
  let err;
  if (id) {
    const r = await sb.from('announcements').update(payload).eq('id', id); err = r.error;
  } else {
    const r = await sb.from('announcements').insert({ ...payload, created_by: currentUserId }); err = r.error;
  }
  if (err) { alert('Save failed: ' + err.message); return; }
  closeModal();
  loadAnnouncements();
}

async function deleteAnnouncement(id) {
  if (!confirm('Delete this announcement?')) return;
  const { error } = await sb.from('announcements').update({ active: false }).eq('id', id);
  if (error) { alert('Delete failed: ' + error.message); return; }
  closeModal();
  loadAnnouncements();
}

// ── Activity Feed ──────────────────────────────────────────────────────────

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins  <  1) return 'just now';
  if (mins  < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days  === 1) return 'yesterday';
  if (days  <  7) return `${days} days ago`;
  return fmtDate(ts.slice(0, 10));
}

const FEED_ICONS = {
  couple:   '💍',
  case:     '⚖️',
  ocia:     '✝',
  project:  '📋',
  task:     '☑',
};

const SUPER_ADMIN_EMAILS_FEED = ['aaron.willms@icloud.com'];

// Programs whose coordinator_ids include personnelId
async function _coordinatorPrograms(personnelId) {
  if (!personnelId) return new Set();
  const { data } = await sb
    .from('program_coordinators')
    .select('program,coordinator_ids');
  const programs = new Set();
  (data || []).forEach(row => {
    if ((row.coordinator_ids || []).includes(personnelId)) programs.add(row.program);
  });
  return programs;
}

async function loadActivityFeed() {
  const limit = 15;
  const { data: { user } } = await sb.auth.getUser();
  const isSuperAdmin = SUPER_ADMIN_EMAILS_FEED.includes(user?.email);

  const scope = await getUserScope();
  const { personnelId, teamIds } = scope;

  // Accessible project IDs come from already-scoped store
  const accessibleProjectIds = new Set((store.allProjects || []).map(p => p.id));

  // Sacramental coordinator programs (marriage covers couples; annulments covers cases; ocia covers ocia)
  const coordPrograms = isSuperAdmin
    ? new Set(['marriage', 'annulments', 'ocia', 'baptism', 'firstcomm', 'confirmation'])
    : await _coordinatorPrograms(personnelId);

  const queries = [
    sb.from('projects').select('id,title,updated_at').order('updated_at', { ascending: false }).limit(limit),
    sb.from('tasks').select('id,title,updated_at,created_by,assigned_to,team_id').order('updated_at', { ascending: false }).limit(limit),
  ];
  if (isSuperAdmin || coordPrograms.has('marriage'))   queries.push(sb.from('couples').select('id,groom_name,bride_name,updated_at').order('updated_at', { ascending: false }).limit(limit));
  if (isSuperAdmin || coordPrograms.has('annulments')) queries.push(sb.from('annulment_cases').select('id,petitioner,respondent,updated_at').order('updated_at', { ascending: false }).limit(limit));
  if (isSuperAdmin || coordPrograms.has('ocia'))       queries.push(sb.from('sacramental_ocia').select('id,name,updated_at').order('updated_at', { ascending: false }).limit(limit));

  const [projRes, tasksRes, ...sacRes] = await Promise.all(queries);

  const items = [];

  // Projects — filter to accessible IDs
  (projRes.data || []).filter(r => isSuperAdmin || accessibleProjectIds.has(r.id)).forEach(r => {
    items.push({ icon: FEED_ICONS.project, label: 'Project updated', name: r.title || 'Unknown', ts: r.updated_at });
  });

  // Tasks — apply same visibility logic
  (tasksRes.data || []).filter(r => isSuperAdmin || isVisible(r, scope)).forEach(r => {
    items.push({ icon: FEED_ICONS.task, label: 'Task updated', name: r.title || 'Unknown', ts: r.updated_at });
  });

  // Sacramental — only fetched if coordinator, so include all returned rows
  let sacIdx = 0;
  if (isSuperAdmin || coordPrograms.has('marriage')) {
    (sacRes[sacIdx++]?.data || []).forEach(r => {
      const name = [r.groom_name, r.bride_name].filter(Boolean).join(' & ') || 'Unknown couple';
      items.push({ icon: FEED_ICONS.couple, label: 'Marriage prep updated', name, ts: r.updated_at });
    });
  }
  if (isSuperAdmin || coordPrograms.has('annulments')) {
    (sacRes[sacIdx++]?.data || []).forEach(r => {
      const name = [r.petitioner, r.respondent].filter(Boolean).join(' v. ') || 'Unknown case';
      items.push({ icon: FEED_ICONS.case, label: 'Annulment case updated', name, ts: r.updated_at });
    });
  }
  if (isSuperAdmin || coordPrograms.has('ocia')) {
    (sacRes[sacIdx++]?.data || []).forEach(r => {
      items.push({ icon: FEED_ICONS.ocia, label: 'OCIA record updated', name: r.name || 'Unknown', ts: r.updated_at });
    });
  }

  items.sort((a, b) => new Date(b.ts) - new Date(a.ts));

  const c = document.getElementById('dash-activity');
  if (!c) return;
  const top10 = items.slice(0, 10);
  if (!top10.length) {
    c.innerHTML = '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No recent activity.</div>';
    return;
  }
  c.innerHTML = top10.map(item => `
    <div style="display:flex;align-items:baseline;gap:10px;padding:.45rem 0;border-bottom:.5px solid var(--stone);">
      <span style="font-size:15px;flex-shrink:0;">${item.icon}</span>
      <div style="flex:1;min-width:0;">
        <span style="font-size:13px;color:#6B7280;">${item.label}</span>
        <span style="font-size:13px;font-weight:500;color:var(--navy);"> · ${item.name}</span>
      </div>
      <span style="font-size:11.5px;color:#9CA3AF;flex-shrink:0;white-space:nowrap;">${timeAgo(item.ts)}</span>
    </div>`).join('');
}

// ── loadInit ───────────────────────────────────────────────────────────────

export async function loadInit() {
  const topbar = document.getElementById('topbar-season');
  try {
    const { data: authData } = await sb.auth.getUser();
    currentUserId = authData?.user?.id || null;

    const [projRes, caseRes, coupleRes, alertRes, tasksRes, scope] = await Promise.all([
      sb.from('projects').select('id,title,status_code,due_date,assigned_to,team_id,created_by').order('due_date', { nullsFirst: false }),
      sb.from('annulment_cases').select('id,status_code,archived,petitioner,respondent,judgement_finalized'),
      sb.from('couples').select('id,status_code,archived'),
      sb.from('alerts').select('*').eq('active', true),
      sb.from('tasks').select('id,title,due_date,completed,assigned_to,team_id,visibility').order('due_date', { nullsFirst: false }),
      getUserScope(),
    ]);

    if (projRes.error)   console.error('projects error:',   projRes.error.message);
    if (caseRes.error)   console.error('cases error:',      caseRes.error.message);
    if (coupleRes.error) console.error('couples error:',    coupleRes.error.message);
    if (alertRes.error)  console.error('alerts error:',     alertRes.error.message);
    if (tasksRes.error)  console.error('tasks error:',      tasksRes.error.message);

    store.allProjects = (projRes.data || []).filter(p => isVisible(p, scope));
    store._projectScopeReady = scope.ready;
    updateProjectStats();
    renderDashProjects();

    store.allCases = caseRes.data || [];
    const activeCases = store.allCases.filter(c => !c.archived);
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('stat-cases',           activeCases.length);
    set('stat-tribunal',        activeCases.filter(c => ['tribunal','affirm','negative'].includes(c.status_code)).length);
    set('stat-prep',            activeCases.filter(c => c.status_code === 'prep').length);

    const activeCouples = (coupleRes.data || []).filter(c => !c.archived);
    set('stat-couples',         activeCouples.length);
    set('stat-nearly',          activeCouples.filter(c => c.status_code === 'complete').length);
    set('stat-needs-attention', activeCouples.filter(c => c.status_code === 'inprogress').length);

    store.allTasks = tasksRes.data || [];

    const ac = document.getElementById('alert-strip-container');
    if (alertRes.data?.length) {
      ac.innerHTML = alertRes.data.map(a =>
        `<div class="alert-strip"><i class="ti ti-alert-triangle"></i><div class="alert-text">${a.message}</div></div>`
      ).join('');
    }

    if (topbar) topbar.style.display = '';

    // Load announcements and activity feed in parallel (non-blocking)
    loadAnnouncements();
    loadActivityFeed();
  } catch (e) {
    console.error('loadInit failed:', e);
    if (topbar) topbar.textContent = '⚠ Database error — reload to retry';
  }
}

Object.assign(window, {
  loadCalendar,
  dismissAnnouncement,
  openAnnouncementModal,
  saveAnnouncement,
  deleteAnnouncement,
});
