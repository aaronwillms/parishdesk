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
  buildAnlEditForm, anlSaveEdit, anlDeleteRec, TIMELINE_EVENTS,
} from '../panels/annulments.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Group keys: the five status_code values + '__archived' (the archived boolean
// section, always last). archived overrides status placement.
const GROUP_ORDER = ['prep', 'tribunal', 'affirm', 'negative', 'archived', '__archived'];
const GROUP_LABEL = { prep: 'Preparing', tribunal: 'In Tribunal', affirm: 'Affirmative Judgement', negative: 'Negative Judgement', archived: 'Inactive', __archived: 'Archived' };

function isFinalized(c) { return c.judgement_finalized === 'yes' || c.judgement_finalized === true; }
// "Last vs Last" with maiden overriding the last name; graceful degrade to "—".
function caseTitle(c) { return `${petLast(c) || '—'} vs ${respLast(c) || '—'}`; }

// ── Chips ────────────────────────────────────────────────────────────────────
// All colors are REUSED from the existing CASE_STATUS palette / the existing
// briefer chip — no new hex introduced. Dark mode slates badge bg/color via the
// shared !important rule (consistent with every badge); the pending dashed border
// (its own color) survives, keeping pending visually distinct in both themes.
function typeChip(c) {
  // Briefer Process OVERRIDES the type chip entirely, with a distinct gold tone.
  if (c.briefer_process) return { label: 'Briefer Process', tone: 'pending', style: 'background:#FBF1D3;color:#7A5C00;border:1px solid #C9A84C;' };
  return { label: TYPE_BADGE[caseType(c)] || 'Type', tone: 'neutral' };
}
function statusChip(c) {
  const code = c.status_code || 'prep';
  const sm = CASE_STATUS[code] || CASE_STATUS.prep;
  if (code === 'affirm' || code === 'negative') {
    const base = code === 'affirm' ? 'Affirmative' : 'Negative';
    return isFinalized(c)
      ? { label: base, tone: 'neutral', style: `background:${sm.bg};color:${sm.color};` }
      : { label: `${base} · Pending`, tone: 'neutral', style: `background:${sm.bg};color:${sm.color};border:1px dashed ${sm.color};` };
  }
  return { label: sm.label, tone: 'neutral', style: `background:${sm.bg};color:${sm.color};` };
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
    row('Petitioner v. Respondent', `${esc(petName(c))}${respName(c) ? ` v. ${esc(respName(c))}` : ''}`),
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
// Checklist driven by the case's type template; checkboxes are viewer-editable and
// route through the write-retry wrapper (toggleCaseDoc).
function documents(c) {
  const canManage = anlCanManage();
  const docs = caseDocs(c);
  if (!docs.length) return '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No documents.</div>';
  return docs.map((d, i) => `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px;">
    <span style="font-size:15px;${canManage ? 'cursor:pointer;' : ''}" ${canManage ? `onclick="toggleCaseDoc('${c.id}',${i})"` : ''}>${d.received ? '✅' : '⬜'}</span>
    <span style="flex:1;${canManage ? 'cursor:pointer;' : ''}color:${d.received ? '#2D6A4F' : 'var(--navy)'};" ${canManage ? `onclick="toggleCaseDoc('${c.id}',${i})"` : ''}>${esc(d.name)}</span>
    ${d.deletable === false ? `<i class="fa-solid fa-lock" style="color:#C9C2B6;font-size:11px;" title="Required"></i>` : ''}
  </div>`).join('');
}
// Full timeline. Entries render label + small timestamp beneath, with a faint X on
// hover for manual deletion (any entry, incl. auto milestones). Below the list, an
// add-control: a dropdown of preseeded procedural events + "Other…" free-text, and
// an editable date picker (prefilled today; an earlier date backdates the entry).
// Writes route through anlAddTimelineEntry / anlDeleteTimelineEntry (write-retry).
function timeline(c) {
  const canManage = anlCanManage();
  const raw = Array.isArray(c.timeline) ? c.timeline : [];
  const iconFor = (e) => e.type === 'auto' ? '⚙️' : e.type === 'progress' ? '📋' : '📝';
  let body = raw.map((e, i) => {
    const text = e.text || e.event || '';
    const when = (e.created_at || e.date) ? fmtDate(String(e.created_at || e.date).slice(0, 10)) : '';
    return `<div class="anl-tl-entry">
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;color:var(--navy);">${iconFor(e)} ${esc(text)}</div>
        ${when ? `<div style="font-size:11px;color:#9CA3AF;margin-top:2px;">${when}</div>` : ''}
      </div>
      ${canManage ? `<button class="anl-tl-x" title="Delete entry" onclick="anlDeleteTimelineEntry('${c.id}',${i})">×</button>` : ''}
    </div>`;
  }).join('');
  // Legacy single-notes field → a non-deletable trailing display line.
  if (c.notes && c.notes.trim()) {
    body += `<div class="anl-tl-entry"><div style="flex:1;min-width:0;"><div style="font-size:13px;color:var(--navy);">📝 ${esc(c.notes.trim())}</div></div></div>`;
  }
  if (!body) body = '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No timeline entries yet.</div>';

  let add = '';
  if (canManage) {
    const opts = TIMELINE_EVENTS.map(ev => `<option value="${esc(ev)}">${esc(ev)}</option>`).join('');
    add = `<div style="margin-top:10px;border-top:.5px solid var(--stone);padding-top:10px;">
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
    name: caseTitle(c),
    chips: [typeChip(c), statusChip(c), docsCompleteChip(c)].filter(Boolean),
    flags: [],
  }),

  detailSections: [
    { title: 'Case details', render: caseDetails },
    { title: 'Documents',    render: documents },
    { title: 'Timeline',     render: timeline },
  ],

  // Phase 2: inline type-driven edit form rendered into the shell's detail pane;
  // the shell supplies Save / Cancel / Delete. Save + delete route through the
  // write-retry wrapper inside panels/annulments.js.
  editForm: (c) => buildAnlEditForm(c),
  saveRecord: (id) => anlSaveEdit(id),
  deleteRecord: (id) => anlDeleteRec(id),
};
