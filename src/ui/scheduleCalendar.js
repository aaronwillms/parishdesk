// ── Sacramental "Schedule" button → Application Work Calendar (Phase 3) ──────
// Wires the (previously dead) per-panel Schedule button. Opens a modal that lists
// the events scheduled THROUGH this panel and lets an authorised user add one-off
// or recurring events. Events are written to the designated WORK calendar (Google,
// via the proxy target:'work') and tagged with their originating panel in
// extendedProperties.private.pd_panel — that origin governs visibility (a user sees
// the event only if they can access that panel). Write access = panel access.
//
// Teams DEFERRED: the Teams equivalent of this button is intentionally not built —
// see the team revamp. The work-calendar infra here (work-calendar config, the
// pd_panel origin tag, the visibility rule) is general, so Teams plugs in later by
// passing panel:'teams' (+ team id) with no rework.

import { sb } from '../supabase.js';
import { store } from '../store.js';
import { PANEL_TITLES, todayCST, fmtDate } from '../utils.js';
import { canScheduleForPanel } from '../roles.js';

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tz = () => store.parishSettings?.timezone || 'America/Chicago';

async function _userId() { const { data: { user } } = await sb.auth.getUser(); return user?.id || null; }

// Read this panel's work-calendar events (server-filtered to pd_panel = panel).
async function _listPanelEvents(panel, userId) {
  const timeMin = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
  const timeMax = new Date(Date.now() + 120 * 24 * 60 * 60 * 1000).toISOString();
  const res = await fetch('/google-calendar-proxy', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, action: 'list', target: 'work', panelFilter: panel, timeMin, timeMax }),
  });
  if (!res.ok) throw new Error(await res.text());
  const { items } = await res.json();
  return items || [];
}

function _eventRowsHtml(events) {
  if (!events.length) return '<div style="font-size:13px;color:#9CA3AF;font-style:italic;padding:.5rem 0;">No events scheduled through this panel yet.</div>';
  return events.map(ev => {
    const startRaw = ev.start?.dateTime || ev.start?.date;
    const d = startRaw ? new Date(startRaw) : null;
    const when = d ? fmtDate(String(startRaw).slice(0, 10)) + (ev.start?.dateTime ? ' · ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz() }) : '') : '';
    const recurs = ev.recurringEventId ? ' <span style="font-size:10.5px;color:#9CA3AF;">↻ recurring</span>' : '';
    return `<div style="display:flex;align-items:center;gap:8px;padding:.4rem 0;border-bottom:.5px solid #F0EDE8;">
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;color:#1C2B3A;">${esc(ev.summary || '(no title)')}${recurs}</div>
        <div style="font-size:11.5px;color:#9CA3AF;">${esc(when)}</div>
      </div>
      <button class="sched-del" data-id="${esc(ev.recurringEventId || ev.id)}" title="Delete" style="background:none;border:none;cursor:pointer;color:#C9C2B6;font-size:14px;padding:2px 4px;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#C9C2B6'">✕</button>
    </div>`;
  }).join('');
}

export async function openScheduleModal(panel) {
  if (!canScheduleForPanel(panel)) { alert('You do not have access to schedule for this panel.'); return; }
  const title = PANEL_TITLES[panel] || panel;
  const mc = document.getElementById('modal-content');
  const inp = 'box-sizing:border-box;padding:.4rem .6rem;border:.5px solid #D1C9BE;border-radius:5px;font-size:13px;font-family:Inter,sans-serif;outline:none;background:#fff;';
  const lbl = 'display:block;font-size:11px;color:#6B7280;margin-bottom:3px;';
  mc.innerHTML = `
    <div class="modal-title">Schedule — ${esc(title)}</div>
    <div style="font-size:12px;color:#6B7280;margin:-6px 0 12px;line-height:1.5;">Events added here go to the parish work calendar and are visible only to people with ${esc(title)} access.</div>
    <div id="sched-list" style="max-height:240px;overflow:auto;margin-bottom:1rem;"><div style="font-size:13px;color:#9CA3AF;">Loading…</div></div>
    <div style="border-top:1px dashed #E2DDD6;padding-top:1rem;">
      <div style="font-size:12.5px;font-weight:600;color:#1C2B3A;margin-bottom:.7rem;">Add an event</div>
      <label style="${lbl}">Title</label>
      <input id="sch-title" placeholder="e.g. Baptism Prep Session" style="${inp}width:100%;margin-bottom:.7rem;" />
      <div style="display:flex;gap:.6rem;margin-bottom:.7rem;flex-wrap:wrap;">
        <div style="flex:1;min-width:130px;"><label style="${lbl}">Date</label><input id="sch-date" type="date" value="${todayCST()}" style="${inp}width:100%;" /></div>
        <div style="flex:1;min-width:110px;"><label style="${lbl}">Time (optional)</label><input id="sch-time" type="time" style="${inp}width:100%;" /></div>
      </div>
      <div style="display:flex;gap:.6rem;margin-bottom:.9rem;flex-wrap:wrap;align-items:flex-end;">
        <div style="flex:1;min-width:140px;"><label style="${lbl}">Repeats</label>
          <select id="sch-recur" style="${inp}width:100%;cursor:pointer;" onchange="document.getElementById('sch-until-wrap').style.display=this.value==='none'?'none':'block'">
            <option value="none">One-time</option>
            <option value="weekly">Weekly</option>
            <option value="biweekly">Every 2 weeks</option>
            <option value="monthly">Monthly</option>
          </select>
        </div>
        <div id="sch-until-wrap" style="flex:1;min-width:140px;display:none;"><label style="${lbl}">Until (optional)</label><input id="sch-until" type="date" style="${inp}width:100%;" /></div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        <button id="sch-add" class="btn-primary" style="padding:.4rem 1rem;font-size:12.5px;">Add to calendar</button>
        <span id="sch-status" style="font-size:12px;color:#6B7280;"></span>
      </div>
    </div>`;
  document.getElementById('modal-overlay').classList.add('open');

  const uid = await _userId();
  const refresh = async () => {
    const box = document.getElementById('sched-list'); if (!box) return;
    try { box.innerHTML = _eventRowsHtml(await _listPanelEvents(panel, uid)); }
    catch (e) { box.innerHTML = `<div style="font-size:12.5px;color:#9CA3AF;">Could not load events (${esc(String(e.message).slice(0, 80))}).</div>`; }
    box.querySelectorAll('.sched-del').forEach(btn => btn.addEventListener('click', async () => {
      if (!confirm('Delete this event from the parish calendar?')) return;
      const r = await fetch('/google-calendar-proxy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: uid, action: 'delete', target: 'work', eventId: btn.dataset.id }),
      });
      if (!r.ok) { alert('Delete failed: ' + await r.text()); return; }
      refresh();
    }));
  };
  refresh();

  document.getElementById('sch-add').addEventListener('click', async () => {
    const status = document.getElementById('sch-status');
    const title2 = document.getElementById('sch-title').value.trim();
    const date = document.getElementById('sch-date').value;
    const time = document.getElementById('sch-time').value;
    const recur = document.getElementById('sch-recur').value;
    const until = document.getElementById('sch-until').value;
    if (!title2) { status.style.color = '#E74C3C'; status.textContent = 'Title is required.'; return; }
    if (!date) { status.style.color = '#E74C3C'; status.textContent = 'Date is required.'; return; }

    const event = { summary: title2, extendedProperties: { private: { pd_panel: panel } } };
    if (time) {
      const start = new Date(`${date}T${time}:00`);
      event.start = { dateTime: start.toISOString(), timeZone: tz() };
      event.end = { dateTime: new Date(start.getTime() + 60 * 60 * 1000).toISOString(), timeZone: tz() };
    } else {
      event.start = { date }; event.end = { date };
    }
    if (recur !== 'none') {
      const freq = recur === 'monthly' ? 'MONTHLY' : 'WEEKLY';
      const interval = recur === 'biweekly' ? ';INTERVAL=2' : '';
      const untilPart = until ? `;UNTIL=${until.replace(/-/g, '')}T235959Z` : '';
      event.recurrence = [`RRULE:FREQ=${freq}${interval}${untilPart}`];
    }

    status.style.color = '#6B7280'; status.textContent = 'Adding…';
    const res = await fetch('/google-calendar-proxy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: uid, action: 'create', target: 'work', event }),
    });
    if (!res.ok) {
      status.style.color = '#E74C3C';
      const t = await res.text();
      status.textContent = /No work calendar|404/.test(t) ? 'No work calendar configured — set one in Admin → Calendars.' : 'Add failed: ' + t.slice(0, 80);
      return;
    }
    document.getElementById('sch-title').value = '';
    status.style.color = '#2D6A4F'; status.textContent = 'Added.';
    window.flashSaved?.();
    refresh();
  });
}

if (typeof window !== 'undefined') window.openScheduleModal = openScheduleModal;
