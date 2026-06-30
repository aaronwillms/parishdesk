import { sb, deleteWithRetry } from '../supabase.js';
import { store } from '../store.js';
import { todayCST, fmtDateYear, PANEL_TITLES, personTitle } from '../utils.js';
import { formatPhone, normalizePhone } from '../utils/phone.js';
import { upsertProgramCoordinators, PREP_PROGRAMS } from './programCoordinators.js';
import { accessibleParishesForSacrament } from '../roles.js';
import { getActiveParishTab, onParishTabChange } from '../sacramental/panelShell.js';

// Header program key → the sacrament access key(s) used by accessibleParishesForSacrament.
// ⚠️ First Communion's header prog is 'firstcomm' but its access keys are the dual
// ['first_communion','firstcomm'] — map it explicitly so FC resolves its parishes.
const PROG_ACCESS_KEYS = {
  baptism:      ['baptism'],
  firstcomm:    ['first_communion', 'firstcomm'],
  confirmation: ['confirmation'],
  ocia:         ['ocia'],
  marriage:     ['marriage'],
};
// Header prog → panelShell panelKey (the tab state is keyed by panelKey, and FC's
// panelKey 'firstcommunion' ≠ its header prog 'firstcomm').
const PROG_PANEL_KEY = {
  baptism: 'baptism', firstcomm: 'firstcommunion', confirmation: 'confirmation', ocia: 'ocia', marriage: 'marriage',
};
// Inverse: panelShell panelKey → header prog (for the tab-change callback).
const PANEL_KEY_PROG = {
  baptism: 'baptism', firstcommunion: 'firstcomm', confirmation: 'confirmation', ocia: 'ocia', marriage: 'marriage',
};

let coordData = {};      // prep → { [parishId]: row }; cura → single row|null (unchanged shape)
let scheduleData = {};

export async function loadCoordData(prog) {
  const isPrep = PREP_PROGRAMS.has(prog);
  // PREP: fetch coordinator rows for ALL accessible parishes (the header then renders
  // per-parish, filtered by the active tab). CURA (annulments/discernment/homebound):
  // the single group-shared NULL-parish row, exactly as before.
  let coordQuery;
  if (isPrep) {
    const accessibleIds = accessibleParishesForSacrament(PROG_ACCESS_KEYS[prog] || [prog]).map(p => p.id);
    coordQuery = accessibleIds.length
      ? sb.from('program_coordinators').select('*').eq('program', prog).in('parish_id', accessibleIds)
      : sb.from('program_coordinators').select('*').eq('program', prog).eq('parish_id', store.parishSettings?.id); // no group list → home parish
  } else {
    coordQuery = sb.from('program_coordinators').select('*').eq('program', prog).is('parish_id', null);
  }
  const [coordRes, schedRes] = await Promise.all([
    coordQuery,   // array (no maybeSingle — prep may have multiple rows)
    sb.from('program_schedule').select('*').eq('program', prog).gte('event_date', todayCST()).order('event_date').order('event_time')
  ]);
  if (isPrep) {
    const byParish = {};
    (coordRes.data || []).forEach(row => { if (row.parish_id) byParish[row.parish_id] = row; });
    coordData[prog] = byParish;                          // { [parishId]: row }
  } else {
    coordData[prog] = (coordRes.data && coordRes.data[0]) || null;   // single row|null (unchanged shape)
  }
  scheduleData[prog] = schedRes.data || [];
  renderCoordCard(prog);
}

// Resolve a single program_coordinators ROW → personnel records (or legacy embedded
// coordinator objects). Used per-parish for prep and once for cura.
function coordinatorsFromRow(d) {
  if (!d) return [];
  if (d.coordinator_ids && d.coordinator_ids.length) {
    const personnel = store.personnel || [];
    return d.coordinator_ids.map(id => personnel.find(p => p.id === id)).filter(Boolean);
  }
  if (d.coordinators && d.coordinators.length) return d.coordinators;   // legacy embedded
  if (d.name) return [{ name: d.name, phone: d.phone || null, email: d.email || null }];
  return [];
}

// One coordinator person (name + phone/email links). `sep` adds the divider for 2nd+.
function coordPersonHtml(c, sep) {
  const contacts = [
    c.phone ? `<a href="tel:${normalizePhone(c.phone)}" style="display:inline-flex;align-items:center;gap:3px;font-size:11.5px;color:#8FA8BF;text-decoration:none;">📞 ${formatPhone(c.phone)}</a>` : '',
    c.email ? `<a href="mailto:${c.email}" style="display:inline-flex;align-items:center;gap:3px;font-size:11.5px;color:#8FA8BF;text-decoration:none;">✉️ ${c.email}</a>` : '',
  ].filter(Boolean).join('');
  return `<div style="${sep ? 'margin-top:8px;padding-top:8px;border-top:.5px solid rgba(255,255,255,.1);' : ''}">
    <div style="font-family:'Inter',sans-serif;font-weight:500;font-size:14px;color:#F5F1EB;">${c.name}</div>
    ${contacts ? `<div style="margin-top:3px;display:flex;flex-wrap:wrap;gap:8px;">${contacts}</div>` : ''}
  </div>`;
}
// Section label: grey "Program Coordinator(s)" heading, or a gold parish-name tag.
const _coordHeading = (txt, gold) => `<div style="font-size:10.5px;font-weight:600;color:${gold ? 'var(--gold)' : '#6B7280'};text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px;">${txt}</div>`;
// The classic single-group output (heading + people) — single-parish prep + cura.
function _singleGroupHtml(coords) {
  return _coordHeading(coords.length > 1 ? 'Program Coordinators' : 'Program Coordinator')
    + coords.map((c, i) => coordPersonHtml(c, i > 0)).join('');
}

// The parish a coordinator Edit/Save targets for a prog:
//   • cura (non-prep)        → null (group-wide), handled by the callers, not here.
//   • single accessible parish → that one parish (the active tab is 'all' by default
//     even when there's only one parish, so resolve by count, not the tab).
//   • multi-parish + specific tab → that parish.
//   • multi-parish + 'All' tab → null (no single target → Edit disabled, save aborted).
function _editParishId(prog) {
  const accParishes = accessibleParishesForSacrament(PROG_ACCESS_KEYS[prog] || [prog]);
  if (accParishes.length <= 1) return accParishes[0]?.id || store.parishSettings?.id || null;
  const tab = getActiveParishTab(PROG_PANEL_KEY[prog] || prog);
  return tab === 'all' ? null : tab;
}

// Toggle the STATIC blue-bar Edit button (in index.html) — there's no id on it, so we
// select by its onclick attribute. Disabled (greyed) for a prep program with no single
// target parish (i.e. multi-parish on the "All" tab); enabled otherwise.
function _setEditDisabled(prog, disabled) {
  const btn = document.querySelector(`button[onclick="openCoordModal('${prog}')"]`);
  if (!btn) return;
  btn.disabled = disabled;
  btn.style.opacity = disabled ? '0.4' : '';
  btn.style.cursor = disabled ? 'not-allowed' : 'pointer';
  btn.title = disabled ? 'Select a parish to edit coordinators' : '';
}

function renderCoordCard(prog) {
  const isPrep = PREP_PROGRAMS.has(prog);
  const schedule = scheduleData[prog] || [];
  const nameEl = document.getElementById('coord-name-' + prog);
  const contactEl = document.getElementById('coord-contact-' + prog);
  const nextEl = document.getElementById('coord-next-' + prog);
  if (!nameEl) return;

  // Edit is only disabled for a prep program whose target parish is ambiguous (multi
  // on All). Recomputed every render so it reacts live to tab switches (onParishTabChange).
  _setEditDisabled(prog, isPrep && _editParishId(prog) == null);

  if (isPrep) {
    const accParishes = accessibleParishesForSacrament(PROG_ACCESS_KEYS[prog] || [prog]);
    const byParish = coordData[prog] || {};
    const multi = accParishes.length > 1;
    const shortName = (p) => (p.display_name || p.parish_name || 'Parish');

    if (!multi) {
      // Single-parish: one group, classic heading, no parish tag (parity with today).
      const coords = accParishes[0] ? coordinatorsFromRow(byParish[accParishes[0].id]) : [];
      if (coords.length) nameEl.innerHTML = _singleGroupHtml(coords);
      else nameEl.textContent = 'No coordinator set';
    } else {
      // Multi-parish: follow the active tab. All → every parish that HAS a coordinator,
      // each tagged with its short name; a specific tab → only that parish.
      const tab = getActiveParishTab(PROG_PANEL_KEY[prog] || prog);   // 'all' | parishId
      const targets = tab === 'all' ? accParishes : accParishes.filter(p => p.id === tab);
      const groups = targets
        .map(p => ({ p, coords: coordinatorsFromRow(byParish[p.id]) }))
        .filter(g => tab === 'all' ? g.coords.length : true);   // All omits empty parishes; a specific tab keeps it to show "none"
      if (!groups.some(g => g.coords.length)) {
        nameEl.textContent = 'No coordinator set';
      } else {
        nameEl.innerHTML = groups.map((g, gi) =>
          `<div style="${gi > 0 ? 'margin-top:10px;padding-top:10px;border-top:.5px solid rgba(255,255,255,.14);' : ''}">`
          + _coordHeading(shortName(g.p), /*gold tag*/true)
          + g.coords.map((c, i) => coordPersonHtml(c, i > 0)).join('')
          + `</div>`
        ).join('');
      }
    }
    if (contactEl) contactEl.innerHTML = '';
  } else {
    // CURA (annulments/discernment/homebound) — single group-shared row, unchanged.
    const coords = coordinatorsFromRow(coordData[prog]);
    if (coords.length) nameEl.innerHTML = _singleGroupHtml(coords);
    else nameEl.textContent = 'No coordinator set';
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
  const isPrep = PREP_PROGRAMS.has(prog);
  // PREP: edit the ACTIVE parish's row; pre-check that parish's current coordinators.
  // CURA: the single group-shared row (unchanged shape).
  let selectedIds, parishLabel = '';
  if (isPrep) {
    const parishId = _editParishId(prog);
    if (parishId == null) return;   // no single target (multi + All) — Edit is disabled; safety no-op
    selectedIds = coordData[prog]?.[parishId]?.coordinator_ids || [];
    const accParishes = accessibleParishesForSacrament(PROG_ACCESS_KEYS[prog] || [prog]);
    if (accParishes.length > 1) {
      const p = accParishes.find(gp => gp.id === parishId);
      if (p) parishLabel = ' — ' + (p.display_name || p.parish_name || 'Parish');
    }
  } else {
    selectedIds = coordData[prog]?.coordinator_ids || [];   // cura: single object
  }
  const lastName = name => (name || '').trim().split(/\s+/).pop();
  const personnel = (store.personnel || []).slice().sort((a, b) =>
    lastName(a.name).localeCompare(lastName(b.name)) || (a.name || '').localeCompare(b.name || '')
  );

  console.log('[coordinator] openCoordModal personnel count:', personnel.length, personnel[0]);
  const options = personnel.map(p => {
    const checked = selectedIds.includes(p.id) ? 'checked' : '';
    const nameStr = p.name ?? '(no name)';
    const subParts = [personTitle(p.id)].filter(Boolean);
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
    <div class="modal-title">Coordinators — ${PANEL_TITLES[prog] || prog}${parishLabel}</div>
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
  // PREP writes to the ACTIVE parish tab (a (program, parish_id) row — coexists with the
  // other parish's row, no overwrite). CURA stays group-wide (NULL parish).
  let parishId = null;
  if (PREP_PROGRAMS.has(prog)) {
    parishId = _editParishId(prog);
    if (parishId == null) { console.warn('[coordinator] saveCoord aborted — no parish selected (All tab)'); return; }
  }
  const { error } = await upsertProgramCoordinators(prog, coordinator_ids, parishId);
  if (error) { alert('Save failed: ' + error.message); return; }
  // Re-fetch the per-parish map and re-render the active tab so the bar updates
  // immediately (mirrors the schedule handlers — no stale in-memory patch).
  await loadCoordData(prog);
  renderCoordCard(prog);
  window.flashSavedThen(() => closeModal());
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
  window.flashSavedThen(() => openScheduleModal(prog));
}

async function deleteScheduleEntry(prog, id) {
  const { error } = await deleteWithRetry(() => sb.from('program_schedule').delete().eq('id', id));
  if (error) { alert('Delete failed: ' + error.message); return; }
  await loadCoordData(prog);
  openScheduleModal(prog);
}

Object.assign(window, {
  openCoordModal, saveCoord,
  openScheduleModal, saveScheduleEntries, deleteScheduleEntry,
  addScheduleRow, removeScheduleRow,
});

// Live-update the coordinator header when the user switches parish tabs in the shell.
// The shell fires (panelKey, rawTab); map panelKey → header prog and re-render that
// card from already-loaded data (renderCoordCard reads the active tab fresh).
onParishTabChange((panelKey) => {
  const prog = PANEL_KEY_PROG[panelKey];
  if (prog) renderCoordCard(prog);
});
