import { sb } from '../supabase.js';
import { store } from '../store.js';
import { todayCST, fmtDateYear, PANEL_TITLES } from '../utils.js';
import { formatPhone, normalizePhone } from '../utils/phone.js';

let coordData = {};
let scheduleData = {};

export async function loadCoordData(prog) {
  const [coordRes, schedRes] = await Promise.all([
    sb.from('program_coordinators').select('*').eq('program', prog).maybeSingle(),
    sb.from('program_schedule').select('*').eq('program', prog).gte('event_date', todayCST()).order('event_date').order('event_time')
  ]);
  coordData[prog] = coordRes.data || null;
  scheduleData[prog] = schedRes.data || [];
  renderCoordCard(prog);
}

// Resolve coordinator_ids → personnel records from store.
// Falls back to legacy embedded coordinators JSONB for old rows.
function getCoordinators(prog) {
  const d = coordData[prog];
  if (!d) return [];
  if (d.coordinator_ids && d.coordinator_ids.length) {
    const personnel = store.personnel || [];
    return d.coordinator_ids
      .map(id => personnel.find(p => p.id === id))
      .filter(Boolean);
  }
  // Backward compat: embedded name/phone/email objects
  if (d.coordinators && d.coordinators.length) return d.coordinators;
  if (d.name) return [{ name: d.name, phone: d.phone || null, email: d.email || null }];
  return [];
}

function renderCoordCard(prog) {
  const coords = getCoordinators(prog);
  const schedule = scheduleData[prog] || [];
  const nameEl = document.getElementById('coord-name-' + prog);
  const contactEl = document.getElementById('coord-contact-' + prog);
  const nextEl = document.getElementById('coord-next-' + prog);
  if (!nameEl) return;

  if (coords.length) {
    const heading = coords.length > 1 ? 'Program Coordinators' : 'Program Coordinator';
    nameEl.innerHTML = `<div style="font-size:10.5px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px;">${heading}</div>` +
    coords.map((c, i) => {
      const contacts = [
        c.phone ? `<a href="tel:${normalizePhone(c.phone)}" style="display:inline-flex;align-items:center;gap:3px;font-size:11.5px;color:#8FA8BF;text-decoration:none;">📞 ${formatPhone(c.phone)}</a>` : '',
        c.email ? `<a href="mailto:${c.email}" style="display:inline-flex;align-items:center;gap:3px;font-size:11.5px;color:#8FA8BF;text-decoration:none;">✉️ ${c.email}</a>` : '',
      ].filter(Boolean).join('');
      return `<div style="${i > 0 ? 'margin-top:8px;padding-top:8px;border-top:.5px solid rgba(255,255,255,.1);' : ''}">
        <div style="font-family:'Inter',sans-serif;font-weight:500;font-size:14px;color:#F5F1EB;">${c.name}</div>
        ${contacts ? `<div style="margin-top:3px;display:flex;flex-wrap:wrap;gap:8px;">${contacts}</div>` : ''}
      </div>`;
    }).join('');
    if (contactEl) contactEl.innerHTML = '';
  } else {
    nameEl.textContent = 'No coordinator set';
    if (contactEl) contactEl.innerHTML = '';
  }

  if (nextEl) {
    if (schedule.length) {
      const next = schedule[0];
      nextEl.innerHTML = `📅 Next: ${next.label || 'Class'} · ${fmtDateYear(next.event_date)}${next.event_time ? ' · ' + next.event_time : ''}${schedule.length > 1 ? ' <span style="opacity:.6;">(+' + (schedule.length - 1) + ' more)</span>' : ''}`;
    } else {
      nextEl.innerHTML = '';
    }
  }
}

// ── Coordinator modal ──────────────────────────────────────────────────────────

function openCoordModal(prog) {
  const d = coordData[prog];
  const selectedIds = (d?.coordinator_ids) || [];
  const lastName = name => (name || '').trim().split(/\s+/).pop();
  const personnel = (store.personnel || []).slice().sort((a, b) =>
    lastName(a.name).localeCompare(lastName(b.name)) || (a.name || '').localeCompare(b.name || '')
  );

  console.log('[coordinator] openCoordModal personnel count:', personnel.length, personnel[0]);
  const options = personnel.map(p => {
    const checked = selectedIds.includes(p.id) ? 'checked' : '';
    const nameStr = p.name ?? '(no name)';
    const subParts = [p.title, p.type].filter(Boolean);
    const sub = subParts.join(' · ');
    return `<label style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:.5px solid var(--stone);cursor:pointer;">
      <input type="checkbox" value="${p.id}" ${checked} style="flex-shrink:0;accent-color:var(--cardinal);width:15px;height:15px;" />
      <span style="min-width:0;">
        <span style="font-size:13px;color:var(--navy);font-weight:500;display:block;">${nameStr}</span>
        ${sub ? `<span style="font-size:11px;color:#6B7280;display:block;">${sub}</span>` : ''}
      </span>
    </label>`;
  }).join('');

  document.getElementById('modal-content').innerHTML = `
    <div class="modal-title">Coordinators — ${PANEL_TITLES[prog] || prog}</div>
    ${personnel.length
      ? `<div id="cd-person-list" style="max-height:320px;overflow-y:auto;">${options}</div>`
      : `<div style="font-size:13px;color:#6B7280;padding:.5rem 0;">No personnel found. Add staff or volunteers in the Personnel panel first.</div>`
    }
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" onclick="saveCoord('${prog}')">Save</button>
    </div>`;
  document.getElementById('modal-overlay').classList.add('open');
}

async function saveCoord(prog) {
  const checkboxes = document.querySelectorAll('#cd-person-list input[type="checkbox"]:checked');
  const coordinator_ids = Array.from(checkboxes).map(cb => cb.value);
  const payload = {
    program: prog,
    coordinator_ids,
    updated_at: new Date().toISOString()
  };
  const { error } = await sb.from('program_coordinators').upsert(payload, { onConflict: 'program' });
  if (error) { alert('Save failed: ' + error.message); return; }
  if (!coordData[prog]) coordData[prog] = {};
  coordData[prog].coordinator_ids = coordinator_ids;
  renderCoordCard(prog);
  closeModal();
}

// ── Schedule modal ─────────────────────────────────────────────────────────────

function scheduleEntryRow(i) {
  return `<div id="sc-row-${i}" style="display:grid;grid-template-columns:1fr auto auto auto;gap:6px;margin-bottom:6px;align-items:center;">
    <input id="sc-label-${i}" placeholder="Class / event name" style="border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.35rem .6rem;font-size:12.5px;font-family:'Inter',sans-serif;background:#FFFFFF;outline:none;" />
    <input type="date" id="sc-date-${i}" value="${todayCST()}" style="border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.35rem .6rem;font-size:12.5px;font-family:'Inter',sans-serif;background:#FFFFFF;outline:none;" />
    <input id="sc-time-${i}" placeholder="7:00 PM" style="width:80px;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.35rem .6rem;font-size:12.5px;font-family:'Inter',sans-serif;background:#FFFFFF;outline:none;" />
    <button type="button" onclick="removeScheduleRow(${i})" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:16px;padding:0;line-height:1;" title="Remove row" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#CCC'">✕</button>
  </div>`;
}

function addScheduleRow() {
  const i = window._schedRowCount++;
  const container = document.getElementById('sc-entries');
  const div = document.createElement('div');
  div.innerHTML = scheduleEntryRow(i);
  container.appendChild(div.firstElementChild);
}

function removeScheduleRow(i) {
  document.getElementById('sc-row-' + i)?.remove();
}

function openScheduleModal(prog) {
  const upcoming = scheduleData[prog] || [];
  const rows = upcoming.length
    ? upcoming.map(e => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:.5px solid var(--stone);font-size:13px;">
      <span style="flex:1;color:var(--navy);">${e.label || 'Class'} — ${fmtDateYear(e.event_date)}${e.event_time ? ' · ' + e.event_time : ''}</span>
      <button onclick="deleteScheduleEntry('${prog}','${e.id}')" style="background:none;border:none;cursor:pointer;color:#AAA;font-size:16px;padding:2px 6px;flex-shrink:0;line-height:1;" title="Delete session" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#AAA'">✕</button>
    </div>`).join('')
    : '<div style="font-size:13px;color:#6B7280;font-style:italic;padding:4px 0;">No sessions scheduled.</div>';

  document.getElementById('modal-content').innerHTML = `
    <div class="modal-title">Schedule — ${PANEL_TITLES[prog] || prog}</div>
    <div style="max-height:200px;overflow-y:auto;margin-bottom:12px;">${rows}</div>
    <div style="background:var(--parch);border-radius:var(--radius-sm);padding:.75rem;border:.5px solid var(--stone);">
      <div style="font-size:11px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;">Add sessions</div>
      <div id="sc-entries">${scheduleEntryRow(0)}</div>
      <button type="button" onclick="addScheduleRow()" style="font-size:12px;color:var(--cardinal);background:none;border:none;cursor:pointer;font-family:'Inter',sans-serif;padding:4px 0;margin-top:2px;">+ Add another</button>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Done</button>
      <button class="btn-primary" onclick="saveScheduleEntries('${prog}')">Save</button>
    </div>`;
  document.getElementById('modal-overlay').classList.add('open');
  window._schedRowCount = 1;
}

async function saveScheduleEntries(prog) {
  const rows = [];
  for (let i = 0; i < (window._schedRowCount || 1); i++) {
    const dateEl = document.getElementById('sc-date-' + i);
    const labelEl = document.getElementById('sc-label-' + i);
    const timeEl = document.getElementById('sc-time-' + i);
    if (dateEl && dateEl.value) {
      rows.push({ program: prog, label: labelEl?.value.trim() || 'Class', event_date: dateEl.value, event_time: timeEl?.value.trim() || null });
    }
  }
  if (!rows.length) { alert('Please enter at least one date.'); return; }
  const { error } = await sb.from('program_schedule').insert(rows);
  if (error) { alert('Save failed: ' + error.message); return; }
  await loadCoordData(prog);
  openScheduleModal(prog);
}

async function deleteScheduleEntry(prog, id) {
  const { error } = await sb.from('program_schedule').delete().eq('id', id);
  if (error) { alert('Delete failed: ' + error.message); return; }
  await loadCoordData(prog);
  openScheduleModal(prog);
}

Object.assign(window, {
  openCoordModal, saveCoord,
  openScheduleModal, saveScheduleEntries, deleteScheduleEntry,
  addScheduleRow, removeScheduleRow,
});
