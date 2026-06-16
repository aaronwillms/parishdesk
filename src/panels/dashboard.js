import { sb } from '../supabase.js';
import { store } from '../store.js';
import { fmtDate, todayCST, logActivity } from '../utils.js';
import { getUserScope, isVisible } from '../ui/userScope.js';
import { isSuperAdmin, isAdmin } from '../roles.js';
import { parseICS } from '../utils/icsParser.js';
import { createAvatar } from '../ui/avatar.js';
import { notifyUsers, getAllUserIds, getUserIdsForTeam } from '../notifications.js';

let currentUserId     = null;
let _dashPersonnelId  = null;
let _nowInterval      = null;
let _calendarEvents   = [];  // last-rendered event list for interval re-checks

function dotClass(colorId) {
  return (colorId && CAL_COLOR_MAP[colorId]) ? CAL_COLOR_MAP[colorId] : 'personal';
}

// ── Calendar ───────────────────────────────────────────────────────────────

function _fmtEventTime(date, allDay) {
  if (allDay) return 'All day';
  const tz = store.parishSettings?.timezone || 'America/Chicago';
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz });
}

function _fmtEventDate(date) {
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

async function _fetchICS(url) {
  const proxyUrl = '/calendar?url=' + encodeURIComponent(url);
  const res = await fetch(proxyUrl);
  if (!res.ok) throw new Error('ICS fetch failed: ' + res.status);
  return res.text();
}

function _renderCalendarEvents() {
  const c = document.getElementById('calendar-sched');
  if (!c || !_calendarEvents.length) return;

  const now = new Date();
  const parishTz = store.parishSettings?.timezone || 'America/Chicago';

  c.innerHTML = _calendarEvents.map(ev => {
    if (ev._stub) {
      return `<div class="sched-item" style="opacity:.55;font-style:italic;">
        <span class="sched-dot" style="background:${ev._calColor};flex-shrink:0;"></span>
        <div class="sched-desc" style="font-size:12.5px;color:#9CA3AF;">${ev.title}</div>
      </div>`;
    }

    const start   = new Date(ev.start);
    const end     = ev.end ? new Date(ev.end) : new Date(start.getTime() + 60 * 60 * 1000);
    const isNow   = !ev.allDay && now >= start && now <= end;

    const itemStyle = isNow
      ? 'background:#F3F4F6;border-left:3px solid #2E7D32;padding-left:8px;margin-left:-8px;border-radius:0 4px 4px 0;'
      : '';

    const leadDot = isNow
      ? `<span class="event-now-dot" style="margin-top:3px;"></span>`
      : `<span class="sched-dot" style="background:${ev._calColor};flex-shrink:0;margin-top:3px;"></span>`;

    return `<div class="sched-item" style="${itemStyle}">
      ${leadDot}
      <div style="flex:1;min-width:0;">
        <div class="sched-desc">${ev.title}</div>
        <div style="font-size:11.5px;color:#9CA3AF;margin-top:1px;">
          ${_fmtEventDate(ev.start)}${ev.allDay ? '' : ' · ' + _fmtEventTime(ev.start, false)}
          <span style="margin-left:4px;">${ev._calName}</span>
        </div>
      </div>
    </div>`;
  }).join('');
}

export async function loadCalendar() {
  const c = document.getElementById('calendar-sched');
  if (!c) return;
  c.innerHTML = '<span class="pulse"></span>';

  try {
    // Fetch parish-wide ICS/Google calendars AND the current user's personal Google Calendar
    const [parishRes, personalRes] = await Promise.all([
      sb.from('calendars').select('id, name, type, url, color').eq('scope', 'parish').eq('active', true),
      currentUserId
        ? sb.from('calendars').select('id, name, type, color').eq('scope', 'personal').eq('type', 'google').eq('user_id', currentUserId).eq('active', true).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    if (parishRes.error) throw parishRes.error;

    // Merge: parish calendars first, then personal Google if present and not already covered
    const parishCals = parishRes.data || [];
    const hasParishGoogle = parishCals.some(c => c.type === 'google');
    const cals = personalRes.data && !hasParishGoogle
      ? [...parishCals, { ...personalRes.data, _personalGoogle: true }]
      : parishCals;

    if (!cals.length) {
      c.innerHTML = '<div style="font-size:13px;color:#6B7280;font-style:italic;">No calendars configured.</div>';
      return;
    }

    const now = new Date();
    const parishTz = store.parishSettings?.timezone || 'America/Chicago';
    const todayStr = now.toLocaleDateString('en-CA', { timeZone: parishTz }); // YYYY-MM-DD in parish tz
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const endOfDay   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).toISOString();

    const allEvents = [];

    await Promise.allSettled(cals.map(async (cal) => {
      if (cal.type === 'google') {
        try {
          console.log('[dashboard] fetching google calendar events for userId:', currentUserId);
          const proxyRes = await fetch('/google-calendar-proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: currentUserId, action: 'list', timeMin: startOfDay, timeMax: endOfDay }),
          });
          if (!proxyRes.ok) throw new Error(await proxyRes.text());
          const gcalData = await proxyRes.json();
          for (const item of (gcalData.items || [])) {
            const startRaw = item.start?.dateTime || item.start?.date;
            if (!startRaw) continue;
            const start = new Date(startRaw);
            const allDay = !item.start?.dateTime;
            allEvents.push({
              title:     item.summary || '(No title)',
              start,
              allDay,
              _calName:  cal.name,
              _calColor: cal._personalGoogle ? (store.currentUserProfile?.calendar_color || cal.color || '#C9A84C') : (cal.color || '#1565C0'),
              _gcalId:   item.id,
              _priority: cal._personalGoogle ? 1 : 2,
            });
          }
        } catch (e) {
          console.warn('[calendar] Google Calendar fetch failed:', e);
        }
        return;
      }

      // ICS — parser expands recurrences and filters to today in one pass
      try {
        const raw = await _fetchICS(cal.url);
        const events = parseICS(raw, { targetDate: now, parishTz });
        console.log('[dashboard] ICS events for today:', events.length, events.map(e => e.title));
        for (const ev of events) {
          allEvents.push({ ...ev, _calName: cal.name, _calColor: cal.color, _priority: 3 });
        }
      } catch (e) {
        console.warn('[calendar] ICS fetch/parse failed:', cal.name, e);
      }
    }));

    // Sort by priority first so higher-priority sources win deduplication
    allEvents.sort((a, b) => (a._priority || 9) - (b._priority || 9));

    // Deduplicate: same title (case-insensitive) within a 15-minute window
    const seen = [];
    const dedupedEvents = allEvents.filter(ev => {
      const dup = seen.some(s =>
        s.title.toLowerCase().trim() === ev.title.toLowerCase().trim() &&
        Math.abs(new Date(s.start) - new Date(ev.start)) < 15 * 60 * 1000
      );
      if (!dup) { seen.push(ev); return true; }
      return false;
    });

    // Sort by start time ascending; stubs last
    dedupedEvents.sort((a, b) => {
      if (a._stub && !b._stub) return 1;
      if (!a._stub && b._stub) return -1;
      return a.start - b.start;
    });

    if (!dedupedEvents.length) {
      c.innerHTML = '<div style="font-size:13px;color:#6B7280;font-style:italic;">No upcoming events.</div>';
      return;
    }

    _calendarEvents = dedupedEvents;
    _renderCalendarEvents();

    // Re-evaluate "now" highlighting every 60 seconds; stop if dashboard is no longer active
    if (_nowInterval) clearInterval(_nowInterval);
    _nowInterval = setInterval(() => {
      if (!document.getElementById('panel-dashboard')?.classList.contains('active')) {
        clearInterval(_nowInterval);
        _nowInterval = null;
        return;
      }
      _renderCalendarEvents();
    }, 60_000);

  } catch (e) {
    console.error('[calendar]', e);
    c.innerHTML = '<div style="font-size:13px;color:#922B21;">Could not load calendar — check console.</div>';
  }
}

// ── Project stats ──────────────────────────────────────────────────────────

export function updateProjectStats() {
  const counts = { in_progress: 0, blocked: 0, complete: 0 };
  (store.allProjects || []).forEach(p => {
    if (counts[p.status_code] !== undefined) counts[p.status_code]++;
  });

  // My Tasks = personal tasks I created + tasks directly assigned to me (not complete)
  let taskCount = 0;
  (store.allTasks || []).filter(t => !t.completed).forEach(t => {
    const isPersonal = t.visibility === 'personal' && t.created_by === currentUserId;
    const isAssigned = _dashPersonnelId && t.assigned_to === _dashPersonnelId;
    if (isPersonal || isAssigned) taskCount++;
  });

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('stat-inprogress',  counts.in_progress);
  set('stat-blocked',     counts.blocked);
  set('stat-tasks',       taskCount);
  set('pstat-inprogress', counts.in_progress);
  set('pstat-blocked',    counts.blocked);
  set('pstat-complete',   counts.complete);
}

// ── Projects & Tasks ───────────────────────────────────────────────────────

const _PROJ_STATUS = {
  in_progress: { label: 'Projects in Progress', color: '#7A5C00', bg: '#FDF3D0', border: '#1565C0' },
  blocked:     { label: 'Blocked Projects',     color: '#7A1020', bg: '#FDEAED', border: '#8B1A2F' },
  not_started: { label: 'Not Started', color: '#4B5563', bg: '#F3F4F6', border: '#999999' },
};
const _TASK_BORDER = '#C9A84C';

export function renderDashProjects() {
  const c = document.getElementById('dash-projects');
  if (!c) return;

  const today = todayCST();

  // Projects: not complete, user has access (already scoped in store.allProjects)
  const projItems = (store.allProjects || [])
    .filter(p => p.status_code !== 'complete')
    .map(p => ({
      type:          'project',
      id:            p.id,
      title:         p.title,
      icon:          p.icon || 'fa-clipboard',
      dueDate:       p.due_date || null,
      statusCode:    p.status_code || 'not_started',
      assigneeCount: Array.isArray(p.assigned_to) ? p.assigned_to.length : (p.assigned_to ? 1 : 0),
    }));

  // Tasks: personal (created by me) OR directly assigned to me, not complete
  const personnel = store.personnel || [];
  const taskItems = (store.allTasks || [])
    .filter(t => !t.completed)
    .filter(t => {
      const isPersonal = t.visibility === 'personal' && t.created_by === currentUserId;
      const isAssigned = _dashPersonnelId && t.assigned_to === _dashPersonnelId;
      return isPersonal || isAssigned;
    })
    .map(t => {
      const assignee = t.assigned_to ? personnel.find(p => p.id === t.assigned_to) : null;
      return {
        type:         'task',
        id:           t.id,
        title:        t.title,
        dueDate:      t.due_date || null,
        isPersonal:   t.visibility === 'personal',
        assigneeName: assignee?.name || null,
      };
    });

  // Combined: sort by due_date asc, nulls last
  const combined = [...projItems, ...taskItems].sort((a, b) => {
    if (!a.dueDate && !b.dueDate) return 0;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate.localeCompare(b.dueDate);
  }).slice(0, 10);

  if (!combined.length) {
    c.innerHTML = `<div style="font-size:13px;color:#6B7280;font-style:italic;">No active projects or tasks.</div>`;
    return;
  }

  c.innerHTML = combined.map(item => {
    if (item.type === 'project') {
      const st = _PROJ_STATUS[item.statusCode] || _PROJ_STATUS.not_started;
      const overdue = item.dueDate && item.dueDate < today;
      return `
        <div onclick="window.showProjectDashboard('${item.id}')" style="
          display:flex;align-items:center;gap:8px;padding:.5rem .5rem;
          border-bottom:.5px solid #F0EDE8;cursor:pointer;
        " onmouseover="this.style.background='#FAFAF8'" onmouseout="this.style.background=''">
          <span style="font-size:9.5px;font-weight:700;background:${st.bg};color:${st.color};border-radius:20px;padding:2px 7px;white-space:nowrap;flex-shrink:0;">${st.label}</span>
          <i class="fa-solid ${item.icon}" style="font-size:12px;color:#8B1A2F;flex-shrink:0;"></i>
          <span style="font-size:13px;font-weight:500;color:#1C2B3A;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${item.title}</span>
          ${item.dueDate ? `<span style="font-size:11px;color:${overdue ? '#8B1A2F' : '#9CA3AF'};flex-shrink:0;">${fmtDate(item.dueDate)}</span>` : ''}
        </div>`;
    } else {
      const overdue = item.dueDate && item.dueDate < today;
      return `
        <div style="
          display:flex;align-items:center;gap:8px;padding:.5rem .5rem;
          border-bottom:.5px solid #F0EDE8;
        ">
          <span style="font-size:9.5px;font-weight:700;background:#FDF3D0;color:#7A5C00;border-radius:20px;padding:2px 7px;white-space:nowrap;flex-shrink:0;">Task</span>
          <input type="checkbox" class="dash-task-cb" data-task-id="${item.id}"
            style="flex-shrink:0;width:14px;height:14px;accent-color:#1C2B3A;cursor:pointer;" />
          <span style="font-size:13px;color:#1C2B3A;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${item.title}</span>
          ${item.dueDate ? `<span style="font-size:11px;color:${overdue ? '#8B1A2F' : '#9CA3AF'};flex-shrink:0;">${fmtDate(item.dueDate)}</span>` : ''}
        </div>`;
  }).join('');

  // Wire task checkboxes
  c.querySelectorAll('.dash-task-cb').forEach(cb => {
    cb.addEventListener('change', async () => {
      const id = cb.dataset.taskId;
      const checked = cb.checked;
      const { error } = await sb.from('tasks').update({
        completed:    checked,
        completed_at: checked ? new Date().toISOString() : null,
      }).eq('id', id);
      if (error) { cb.checked = !checked; console.error('[dash] task toggle:', error); return; }
      const t = (store.allTasks || []).find(x => x.id === id);
      if (t) { t.completed = checked; t.completed_at = checked ? new Date().toISOString() : null; }
      renderDashProjects();
      updateProjectStats();
    });
  });
}

// ── Announcements ──────────────────────────────────────────────────────────

let announcements         = [];
let scheduledAnnouncements = [];
let dismissedIds          = new Set();
let _birthdayAnnouncements = [];

export async function loadAnnouncements() {
  const today = todayCST();
  const now = new Date().toISOString();
  // Auto-publish any scheduled announcements whose publish_at has passed (column may not exist yet)
  const autopubRes = await sb.from('announcements').update({ active: true }).eq('active', false).not('publish_at', 'is', null).lte('publish_at', now);
  if (autopubRes.error) console.warn('[announcements] auto-publish skipped (publish_at column may not exist):', autopubRes.error.message);

  const [annRes, scheduledRes, dimRes] = await Promise.all([
    sb.from('announcements')
      .select('*')
      .eq('active', true)
      .or(`expires_at.is.null,expires_at.gte.${today}`)
      .order('pinned', { ascending: false })
      .order('created_at', { ascending: false }),
    autopubRes.error
      ? Promise.resolve({ data: [] })
      : sb.from('announcements')
          .select('*')
          .eq('active', false)
          .not('publish_at', 'is', null)
          .order('publish_at', { ascending: true }),
    currentUserId
      ? sb.from('announcement_dismissals').select('announcement_id').eq('user_id', currentUserId)
      : Promise.resolve({ data: [] }),
  ]);
  if (annRes.error) console.error('[announcements] load error:', annRes.error);
  announcements = annRes.data || [];
  scheduledAnnouncements = scheduledRes.data || [];
  dismissedIds  = new Set((dimRes.data || []).map(d => d.announcement_id));
  _checkBirthdays();
  renderAnnouncements();
}

function _checkBirthdays() {
  const today = new Date();
  const todayMonth = today.getMonth() + 1;
  const todayDay   = today.getDate();
  _birthdayAnnouncements = (store.personnel || [])
    .filter(p => p.active !== false && p.date_of_birth)
    .filter(p => {
      const [, m, d] = p.date_of_birth.split('-').map(Number);
      return m === todayMonth && d === todayDay;
    })
    .map(p => ({
      id:         `__bday__${p.id}`,
      message:    `🎂 Today is ${p.name}'s birthday!`,
      pinned:     false,
      created_at: today.toISOString(),
      expires_at: null,
      _isBirthday: true,
    }));
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
  const visible = [
    ..._birthdayAnnouncements.filter(a => !dismissedIds.has(a.id)),
    ...announcements.filter(a => !dismissedIds.has(a.id)),
  ];
  const isAdminUser = store.currentUserRoles?.isAdmin || store.currentUserRoles?.isSuperAdmin;
  const scheduledVisible = isAdminUser ? scheduledAnnouncements : [];
  if (!visible.length && !scheduledVisible.length) {
    c.innerHTML = '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No announcements.</div>';
    return;
  }
  const fmtScheduled = a => {
    const d = new Date(a.publish_at);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  };
  c.innerHTML = [
    ...visible.map(a => `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:.5rem 0;border-bottom:.5px solid var(--stone);" class="annc-item">
      <div style="flex:1;min-width:0;">
        ${a.pinned ? `<span style="font-size:10px;font-weight:700;letter-spacing:.06em;color:#922B21;text-transform:uppercase;margin-right:6px;">📌 Pinned</span>` : ''}
        <span style="font-size:14px;color:var(--navy);line-height:1.5;">${a.message}</span>
        <div style="font-size:11px;color:#9CA3AF;margin-top:3px;">
          ${timeAgo(a.created_at)}${a.expires_at ? ` · expires ${fmtDate(a.expires_at)}` : ''}${_visibilityLabel(a)}
        </div>
      </div>
      <button onclick="dismissAnnouncement('${a.id}')" title="Dismiss" style="background:none;border:none;cursor:pointer;color:#D1D5DB;font-size:14px;padding:0;flex-shrink:0;line-height:1;margin-top:2px;" onmouseover="this.style.color='#6B7280'" onmouseout="this.style.color='#D1D5DB'">✕</button>
    </div>`),
    ...scheduledVisible.map(a => `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:.5rem 0;border-bottom:.5px solid var(--stone);opacity:.75;" class="annc-item">
      <div style="flex:1;min-width:0;">
        <span style="font-size:10px;font-weight:700;letter-spacing:.06em;color:#6B7280;text-transform:uppercase;background:#F0EDE8;border-radius:4px;padding:2px 6px;margin-right:6px;">🕐 Scheduled for ${fmtScheduled(a)}</span>
        <span style="font-size:13px;color:#6B7280;line-height:1.5;">${a.message}</span>
        <div style="font-size:11px;color:#9CA3AF;margin-top:3px;">${_visibilityLabel(a)}</div>
      </div>
      <button onclick="openAnnouncementModal(${JSON.stringify(a).replace(/"/g,'&quot;')})" title="Edit" style="background:none;border:none;cursor:pointer;color:#9CA3AF;font-size:12px;padding:0 2px;flex-shrink:0;line-height:1;margin-top:2px;" onmouseover="this.style.color='var(--cardinal)'" onmouseout="this.style.color='#9CA3AF'">✏️</button>
    </div>`),
  ].join('');
}

async function dismissAnnouncement(id) {
  dismissedIds.add(id);
  renderAnnouncements();
  if (!currentUserId || id.startsWith('__bday__')) return;
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

  const publishVal = data?.publish_at ? new Date(data.publish_at).toISOString().slice(0,16) : '';
  return `<div class="modal-title">${data ? 'Edit announcement' : 'Add announcement'}</div>
  <label>Message</label><textarea id="af-msg" rows="3">${data?.message || ''}</textarea>
  <label>Expires (optional)</label><input type="date" id="af-exp" value="${data?.expires_at || ''}" />
  <label>Publish date (optional — leave blank to publish now)</label>
  <input type="datetime-local" id="af-publish" value="${publishVal}" />
  <div style="display:flex;align-items:center;gap:8px;margin:.5rem 0;">
    <input type="checkbox" id="af-pin" ${data?.pinned ? 'checked' : ''} style="width:15px;height:15px;accent-color:var(--cardinal);" />
    <label for="af-pin" style="margin:0;cursor:pointer;">Pin to top</label>
  </div>
  <label>Visible to</label>
  <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px;">
    <label for="af-vis-all" style="display:flex;align-items:center;gap:8px;margin:0;cursor:pointer;font-size:13px;color:var(--navy);letter-spacing:normal;">
      <input type="radio" name="af-vis" id="af-vis-all" value="all" ${visAll ? 'checked' : ''}
        style="accent-color:var(--cardinal);margin:0;flex-shrink:0;cursor:pointer;width:auto;"
        onchange="document.getElementById('af-teams-wrap').style.display='none'" />
      Visible to all
    </label>
    <label for="af-vis-teams" style="display:flex;align-items:center;gap:8px;margin:0;cursor:pointer;font-size:13px;color:var(--navy);letter-spacing:normal;">
      <input type="radio" name="af-vis" id="af-vis-teams" value="teams" ${!visAll ? 'checked' : ''}
        style="accent-color:var(--cardinal);margin:0;flex-shrink:0;cursor:pointer;width:auto;"
        onchange="document.getElementById('af-teams-wrap').style.display='block'" />
      Specific teams…
    </label>
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

  const publishAtRaw = document.getElementById('af-publish')?.value || '';
  const publishAt = publishAtRaw ? new Date(publishAtRaw).toISOString() : null;
  const isScheduled = publishAt && new Date(publishAt) > new Date();
  const payload = {
    message,
    expires_at: document.getElementById('af-exp').value || null,
    pinned:     !!document.getElementById('af-pin').checked,
    visible_to,
    active:     !isScheduled,
    publish_at: publishAt,
  };
  let err, savedId = id;
  if (id) {
    const r = await sb.from('announcements').update(payload).eq('id', id); err = r.error;
  } else {
    const r = await sb.from('announcements').insert({ ...payload, created_by: currentUserId }).select('id').single(); err = r.error; if(r.data) savedId = r.data.id;
  }
  if (err) { alert('Save failed: ' + err.message); return; }
  logActivity({ action: id ? 'updated announcement' : 'posted announcement', entityType: 'announcement', entityName: payload.message.slice(0, 60) || 'Announcement', contextType: 'announcement' });
  // Notify recipients of new active announcements (skip scheduled ones)
  if (!id && !isScheduled) {
    let targetUserIds;
    if (!payload.visible_to || !payload.visible_to.length) {
      targetUserIds = await getAllUserIds();
    } else {
      const teamUserSets = await Promise.all(payload.visible_to.map(tid => getUserIdsForTeam(tid)));
      targetUserIds = [...new Set(teamUserSets.flat())];
    }
    notifyUsers(targetUserIds, currentUserId, `New announcement: ${payload.message.slice(0, 80)}`, 'info', 'announcement', savedId);
  }
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
  project:      'fa-diagram-project',
  task:         'fa-square-check',
  team:         'fa-users',
  baptism:      'fa-water',
  firstcomm:    'fa-wine-glass',
  confirmation: 'fa-fire',
  ocia:         'fa-user-plus',
  couple:       'fa-heart',
  case:         'fa-scale-balanced',
  announcement: 'fa-bullhorn',
  personnel:    'fa-address-book',
  messaging:    'fa-comments',
  general:      'fa-gear',
};

function _contextIcon(contextType, contextId, projectIconMap) {
  if (contextType === 'team') {
    const team = (store.teams || []).find(t => t.id === contextId);
    return team?.icon || FEED_ICONS.team;
  }
  if (contextType === 'project' && contextId && projectIconMap) {
    return projectIconMap[contextId] || 'fa-clipboard';
  }
  return FEED_ICONS[contextType] || FEED_ICONS.general;
}

function _faIcon(iconClass) {
  return `<i class="fa-solid ${iconClass}" style="font-size:14px;color:#8B1A2F;flex-shrink:0;width:16px;text-align:center;"></i>`;
}

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
  const limit = 5;
  const superAdmin = isSuperAdmin();
  const admin = isAdmin();

  const scope = await getUserScope();
  const { personnelId } = scope;

  const accessibleProjectIds = new Set((store.allProjects || []).map(p => p.id));

  const coordPrograms = superAdmin
    ? new Set(['marriage', 'annulments', 'ocia', 'baptism', 'firstcomm', 'confirmation'])
    : await _coordinatorPrograms(personnelId);

  const { data: actRaw, error: actErr } = await sb
    .from('activity_log')
    .select('id,action,entity_name,created_at,triggered_by,context_type,context_id')
    .order('created_at', { ascending: false })
    .limit(20);
  if (actErr) console.error('[activity_log] fetch error:', actErr);

  // Build profile map for activity_log entries
  const actData = actRaw || [];
  const triggeredByIds = [...new Set(actData.map(r => r.triggered_by).filter(Boolean))];
  const userMap = {};
  if (triggeredByIds.length) {
    const { data: profs, error: profErr } = await sb
      .from('user_profiles')
      .select('user_id, avatar_url, initials_color, personnel(name)')
      .in('user_id', triggeredByIds);
    if (profErr) console.error('[activity_log] user_profiles fetch error:', profErr);
    (profs || []).forEach(p => {
      userMap[p.user_id] = {
        name:           p.personnel?.name || 'Unknown',
        avatarUrl:      p.avatar_url      || null,
        initialsColor:  p.initials_color  || null,
      };
    });
  }

  const items = [];

  // Filter activity_log entries by user's access context
  const userTeamIds   = new Set(store.currentUserRoles?.teamIds || []);
  const accessibleTaskIds = new Set((store.allTasks || []).map(t => t.id));

  function _canSeeEntry(r) {
    if (superAdmin) return true;
    const ct = r.context_type || 'general';
    const cid = r.context_id;
    switch (ct) {
      case 'project':
        return !cid || accessibleProjectIds.has(cid);
      case 'task':
        return !cid || accessibleTaskIds.has(cid);
      case 'team':
        return !cid || admin || userTeamIds.has(cid);
      case 'announcement':
      case 'general':
        return true;
      case 'personnel':
        return admin;
      case 'ocia':
        return admin || coordPrograms.has('ocia');
      case 'marriage':
      case 'couple':
        return admin || coordPrograms.has('marriage');
      case 'baptism':
        return admin || coordPrograms.has('baptism');
      case 'confirmation':
        return admin || coordPrograms.has('confirmation');
      case 'firstcomm':
      case 'firstcommunion':
        return admin || coordPrograms.has('firstcomm');
      case 'annulments':
        return admin || coordPrograms.has('annulments');
      default:
        return admin;
    }
  }

  const visibleActData = actData.filter(_canSeeEntry);

  // Build project icon map for activity entries referencing a project
  const projectIconMap = {};
  const projContextIds = [...new Set(
    visibleActData
      .filter(r => r.context_type === 'project' && r.context_id)
      .map(r => r.context_id)
  )];
  if (projContextIds.length) {
    // Check store first to avoid unnecessary fetches
    const missing = projContextIds.filter(id => {
      const cached = (store.allProjects || []).find(p => p.id === id);
      if (cached) { projectIconMap[id] = cached.icon || 'fa-clipboard'; return false; }
      return true;
    });
    if (missing.length) {
      const { data: iconRows } = await sb.from('projects').select('id, icon').in('id', missing);
      (iconRows || []).forEach(p => { projectIconMap[p.id] = p.icon || 'fa-clipboard'; });
    }
  }

  // activity_log entries — attributed to triggering user
  visibleActData.forEach(r => {
    const user = r.triggered_by ? (userMap[r.triggered_by] || { name: 'Unknown User' }) : null;
    items.push({
      icon:        _contextIcon(r.context_type || 'general', r.context_id, projectIconMap),
      label:       r.action || 'Action',
      name:        r.entity_name || '',
      ts:          r.created_at,
      actorName:   user?.name || null,
      actorUserId: r.triggered_by || null,
      avatarUrl:   user?.avatarUrl || null,
      isSystem:    !r.triggered_by,
      isFa:        true,
      logId:       r.id,
    });
  });

  items.sort((a, b) => new Date(b.ts) - new Date(a.ts));

  const c = document.getElementById('dash-activity');
  if (!c) return;
  const top10 = items.slice(0, 5);
  if (!top10.length) {
    c.innerHTML = '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No recent activity.</div>';
    return;
  }

  c.innerHTML = top10.map((item, i) => {
    const fullDate = item.ts ? new Date(item.ts).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

    let actorBlock;
    if (item.isSystem) {
      actorBlock = `<span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:#F0EDE8;flex-shrink:0;font-size:12px;color:#9CA3AF;" title="System">⚙</span><span style="font-weight:600;color:#6B7280;font-size:12.5px;"> System</span> `;
    } else if (item.actorName) {
      actorBlock = `<span class="feed-avatar-slot" data-idx="${i}" style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:#E2DDD6;flex-shrink:0;overflow:hidden;"></span><span style="font-weight:600;color:var(--navy);font-size:12.5px;"> ${item.actorName}</span> `;
    } else {
      actorBlock = '';
    }

    const deleteBtn = (superAdmin && item.logId)
      ? `<button class="feed-delete-btn" data-log-id="${item.logId}" style="background:none;border:none;cursor:pointer;color:#999;font-size:12px;padding:0 2px;flex-shrink:0;line-height:1;" title="Remove entry" onmouseover="this.style.color='#8B1A2F'" onmouseout="this.style.color='#999'">✕</button>`
      : '';

    return `
    <div style="display:flex;align-items:center;gap:10px;padding:.5rem 0;border-bottom:.5px solid var(--stone);">
      ${_faIcon(item.icon)}
      <div style="flex:1;min-width:0;">
        <div style="font-size:12.5px;color:#6B7280;display:flex;align-items:center;flex-wrap:wrap;gap:3px;line-height:1.4;">
          ${actorBlock}<span style="color:#6B7280;">${item.label}${item.name ? ` · <span style="font-weight:500;color:var(--navy);">${item.name}</span>` : ''}</span>
        </div>
      </div>
      <span style="font-size:11px;color:#9CA3AF;flex-shrink:0;white-space:nowrap;cursor:default;" title="${fullDate}">${timeAgo(item.ts)}</span>
      ${deleteBtn}
    </div>`;
  }).join('');

  // Hydrate avatar slots for attributed entries
  top10.forEach((item, i) => {
    if (!item.actorName || item.isSystem) return;
    const slot = c.querySelector(`.feed-avatar-slot[data-idx="${i}"]`);
    if (slot) createAvatar({ container: slot, userId: item.actorUserId || '', name: item.actorName, size: 24, avatarUrl: item.avatarUrl || null });
  });

  // Wire super-admin delete buttons
  if (superAdmin) {
    c.querySelectorAll('.feed-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const logId = btn.dataset.logId;
        await sb.from('activity_log').delete().eq('id', logId);
        btn.closest('div[style*="border-bottom"]')?.remove();
      });
    });
  }
}

// ── loadInit ───────────────────────────────────────────────────────────────

export async function loadInit() {
  const topbar = document.getElementById('topbar-season');
  try {
    const { data: authData } = await sb.auth.getUser();
    currentUserId = authData?.user?.id || null;

    const scope = await getUserScope();
    _dashPersonnelId = scope.personnelId || null;
    _checkGcalButton();

    // Skip project/task fetches if already loaded (e.g. called a second time)
    const projectsAlreadyLoaded = store.allProjects?.length > 0 && store._projectScopeReady !== undefined;
    const tasksAlreadyLoaded    = store.allTasks?.length > 0    && store._taskScopeReady    !== undefined;

    const [projRes, caseRes, coupleRes, alertRes, tasksRes] = await Promise.all([
      projectsAlreadyLoaded
        ? Promise.resolve({ data: null, error: null })
        : sb.from('projects').select('*').order('due_date', { nullsFirst: false }),
      sb.from('annulment_cases').select('id,status_code,archived,petitioner,respondent,judgement_finalized'),
      sb.from('couples').select('id,status_code,archived'),
      sb.from('alerts').select('*').eq('active', true),
      tasksAlreadyLoaded
        ? Promise.resolve({ data: null, error: null })
        : sb.from('tasks').select('id,title,due_date,completed,assigned_to,team_id,visibility').order('due_date', { nullsFirst: false }),
    ]);

    if (projRes.error)   console.error('projects error:',   projRes.error.message);
    if (caseRes.error)   console.error('cases error:',      caseRes.error.message);
    if (coupleRes.error) console.error('couples error:',    coupleRes.error.message);
    if (alertRes.error)  console.error('alerts error:',     alertRes.error.message);
    if (tasksRes.error)  console.error('tasks error:',      tasksRes.error.message);

    if (!projectsAlreadyLoaded && projRes.data) {
      store.allProjects = projRes.data.filter(p => isVisible(p, scope));
      store._projectScopeReady = scope.ready;
    }
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

    if (!tasksAlreadyLoaded && tasksRes.data) {
      store.allTasks = tasksRes.data.filter(t => isVisible(t, scope));
      store._taskScopeReady = scope.ready;
    } else if (!store.allTasks) {
      store.allTasks = [];
    }

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

// ── New Event Modal ────────────────────────────────────────────────────────

let _googleCalConnected = false;

async function _openNewEventModal() {
  // Check if Google Calendar is connected for this user
  _googleCalConnected = false;
  if (currentUserId) {
    const { data } = await sb.from('calendars')
      .select('id')
      .eq('user_id', currentUserId)
      .eq('type', 'google')
      .eq('scope', 'personal')
      .maybeSingle();
    _googleCalConnected = !!data;
  }

  // Populate calendar selector
  const sel = document.getElementById('ne-calendar');
  if (sel) {
    sel.innerHTML = '';
    // Fetch active ICS calendars for options (read-only, disabled)
    const { data: cals } = await sb.from('calendars')
      .select('id, name, type, scope')
      .eq('active', true)
      .neq('type', 'google');

    for (const cal of (cals || [])) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = cal.name + ' (read-only)';
      opt.disabled = true;
      sel.appendChild(opt);
    }

    if (_googleCalConnected) {
      const opt = document.createElement('option');
      opt.value = 'google';
      opt.textContent = 'My Google Calendar';
      opt.selected = true;
      sel.appendChild(opt);
    } else {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No writable calendar — connect Google Calendar in your profile';
      opt.disabled = true;
      opt.selected = true;
      sel.appendChild(opt);
    }
  }

  // Pre-fill date with today
  const dateEl = document.getElementById('ne-date');
  if (dateEl && !dateEl.value) dateEl.value = todayCST();

  const overlay = document.getElementById('new-event-overlay');
  if (overlay) overlay.style.display = 'flex';
  document.getElementById('ne-title')?.focus();
}

function _closeNewEventModal() {
  const overlay = document.getElementById('new-event-overlay');
  if (overlay) overlay.style.display = 'none';
  const statusEl = document.getElementById('ne-status');
  if (statusEl) statusEl.textContent = '';
}

async function _saveNewEvent() {
  const title = document.getElementById('ne-title')?.value.trim();
  const date  = document.getElementById('ne-date')?.value;
  const time  = document.getElementById('ne-time')?.value;
  const cal   = document.getElementById('ne-calendar')?.value;
  const statusEl = document.getElementById('ne-status');

  if (!title) { statusEl.textContent = 'Title is required.'; return; }
  if (!date)  { statusEl.textContent = 'Date is required.'; return; }
  if (cal !== 'google') { statusEl.textContent = 'No writable calendar selected.'; return; }

  statusEl.style.color = '#6B7280';
  statusEl.textContent = 'Saving…';

  let gcalEvent;
  if (time) {
    const startDT = new Date(`${date}T${time}:00`);
    const endDT   = new Date(startDT.getTime() + 60 * 60 * 1000);
    gcalEvent = {
      summary: title,
      start:   { dateTime: startDT.toISOString(), timeZone: store.parishSettings?.timezone || 'America/Chicago' },
      end:     { dateTime: endDT.toISOString(),   timeZone: store.parishSettings?.timezone || 'America/Chicago' },
    };
  } else {
    gcalEvent = {
      summary: title,
      start:   { date },
      end:     { date },
    };
  }

  try {
    const res = await fetch('/google-calendar-proxy',{
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: currentUserId, action: 'create', event: gcalEvent }),
    });
    if (!res.ok) throw new Error(await res.text());

    statusEl.style.color = '#166534';
    statusEl.textContent = 'Event saved!';
    setTimeout(() => {
      _closeNewEventModal();
      loadCalendar();
    }, 1200);
  } catch (e) {
    statusEl.style.color = '#8B1A2F';
    statusEl.textContent = 'Failed: ' + e.message;
  }
}

// Show "+ New Event" button only when Google Calendar is connected
async function _checkGcalButton() {
  if (!currentUserId) return;
  const { data } = await sb.from('calendars')
    .select('id')
    .eq('user_id', currentUserId)
    .eq('type', 'google')
    .eq('scope', 'personal')
    .maybeSingle();
  const btn = document.getElementById('btn-new-event');
  if (btn) btn.style.display = data ? '' : 'none';
}

Object.assign(window, {
  loadCalendar,
  dismissAnnouncement,
  openAnnouncementModal,
  saveAnnouncement,
  deleteAnnouncement,
  _openNewEventModal,
  _closeNewEventModal,
  _saveNewEvent,
});
