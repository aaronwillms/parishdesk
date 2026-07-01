import { sb } from '../supabase.js';
import { store } from '../store.js';
import { fmtDate, todayCST, logActivity, PANEL_TITLES } from '../utils.js';
import { getUserScope, isVisible } from '../ui/userScope.js';
import { canWriteGlobalCalendar, canSeeWorkEvent } from '../roles.js';
import { parseICS } from '../utils/icsParser.js';
import { notifyUsers, getAllUserIds, getUserIdsForTeam } from '../notifications.js';
import { attachProjectMembers } from '../ui/membership.js';

let currentUserId     = null;
let _dashPersonnelId  = null;
let _nowInterval      = null;
let _calendarEvents   = [];  // last-rendered event list for interval re-checks
let _dashTaskTab      = 'mine';  // 'mine' | 'delegated' — active tab in the dw-tasks card

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

// Normalize a Google Calendar event to the common {start, end, allDay} shape used
// across ALL sources (ICS already produces this). Google marks ALL-DAY events with a
// date-only `start.date`/`end.date` (no time); timed events use `start.dateTime`. So
// allDay = no dateTime, and start/end come from whichever field is present — giving
// the same shape the ICS parser yields, so the renderer applies one set of rules.
function _gcalTimes(item) {
  const sRaw = item.start?.dateTime || item.start?.date || null;
  const eRaw = item.end?.dateTime || item.end?.date || null;
  return {
    start: sRaw ? new Date(sRaw) : null,
    end:   eRaw ? new Date(eRaw) : null,
    allDay: !item.start?.dateTime,
  };
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

    if (ev.allDay) {
      // All-day events (ANY source) get a uniform DARK-GREY band — NOT a tint of the
      // calendar colour. The old code tinted by _calColor, so the all-day highlight
      // looked grey only while the global calendar was a dark-grey ICS feed; once it
      // became a coloured Google calendar the band turned that colour. Fixed grey now.
      // (rgba so it reads on both the light card and the dark-mode card.)
      return `<div class="sched-item" style="background:rgba(75,85,99,0.2);">
        <div style="flex:1;min-width:0;">
          <div class="sched-desc" style="font-weight:600;">${ev.title}</div>
          <div style="font-size:11.5px;color:#9CA3AF;margin-top:1px;">${_fmtEventDate(ev.start)} · All Day</div>
        </div>
      </div>`;
    }

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
          ${_fmtEventDate(ev.start)} · ${_fmtEventTime(ev.start, false)}
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

    // Merge: parish calendars (incl. the global writer) + the user's personal Google.
    // The global parish Google and the personal Google are distinct sources now (the
    // global reads via the designated-writer token), so show both.
    const parishCals = parishRes.data || [];
    const cals = personalRes.data
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
          // Personal → the user's own token; parish (global writer) → target 'global'
          // so EVERY user sees parish events (read via the designated-writer token).
          const proxyBody = cal._personalGoogle
            ? { user_id: currentUserId, action: 'list', timeMin: startOfDay, timeMax: endOfDay }
            : { user_id: currentUserId, action: 'list', target: 'global', timeMin: startOfDay, timeMax: endOfDay };
          const proxyRes = await fetch('/google-calendar-proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(proxyBody),
          });
          if (!proxyRes.ok) throw new Error(await proxyRes.text());
          const gcalData = await proxyRes.json();
          for (const item of (gcalData.items || [])) {
            const { start, end, allDay } = _gcalTimes(item);
            if (!start) continue;
            allEvents.push({
              title:     item.summary || '(No title)',
              start, end, allDay,
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
        const events = parseICS(raw, { targetDate: now, timezone: parishTz });
        console.log('[dashboard] ICS events for today:', events.length, events.map(e => e.title));
        for (const ev of events) {
          allEvents.push({ ...ev, _calName: cal.name, _calColor: cal.color, _priority: 3 });
        }
      } catch (e) {
        console.warn('[calendar] ICS fetch/parse failed:', cal.name, e);
      }
    }));

    // Work calendar (Phase 3) — panel-originated events. VISIBILITY is governed by the
    // ORIGINATING PANEL (extendedProperties pd_panel), not the calendar: each user only
    // sees a work event if they can access the panel that created it (canSeeWorkEvent).
    if (store.parishSettings?.work_calendar_id) {
      try {
        const wr = await fetch('/google-calendar-proxy', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: currentUserId, action: 'list', target: 'work', timeMin: startOfDay, timeMax: endOfDay }),
        });
        if (wr.ok) {
          for (const item of ((await wr.json()).items || [])) {
            const panel = item.extendedProperties?.private?.pd_panel;
            if (!panel || !canSeeWorkEvent(panel)) continue;
            const { start, end, allDay } = _gcalTimes(item);
            if (!start) continue;
            allEvents.push({
              title: item.summary || '(No title)',
              start, end, allDay,
              _calName: PANEL_TITLES[panel] || panel,
              _calColor: store.parishSettings?.work_calendar_color || '#8B1A2F',
              _priority: 2,
            });
          }
        }
      } catch (e) { console.warn('[calendar] work calendar fetch failed:', e); }
    }

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

  // The dashboard's own stat row was removed (Phase 1a); these feed the Projects panel's
  // pstat-* row only. updateProjectStats stays exported because projects.js calls it.
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('pstat-inprogress', counts.in_progress);
  set('pstat-blocked',    counts.blocked);
  set('pstat-complete',   counts.complete);
}

// ── Projects & Tasks ───────────────────────────────────────────────────────

const _PROJ_STATUS = {
  planning:    { label: 'Planning',    color: '#00695C', bg: '#E0F7FA', border: '#00695C' }, // Teal
  not_started: { label: 'Not Started', color: '#6A1B9A', bg: '#F5F3FF', border: '#6A1B9A' }, // Purple
  in_progress: { label: 'In Progress', color: '#1565C0', bg: '#EFF6FF', border: '#1565C0' }, // Blue
  blocked:     { label: 'Blocked',     color: '#8B1A2F', bg: '#FEF2F2', border: '#8B1A2F' }, // Cardinal
  complete:    { label: 'Complete',    color: '#2E7D32', bg: '#F0FDF4', border: '#2E7D32' }, // Green
  task:        { label: 'Task',        color: '#B45309', bg: '#FFFBEB', border: '#C9A84C' }, // Gold
};
const _TASK_BORDER = '#C9A84C';

// Sort by due_date ascending, nulls last.
function _byDueAscNullsLast(a, b) {
  if (!a.dueDate && !b.dueDate) return 0;
  if (!a.dueDate) return 1;
  if (!b.dueDate) return -1;
  return a.dueDate.localeCompare(b.dueDate);
}

// Renders the two work-surface cards: active projects → #dash-projects, my open tasks →
// #dash-tasks. Phase 1a SPLIT the former single combined list into the new layout's two
// panels; the tasks panel keeps its simple "my open tasks" list until Phase 1b adds the
// My Tasks / Delegated tabs. Still exported (projects.js calls it to refresh both cards).
export function renderDashProjects() {
  const today = todayCST();
  _renderDashProjectCards(today);
  _renderDashTaskCards(today);
}

function _renderDashProjectCards(today) {
  const c = document.getElementById('dash-projects');
  if (!c) return;

  // Projects: not complete, not archived (2b-3), user has access (already scoped in store.allProjects)
  const projItems = (store.allProjects || [])
    .filter(p => p.status_code !== 'complete' && !p.archived)
    .map(p => ({
      id:            p.id,
      title:         p.title,
      icon:          p.icon || 'fa-clipboard',
      dueDate:       p.due_date || null,
      statusCode:    p.status_code || 'not_started',
    }))
    .sort(_byDueAscNullsLast)
    .slice(0, 10);

  if (!projItems.length) {
    c.innerHTML = `<div style="font-size:13px;color:#6B7280;font-style:italic;">No active projects.</div>`;
    return;
  }

  c.innerHTML = projItems.map(item => {
    const st = _PROJ_STATUS[item.statusCode] || _PROJ_STATUS.not_started;
    const overdue = item.dueDate && item.dueDate < today;
    return `
      <div onclick="window.showProjectDashboard('${item.id}')" style="
        display:flex;flex-direction:column;padding:.5rem .5rem;
        border-bottom:.5px solid #F0EDE8;cursor:pointer;gap:2px;
      " onmouseover="this.style.background='#FAFAF8'" onmouseout="this.style.background=''">
        <div style="display:flex;align-items:center;gap:8px;min-width:0;">
          <i class="fa-solid ${item.icon}" style="font-size:12px;color:#8B1A2F;flex-shrink:0;"></i>
          <span style="font-size:13px;font-weight:500;color:#1C2B3A;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${item.title}</span>
          <span style="font-size:9.5px;font-weight:700;background:${st.bg};color:${st.color};border:1px solid ${st.border};border-radius:20px;padding:2px 7px;white-space:nowrap;flex-shrink:0;">${st.label}</span>
        </div>
        ${item.dueDate ? `<div style="font-size:11px;color:${overdue ? '#8B1A2F' : '#9CA3AF'};padding-left:20px;">${fmtDate(item.dueDate)}</div>` : ''}
      </div>`;
  }).join('');
}

// Two-tab tasks surface (Phase 1b). Renders a tab strip (My Tasks | Delegated), a bare-add
// input (My Tasks only), and the active list into #dash-tasks. Uses the dashboard's OWN row
// template — NOT tasks.js' taskRow — so the standalone/per-team/per-project surfaces are
// untouched. Complete is binary here (writes `completed` only; never `status`).
function _renderDashTaskCards(today) {
  const c = document.getElementById('dash-tasks');
  if (!c) return;

  const all = store.allTasks || [];
  const nameOf = (pid) => pid ? ((store.personnel || []).find(p => p.id === pid)?.name || null) : null;

  // My Tasks: open, created by me OR assigned to me (personal + assigned intermixed).
  const isMine = (t) => !t.completed &&
    (t.created_by === currentUserId || (_dashPersonnelId && t.assigned_to === _dashPersonnelId));
  // Delegated: open, I created it, assigned OUT to someone who isn't me.
  const isDelegated = (t) => !t.completed && t.created_by === currentUserId &&
    !!t.assigned_to && t.assigned_to !== _dashPersonnelId;

  // Asymmetric: the Delegated tab exists only if the user has delegated something out.
  const hasDelegated = all.some(isDelegated);
  if (_dashTaskTab === 'delegated' && !hasDelegated) _dashTaskTab = 'mine';

  const items = (_dashTaskTab === 'delegated' ? all.filter(isDelegated) : all.filter(isMine))
    .map(t => ({
      id:            t.id,
      title:         t.title,
      dueDate:       t.due_date || null,
      // My Tasks: subtle marker for rows delegated TO me (assigned to me, someone else created).
      delegatedToMe: _dashTaskTab === 'mine' && !!_dashPersonnelId &&
                     t.assigned_to === _dashPersonnelId && t.created_by !== currentUserId,
      // Delegated: who I handed it to.
      assigneeName:  _dashTaskTab === 'delegated' ? nameOf(t.assigned_to) : null,
    }))
    .sort(_byDueAscNullsLast)
    .slice(0, 10);

  // Tab strip
  const tab = (key, label) => `<button class="dash-task-tab" data-tab="${key}" style="
    background:none;border:none;cursor:pointer;padding:2px 0;margin-right:16px;
    font-family:'Inter',sans-serif;font-size:12.5px;font-weight:${_dashTaskTab === key ? '700' : '500'};
    color:${_dashTaskTab === key ? '#1C2B3A' : '#9CA3AF'};
    border-bottom:2px solid ${_dashTaskTab === key ? '#C9A84C' : 'transparent'};">${label}</button>`;
  const tabs = `<div style="display:flex;align-items:center;margin-bottom:.5rem;">
    ${tab('mine', 'My Tasks')}${hasDelegated ? tab('delegated', 'Delegated') : ''}
  </div>`;

  // Bare-add — My Tasks tab only. Type a line + Enter → personal task owned by me.
  const addRow = _dashTaskTab === 'mine' ? `
    <div style="display:flex;align-items:center;gap:8px;padding:.4rem .5rem;border-bottom:.5px solid #F0EDE8;">
      <i class="fa-solid fa-plus" style="font-size:11px;color:#B0A090;flex-shrink:0;"></i>
      <input id="dash-task-add" placeholder="Add a task…" autocomplete="off" style="
        flex:1;border:none;background:transparent;outline:none;font-size:13px;
        font-family:'Inter',sans-serif;color:#1C2B3A;padding:2px 0;" />
    </div>` : '';

  const rows = items.length
    ? items.map(item => {
        const overdue = item.dueDate && item.dueDate < today;
        const marker = item.delegatedToMe
          ? `<i class="fa-solid fa-arrow-right-to-bracket" title="Assigned to you" style="font-size:10px;color:#8FA8BF;flex-shrink:0;"></i>`
          : '';
        const assignee = item.assigneeName
          ? `<span title="Assigned to ${item.assigneeName}" style="font-size:10.5px;color:#6B7280;display:inline-flex;align-items:center;gap:3px;flex-shrink:0;"><i class="fa-solid fa-arrow-right" style="font-size:9px;"></i>${item.assigneeName}</span>`
          : '';
        return `
          <div style="display:flex;flex-direction:column;padding:.5rem .5rem;border-bottom:.5px solid #F0EDE8;gap:2px;">
            <div style="display:flex;align-items:center;gap:8px;min-width:0;">
              <input type="checkbox" class="dash-task-cb" data-task-id="${item.id}"
                style="flex-shrink:0;width:14px;height:14px;accent-color:#1C2B3A;cursor:pointer;" />
              ${marker}
              <span style="font-size:13px;color:#1C2B3A;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;">${item.title}</span>
              ${assignee}
            </div>
            ${item.dueDate ? `<div style="font-size:11px;color:${overdue ? '#8B1A2F' : '#9CA3AF'};padding-left:22px;">${fmtDate(item.dueDate)}</div>` : ''}
          </div>`;
      }).join('')
    : `<div style="font-size:13px;color:#6B7280;font-style:italic;padding:.4rem .5rem;">${_dashTaskTab === 'delegated' ? 'Nothing delegated out.' : 'No open tasks.'}</div>`;

  c.innerHTML = tabs + addRow + rows;

  // Wire tab switching (re-render just the tasks card)
  c.querySelectorAll('.dash-task-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      _dashTaskTab = btn.dataset.tab;
      _renderDashTaskCards(todayCST());
    });
  });

  // Wire bare-add (My Tasks tab). Owner defaults to self via created_by; visibility MUST be
  // set 'personal' explicitly (DB default is 'team').
  const addInput = c.querySelector('#dash-task-add');
  if (addInput) {
    addInput.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const title = addInput.value.trim();
      if (!title) return;
      addInput.disabled = true;
      const { data: newTask, error } = await sb.from('tasks')
        .insert({ title, created_by: currentUserId, visibility: 'personal' })
        .select().single();
      if (error) { addInput.disabled = false; console.error('[dash] bare-add failed:', error); return; }
      if (!store.allTasks) store.allTasks = [];
      store.allTasks.push(newTask);
      logActivity({ action: 'created task', entityType: 'task', entityName: newTask.title, contextType: 'task', contextId: newTask.id });
      renderDashProjects();
      updateProjectStats();
      document.getElementById('dash-task-add')?.focus();  // rapid entry
    });
  }

  // Wire checkbox complete — binary (writes `completed` only, never `status`).
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
      // Delegator-notify: when the assignee (not the delegator) completes a delegated task,
      // notify the delegator (created_by, an auth uid). notifyUsers excludes the actor, so a
      // self-completed personal task fires nothing.
      if (checked && t?.assigned_to && t.created_by && t.created_by !== currentUserId) {
        const who = store.currentUserProfile?.personnel?.name || 'Someone';
        notifyUsers([t.created_by], currentUserId, `${who} completed: ${t.title}`, 'success', 'tasks', id);
      }
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
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:.5rem 0;border-bottom:.5px solid var(--stone);" class="annc-item" data-ann-id="${a.id}">
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
  // Birthday announcements are in-memory only — dismiss locally without persisting
  if (id.startsWith('__bday__')) {
    dismissedIds.add(id);
    renderAnnouncements();
    return;
  }
  if (!currentUserId) return;

  // Persist first — only update UI on success to avoid phantom dismissals on reload
  const { error } = await sb.from('announcement_dismissals')
    .insert({ announcement_id: id, user_id: currentUserId });
  if (error && error.code !== '23505') {
    // 23505 = already dismissed (unique constraint) — treat as success
    console.error('[announcements] dismiss failed:', error);
    const c = document.getElementById('dash-announcements');
    const item = c?.querySelector(`[data-ann-id="${id}"]`);
    if (item) {
      item.style.outline = '1.5px solid #8B1A2F';
      setTimeout(() => { if (item) item.style.outline = ''; }, 2000);
    }
    return;
  }
  dismissedIds.add(id);
  renderAnnouncements();
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
  window.flashSavedThen(() => { closeModal(); loadAnnouncements(); });
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

// ── loadInit ───────────────────────────────────────────────────────────────

export async function loadInit() {
  const topbar = document.getElementById('topbar-season');
  try {
    const { data: authData } = await sb.auth.getUser();
    currentUserId = authData?.user?.id || null;

    const scope = await getUserScope();
    _dashPersonnelId = scope.personnelId || null;
    _checkGcalButton();

    // Wire the dashboard "+ Add Project" button through window.openModal('project') — the guaranteed
    // create trigger that does ensurePanel('projects') (imports projects.js) THEN openNewProjectModal.
    // A bare inline onclick="openNewProjectModal()" would ReferenceError on a fresh dashboard load,
    // because projects.js (which assigns that global) isn't imported until a project is opened.
    const _addProjBtn = document.getElementById('dash-add-project-btn');
    if (_addProjBtn && !_addProjBtn.dataset.wired) {
      _addProjBtn.dataset.wired = '1';
      _addProjBtn.addEventListener('click', () => window.openModal('project'));
    }

    // Always re-fetch projects and tasks so dashboard status chips reflect current data
    // (status changes made on the Projects/Tasks panels must show here without a stale cache).
    const [projRes, caseRes, coupleRes, alertRes, tasksRes] = await Promise.all([
      sb.from('projects').select('*').order('due_date', { nullsFirst: false }),
      sb.from('annulment_cases').select('id,status_code,archived,petitioner,respondent,judgement_finalized'),
      sb.from('couples').select('id,status_code,archived'),
      sb.from('alerts').select('*').eq('active', true),
      sb.from('tasks').select('id,title,due_date,completed,status,assigned_to,team_id,visibility,created_by').order('due_date', { nullsFirst: false }),
    ]);

    if (projRes.error)   console.error('projects error:',   projRes.error.message);
    if (caseRes.error)   console.error('cases error:',      caseRes.error.message);
    if (coupleRes.error) console.error('couples error:',    coupleRes.error.message);
    if (alertRes.error)  console.error('alerts error:',     alertRes.error.message);
    if (tasksRes.error)  console.error('tasks error:',      tasksRes.error.message);

    if (projRes.data) {
      // Attach container_members-sourced _members to rows BEFORE isVisible filters them.
      await attachProjectMembers(projRes.data);
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

    if (tasksRes.data) {
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

    // Load announcements (non-blocking). The activity feed was removed in Phase 1a.
    loadAnnouncements();
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

    // Parish (global) calendar — admins only, and only if a global calendar exists.
    let hasGlobalParish = false;
    if (canWriteGlobalCalendar()) {
      const { data: gw } = await sb.from('calendars')
        .select('id').eq('scope', 'parish').eq('type', 'google').limit(1).maybeSingle();
      hasGlobalParish = !!gw;
      if (hasGlobalParish) {
        const opt = document.createElement('option');
        opt.value = 'parish';
        opt.textContent = 'Parish Calendar';
        opt.selected = true;
        sel.appendChild(opt);
      }
    }

    if (_googleCalConnected) {
      const opt = document.createElement('option');
      opt.value = 'google';
      opt.textContent = 'My Google Calendar';
      opt.selected = !hasGlobalParish;
      sel.appendChild(opt);
    } else if (!hasGlobalParish) {
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
  if (cal !== 'google' && cal !== 'parish') { statusEl.textContent = 'No writable calendar selected.'; return; }
  // Writing to the parish (global) calendar is admins-only — guard in JS (the proxy
  // also enforces it server-side via the designated-writer path).
  if (cal === 'parish' && !canWriteGlobalCalendar()) { statusEl.textContent = 'Not authorized to post to the parish calendar.'; return; }

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
      body: JSON.stringify(cal === 'parish'
        ? { user_id: currentUserId, action: 'create', target: 'global', event: gcalEvent }
        : { user_id: currentUserId, action: 'create', event: gcalEvent }),
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
