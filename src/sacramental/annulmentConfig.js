// ── Annulments config for the sacramental master-detail shell ───────────────
// Subject is a CASE (not a person/couple). Shell mount, status-grouped list with a
// bottom Archive section, full chip system, read-first detail, the inline
// type-driven edit form, viewer-editable documents + timeline, and the Priority
// Actions banner. Reuses the data/helpers from panels/annulments.js.
//
// Status field is `status_code`: prep | tribunal | affirm | negative | archived
// (label "Inactive"). The separate `archived` BOOLEAN is independent of status and
// pulls a case into the bottom "Archived" group regardless of its status.
// judgement_finalized ('yes'/'no') drives the pending-vs-final judgement chip.

import { formatDateDisplay, fmtDate, todayCST } from '../utils.js';
import { formatPhone } from '../utils/phone.js';
import { isSacramentCoordinator } from '../roles.js';
import {
  getCaseRecords, getCaseRecord, anlCanManage, CASE_STATUS, TYPE_BADGE,
  caseType, petName, respName, petLast, respLast, advocateName, caseDocs,
  buildAnlEditForm, anlSaveEdit, anlDeleteRec, TIMELINE_EVENTS, parseCaseNotes,
} from '../panels/annulments.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Group keys: the five status_code values + '__archived' (the archived boolean
// section, always last). archived overrides status placement.
const GROUP_ORDER = ['prep', 'tribunal', 'affirm', 'negative', 'archived', '__archived'];
const GROUP_LABEL = { prep: 'Preparing', tribunal: 'In Tribunal', affirm: 'Affirmative Judgement', negative: 'Negative Judgement', archived: 'Inactive', __archived: 'Archived' };

function isFinalized(c) { return c.judgement_finalized === 'yes' || c.judgement_finalized === true; }
// SIDEBAR CARD title — "Last vs Last", maiden overriding last; degrade to "—".
function caseTitle(c) { return `${petLast(c) || '—'} vs ${respLast(c) || '—'}`; }
// FILE VIEWER heading — full "First Last vs First Last", maiden overriding last
// (petLast/respLast already apply the maiden override). Degrades to "—" per side.
function fullName(first, last) { return [first, last].filter(Boolean).join(' '); }
function viewerTitle(c) {
  const p = fullName(c.petitioner_first, petLast(c)) || petName(c) || '—';
  const r = fullName(c.respondent_first, respLast(c)) || '—';
  return `${p} vs ${r}`;
}

// ── Chips ────────────────────────────────────────────────────────────────────
// All colors are REUSED from the existing CASE_STATUS palette / the existing
// briefer chip — no new hex introduced. Dark mode slates badge bg/color via the
// shared !important rule (consistent with every badge); the pending dashed border
// (its own color) survives, keeping pending visually distinct in both themes.
function typeChip(c) {
  // Briefer replaces the FORMAL type chip, so render it IDENTICALLY to a type chip
  // (grey/neutral, same size/padding) — it should read as a type, not stand out.
  if (c.briefer_process) return { label: 'Briefer Process', tone: 'neutral' };
  return { label: TYPE_BADGE[caseType(c)] || 'Type', tone: 'neutral' };
}
// Status-chip palette (light mode): Preparing = purple (the design-system enrolled/
// inquirer purple), In Tribunal = yellow, Affirmative = green, Negative = red,
// Inactive = grey. Dark mode slates all badges via the shared !important rule; the
// pending dashed border (its own hue) survives so pending stays distinct.
const STATUS_CHIP_STYLE = {
  prep:     'background:#EDE9FE;color:#4A1D96;',
  tribunal: 'background:#FEF9E7;color:#7D6608;',
  affirm:   'background:#D8F3DC;color:#2D6A4F;',
  negative: 'background:#FDEDEC;color:#922B21;',
  archived: 'background:#F2F3F4;color:#616A6B;',
};
const PENDING_BORDER = { affirm: '#2D6A4F', negative: '#922B21' };
function statusChip(c) {
  const code = c.status_code || 'prep';
  const base = STATUS_CHIP_STYLE[code] || STATUS_CHIP_STYLE.prep;
  if (code === 'affirm' || code === 'negative') {
    const label = code === 'affirm' ? 'Affirmative' : 'Negative';
    return isFinalized(c)
      ? { label, tone: 'neutral', style: base }
      : { label: `${label} · Pending`, tone: 'neutral', style: `${base}border:1px dashed ${PENDING_BORDER[code]};` };
  }
  return { label: (CASE_STATUS[code] || CASE_STATUS.prep).label, tone: 'neutral', style: base };
}
// Green "Docs Complete" — ONLY on Preparing and Inactive cases, and only when every
// document is checked. Never shown on In Tribunal / Judgement; no "incomplete" chip
// (missing docs surface in the Phase 2 Priority Actions banner).
function docsCompleteChip(c) {
  const code = c.status_code || 'prep';
  if (code !== 'prep' && code !== 'archived') return null;
  const docs = caseDocs(c);
  if (!docs.length || !docs.every(d => d.received)) return null;
  return { label: 'Docs Complete', tone: 'active' };
}

// ── Read-detail renderers ────────────────────────────────────────────────────
function row(label, val) {
  return val ? `<div style="display:flex;gap:10px;font-size:13px;padding:3px 0;"><span style="color:#6B7280;min-width:140px;">${esc(label)}</span><span style="flex:1;color:var(--navy);">${val}</span></div>` : '';
}
// Person Responsible for Formation — the single `preparer` string column
// (consolidation standard). The legacy preparation_responsible_* fallback was
// removed after those columns were dropped from annulment_cases.
function personResponsible(c) { return c.preparer || ''; }
function statusLabel(c) {
  const code = c.status_code || 'prep';
  if (code === 'affirm' || code === 'negative') {
    const base = code === 'affirm' ? 'Affirmative' : 'Negative';
    return isFinalized(c) ? `${base} (final)` : `${base} · Pending`;
  }
  return (CASE_STATUS[code] || CASE_STATUS.prep).label;
}
function caseDetails(c) {
  const phone = c.contact_phone || c.petitioner_cell;
  const email = c.contact_email || c.petitioner_email;
  return [
    row('Petitioner', petName(c) ? esc(petName(c)) : ''),
    row('Respondent', respName(c) ? esc(respName(c)) : ''),
    c.co_petitioner ? row('Co-petitioner', esc(c.co_petitioner)) : '',
    row('Type', c.briefer_process ? 'Briefer Process' : esc(TYPE_BADGE[caseType(c)] || '')),
    row('Status', esc(statusLabel(c))),
    row('Tribunal diocese', c.tribunal_diocese ? esc(c.tribunal_diocese) : ''),
    row('Date filed', c.date_filed ? esc(formatDateDisplay(c.date_filed)) : ''),
    row('Date received', c.date_received ? esc(formatDateDisplay(c.date_received)) : ''),
    row('Phone', phone ? esc(formatPhone(phone)) : ''),
    row('Email', email ? esc(email) : ''),
    row('Advocate', advocateName(c) ? esc(advocateName(c)) : ''),
    row('Person responsible', personResponsible(c) ? esc(personResponsible(c)) : ''),
  ].filter(Boolean).join('') || '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No details yet.</div>';
}
// Detect the PETITIONER baptism document: a doc whose name mentions "baptism"
// (covers "Baptismal Record", "Petitioner Baptismal Certificate or Affidavit",
// "Baptism Documentation", etc.) and is NOT the respondent's. Its `received` flag
// gates the viewer baptism block. Petitioner only.
function petBaptismDocIdx(docs) {
  return docs.findIndex(d => /baptism/i.test(d.name) && !/respondent/i.test(d.name));
}
// Compact read-only baptism location (shown beneath the doc line when received).
function baptismReadonly(c) {
  const cityState = [c.petitioner_baptism_city, c.petitioner_baptism_state].filter(Boolean).map(esc).join(', ');
  const parts = [c.petitioner_baptism_church ? esc(c.petitioner_baptism_church) : '', cityState, c.petitioner_baptism_country ? esc(c.petitioner_baptism_country) : ''].filter(Boolean);
  return parts.length
    ? `<div style="margin:0 0 5px 23px;font-size:11.5px;color:#6B7280;line-height:1.4;">${parts.join(' · ')}</div>`
    : `<div style="margin:0 0 5px 23px;font-size:11.5px;color:#9CA3AF;font-style:italic;">No baptism location recorded.</div>`;
}
// All four petitioner baptism fields filled (trimmed)? Gates the baptism checkbox.
const BAPTISM_FIELDS = ['petitioner_baptism_church', 'petitioner_baptism_city', 'petitioner_baptism_state', 'petitioner_baptism_country'];
export const BAPTISM_LOCK_TIP = 'Enter the church name, city, and state before marking the baptism record received.';
function baptismFilled(c) { return BAPTISM_FIELDS.every(k => String(c[k] || '').trim()); }

// Inline-editable baptism location (shown beneath the doc line when NOT received).
// Pre-populated from the stored petitioner_baptism_* values; each field saves on
// change via the write-retry wrapper (anlSaveBaptismField). When `locked` (not all
// fields filled), shows the prompt explaining why the checkbox is disabled.
function baptismEditable(c, locked) {
  const inS = `border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.3rem .5rem;font-size:12px;font-family:'Inter',sans-serif;background:#fff;box-sizing:border-box;`;
  const fld = (field, ph, val, grow) => `<input type="text" value="${esc(val || '')}" placeholder="${ph}" onchange="anlSaveBaptismField('${c.id}','${field}',this)" style="${inS}flex:${grow};min-width:0;" />`;
  return `<div style="margin:1px 0 8px 23px;">
    <div style="font-size:10px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#9CA3AF;margin-bottom:4px;">Baptism location (record not yet received)</div>
    <div style="display:flex;gap:5px;flex-wrap:wrap;">
      ${fld('church', 'Church of Baptism', c.petitioner_baptism_church, 2)}
      ${fld('city', 'City', c.petitioner_baptism_city, 1)}
      ${fld('state', 'State', c.petitioner_baptism_state, 1)}
      ${fld('country', 'Country', c.petitioner_baptism_country || 'United States of America', 1)}
    </div>
    <div id="anl-bdoc-note-${c.id}" style="display:${locked ? 'block' : 'none'};font-size:11px;color:#9A6A1E;margin-top:5px;">
      <i class="fa-solid fa-circle-info" style="margin-right:4px;"></i>${esc(BAPTISM_LOCK_TIP)}
    </div>
  </div>`;
}
// Checklist driven by the case's type template; checkboxes are viewer-editable and
// route through the write-retry wrapper (toggleCaseDoc). Beneath the petitioner
// baptism doc, the four baptism-location fields render state-dependently: editable
// inputs while unchecked, compact read-only text once received. The baptism doc's
// checkbox is DISABLED (forward-only gate) until all four fields are filled — an
// already-received doc is never force-unchecked.
function docLine(c, d, i, opts = {}) {
  const canManage = anlCanManage();
  const clickable = canManage && !opts.locked;
  const click = clickable ? `onclick="toggleCaseDoc('${c.id}',${i})"` : '';
  const boxStyle = `font-size:15px;${clickable ? 'cursor:pointer;' : (opts.locked ? 'cursor:not-allowed;opacity:.45;' : '')}`;
  const boxAttrs = `${opts.boxId ? `id="${opts.boxId}" ` : ''}${click}${opts.locked ? ` title="${esc(BAPTISM_LOCK_TIP)}"` : ''}`;
  return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px;">
    <span style="${boxStyle}" ${boxAttrs}>${d.received ? '✅' : '⬜'}</span>
    <span style="flex:1;${clickable ? 'cursor:pointer;' : ''}color:${d.received ? '#2D6A4F' : 'var(--navy)'};" ${click}>${esc(d.name)}</span>
    ${d.deletable === false ? `<i class="fa-solid fa-lock" style="color:#C9C2B6;font-size:11px;" title="Required"></i>` : ''}
  </div>`;
}
function documents(c) {
  const canManage = anlCanManage();
  const docs = caseDocs(c);
  if (!docs.length) return '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No documents.</div>';
  const bIdx = petBaptismDocIdx(docs);
  return docs.map((d, i) => {
    if (i !== bIdx) return docLine(c, d, i);
    // Forward-only gate: lock only when UNCHECKED and not all four fields filled.
    const locked = canManage && !d.received && !baptismFilled(c);
    const line = docLine(c, d, i, { locked, boxId: `anl-bdoc-box-${c.id}` });
    const extra = d.received ? baptismReadonly(c) : (canManage ? baptismEditable(c, locked) : baptismReadonly(c));
    return line + extra;
  }).join('');
}
// Shared timeline/notes list entry: a gold bullet on a gold vertical line, the text
// label with a small timestamp beneath, and a hover-X (revealed on row hover) sitting
// immediately to the right of the label. Bullets are UNIFORM — auto-milestones and
// manual entries look identical (type is still stored, just not shown). The classes
// are panel-agnostic (sac-tl-*) so the same pattern carries to other panels.
function tlEntry(text, when, delHandler, canManage) {
  return `<div class="sac-tl-entry">
    <div class="sac-tl-row">
      <span class="sac-tl-text">${esc(text)}</span>
      ${canManage && delHandler ? `<button class="sac-tl-x" title="Delete" onclick="${delHandler}">×</button>` : ''}
    </div>
    ${when ? `<div class="sac-tl-time">${esc(when)}</div>` : ''}
  </div>`;
}
const tlWhen = (e) => (e.created_at || e.date) ? fmtDate(String(e.created_at || e.date).slice(0, 10)) : '';

// Full timeline — gold line + uniform bullets. Below the list, the "Add Event"
// control: a dropdown of preseeded procedural events + "Other…" free-text + an
// editable date picker (today by default; an earlier date backdates the entry).
function timeline(c) {
  const canManage = anlCanManage();
  const raw = Array.isArray(c.timeline) ? c.timeline : [];
  const body = raw.length
    ? `<div class="sac-tl">${raw.map((e, i) => tlEntry(e.text || e.event || '', tlWhen(e), `anlDeleteTimelineEntry('${c.id}',${i})`, canManage)).join('')}</div>`
    : '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No timeline entries yet.</div>';

  let add = '';
  if (canManage) {
    const opts = TIMELINE_EVENTS.map(ev => `<option value="${esc(ev)}">${esc(ev)}</option>`).join('');
    add = `<div class="sac-add-block">
      <div class="sac-add-head">Add Event</div>
      <select id="anl-tl-sel-${c.id}" onchange="anlTlSelChange('${c.id}')" style="width:100%;box-sizing:border-box;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;">
        ${opts}<option value="__other">Other…</option>
      </select>
      <div id="anl-tl-other-${c.id}" style="display:none;margin-top:6px;">
        <input type="text" id="anl-tl-other-input-${c.id}" placeholder="Event description…" style="width:100%;box-sizing:border-box;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;" />
      </div>
      <div style="display:flex;gap:6px;margin-top:6px;align-items:center;">
        <input type="date" id="anl-tl-date-${c.id}" value="${esc(todayCST())}" style="flex:1;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;" />
        <button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;white-space:nowrap;" onclick="anlAddTimelineEntry('${c.id}')">+ Add event</button>
      </div>
    </div>`;
  }
  return body + add;
}

// Notes — a deletable list (text + timestamp) using the same line/bullet + hover-X
// styling as the timeline, plus an "Add Note" control styled like "Add Event".
// Stored as a JSON array in the `notes` TEXT column (parseCaseNotes tolerates a
// legacy plain-string note). Writes route through the retry wrapper.
function notes(c) {
  const canManage = anlCanManage();
  const list = parseCaseNotes(c);
  const body = list.length
    ? `<div class="sac-tl">${list.map((n, i) => tlEntry(n.text || '', tlWhen(n), `anlDeleteNote('${c.id}',${i})`, canManage)).join('')}</div>`
    : '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No notes yet.</div>';

  let add = '';
  if (canManage) {
    add = `<div class="sac-add-block">
      <div class="sac-add-head">Add Note</div>
      <div style="display:flex;gap:6px;align-items:center;">
        <input type="text" id="anl-note-input-${c.id}" placeholder="Write a note…" onkeydown="if(event.key==='Enter'){event.preventDefault();anlAddNote('${c.id}');}" style="flex:1;box-sizing:border-box;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;" />
        <button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;white-space:nowrap;" onclick="anlAddNote('${c.id}')">+ Add note</button>
      </div>
    </div>`;
  }
  return body + add;
}

// ── Config object ────────────────────────────────────────────────────────────
export const annulmentConfig = {
  panelKey: 'annulments',
  title: 'Annulment Cases',
  newLabel: '+ Add Case',

  // Group by STATUS; the archived boolean routes to a single bottom group.
  groupBy: (c) => c.archived ? '__archived' : (c.status_code || 'prep'),
  groupLabel: (k) => GROUP_LABEL[k] || k,
  groupCompare: (a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b),

  canManage: () => anlCanManage(),
  openCreate: () => window.openCaseCreate?.(),
  // Settings gear → per-type document templates (coordinator-gated, like Marriage).
  canManageTemplate: () => isSacramentCoordinator('annulments'),
  openTemplate: () => window.openTemplateSettings?.(),

  fetchRecords: async () => getCaseRecords(),
  fetchRecord: (id) => getCaseRecord(id),
  searchText: (c) => `${petName(c)} ${respName(c)}`,
  // Alphabetical by title within each status group (the shell sorts visibleRecords
  // by this before grouping).
  compare: (a, b) => caseTitle(a).toLowerCase().localeCompare(caseTitle(b).toLowerCase()),

  statusFilters: [
    { key: 'all',       label: 'All',         match: () => true },
    { key: 'prep',      label: 'Preparing',   match: c => c.status_code === 'prep' && !c.archived },
    { key: 'tribunal',  label: 'In Tribunal', match: c => c.status_code === 'tribunal' && !c.archived },
    { key: 'affirm',    label: 'Affirmative', match: c => c.status_code === 'affirm' && !c.archived },
    { key: 'negative',  label: 'Negative',    match: c => c.status_code === 'negative' && !c.archived },
    { key: 'inactive',  label: 'Inactive',    match: c => c.status_code === 'archived' && !c.archived },
    { key: 'archived',  label: 'Archived',    match: c => !!c.archived },
  ],

  listItem: (c) => ({
    title: caseTitle(c),
    secondary: advocateName(c) ? `Advocate: ${advocateName(c)}` : '',
    chips: [typeChip(c), statusChip(c), docsCompleteChip(c)].filter(Boolean),
    flags: [],
  }),

  detailHeader: (c) => ({
    avatarIcon: 'fa-scale-balanced',   // scales of justice (a case has two parties)
    name: viewerTitle(c),
    chips: [typeChip(c), statusChip(c), docsCompleteChip(c)].filter(Boolean),
    flags: [],
  }),

  detailSections: [
    { title: 'Case details', render: caseDetails },
    { title: 'Documents',    render: documents },
    { title: 'Timeline',     render: timeline },
    { title: 'Notes',        render: notes },
  ],

  // Phase 2: inline type-driven edit form rendered into the shell's detail pane;
  // the shell supplies Save / Cancel / Delete. Save + delete route through the
  // write-retry wrapper inside panels/annulments.js.
  editForm: (c) => buildAnlEditForm(c),
  saveRecord: (id) => anlSaveEdit(id),
  deleteRecord: (id) => anlDeleteRec(id),
};
