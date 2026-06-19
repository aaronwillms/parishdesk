// ── OCIA config for the sacramental master-detail shell — PHASE 1 ───────────
// Subject is one PERSON. Two-level grouping (reusing Confirmation's path): cohort
// (top) → candidate_type (sub: Catechumens / Candidates). Phase 1 is read-first:
// shell mount, grouping + bottom archive, type+status chips, read-only detail. The
// type-driven editable FORM, baptism-document pattern, family-linking, timeline
// editing, templates, minor consent, and reception details are PHASE 2. Reuses the
// data/helpers from panels/ocia.js — nothing reimplemented here.
//
// status_code: inquirer | preparation | complete | received | inactive
// (default 'inquirer'). The `archived` boolean is independent of status and pulls a
// record into the bottom "Archived" group.

import { formatDateDisplay, fmtDate } from '../utils.js';
import { formatPhone } from '../utils/phone.js';
import { isSacramentCoordinator } from '../roles.js';
import {
  getOciaRecords, getOciaRecord, ociaCanManage, OCIA_STATUS,
  ociaName, ociaLastName, ociaStatusOf, candTypeOf, ociaAge, ociaNotesOf,
  cohortKeyOf, ociaCohortName, ociaCohortDateOf,
  buildOciaEditForm, ociaSaveEdit, ociaDeleteRec,
} from '../panels/ocia.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

// ── Chips ────────────────────────────────────────────────────────────────────
// TYPE chip: grey type-chip styling. STATUS chip per the OCIA palette —
// Inquirer purple · In Preparation yellow · Preparation Complete BLUE · Received
// GREEN · Inactive grey. Dark mode slates all badges via the shared !important rule.
function typeChip(p) { return { label: candTypeOf(p) === 'candidate' ? 'Candidate' : 'Catechumen', tone: 'neutral' }; }
const STATUS_CHIP_STYLE = {
  inquirer:    'background:#EDE9FE;color:#4A1D96;',  // purple
  preparation: 'background:#FEF9E7;color:#7D6608;',  // yellow
  complete:    'background:#D6EAF8;color:#1B4F72;',  // blue
  received:    'background:#D8F3DC;color:#2D6A4F;',  // green
  inactive:    'background:#F2F3F4;color:#616A6B;',  // grey
};
function statusChip(p) {
  const code = ociaStatusOf(p);
  return { label: (OCIA_STATUS[code] || OCIA_STATUS.inquirer).label, tone: 'neutral', style: STATUS_CHIP_STYLE[code] || STATUS_CHIP_STYLE.inquirer };
}

// ── Read-detail section renderers (Phase 1 — read-only) ─────────────────────
function row(label, val) {
  return val ? `<div style="display:flex;gap:10px;font-size:13px;padding:3px 0;"><span style="color:#6B7280;min-width:130px;">${esc(label)}</span><span style="flex:1;color:var(--navy);">${val}</span></div>` : '';
}
function receptionLine(p) {
  if (!p.reception_date) return '';
  const easter = p.reception_is_easter_vigil !== false;
  const yr = new Date(p.reception_date + 'T00:00:00').getFullYear();
  const when = easter ? `Easter Vigil ${yr}` : formatDateDisplay(p.reception_date);
  return `${esc(when)}${p.reception_church ? ' · ' + esc(p.reception_church) : ''}`;
}
function personDetails(p) {
  const ck = cohortKeyOf(p);
  const age = ociaAge(p.dob);
  const contact = [p.phone ? esc(formatPhone(p.phone)) : '', p.email ? esc(p.email) : ''].filter(Boolean).join(' · ');
  return [
    row('Candidate type', candTypeOf(p) === 'candidate' ? 'Candidate' : 'Catechumen'),
    row('Status', esc((OCIA_STATUS[ociaStatusOf(p)] || OCIA_STATUS.inquirer).label)),
    row('Cohort', ck ? esc(ociaCohortName(ck)) : ''),
    row('Date of birth', p.dob ? `${esc(formatDateDisplay(p.dob))}${age !== null ? ` (age ${age})` : ''}` : ''),
    row('Place of birth', p.place_of_birth ? esc(p.place_of_birth) : ''),
    row('Contact', contact),
    row('Sponsor', (p.sponsor_name || p.sponsor1) ? esc(p.sponsor_name || p.sponsor1) : ''),
    row('Reception', receptionLine(p)),
  ].filter(Boolean).join('') || '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No details yet.</div>';
}
// Read-only notes (notes_log) — text with a small timestamp beneath.
function notes(p) {
  const list = ociaNotesOf(p);
  if (!list.length) return '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No notes yet.</div>';
  return list.map(n => `<div style="font-size:13px;color:#555;margin-bottom:6px;padding:8px 12px;background:#FFF8EE;border-left:3px solid var(--gold);border-radius:3px;">
    <div style="white-space:pre-wrap;">${esc(n.note)}</div>
    ${(n.by || n.created_at) ? `<div style="font-size:11px;color:#9CA3AF;margin-top:3px;">${n.created_at ? esc(fmtDate(String(n.created_at).slice(0, 10))) : ''}${n.by ? ' · ' + esc(n.by) : ''}</div>` : ''}
  </div>`).join('');
}
// Read-only timeline — event label with a small timestamp beneath.
function timeline(p) {
  const tl = Array.isArray(p.timeline) ? p.timeline : [];
  if (!tl.length) return '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No timeline entries yet.</div>';
  return tl.map(e => {
    const when = (e.created_at || e.date) ? fmtDate(String(e.created_at || e.date).slice(0, 10)) : '';
    return `<div style="padding:5px 0;border-bottom:.5px solid var(--stone);">
      <div style="font-size:13px;color:var(--navy);">${esc(e.text || e.event || '')}</div>
      ${when ? `<div style="font-size:11px;color:#9CA3AF;margin-top:2px;">${when}</div>` : ''}
    </div>`;
  }).join('');
}

// ── Config object ───────────────────────────────────────────────────────────
export const ociaConfig = {
  panelKey: 'ocia',
  title: 'OCIA',
  newLabel: '+ Add Candidate',

  // Two-level grouping: cohort (top) → candidate_type (sub). Reuses the shell's
  // Confirmation path (groupBy/subGroupBy). Uncohorted records fall to "No Cohort";
  // archived records route to a single bottom "Archived" group (shell sinks it last
  // and defaults it collapsed), independent of status.
  groupBy: (p) => p.archived ? '__archived' : cohortKeyOf(p),
  groupLabel: (key) => key === '__archived' ? 'Archived' : ociaCohortName(key),
  groupCompare: (a, b) => (ociaCohortDateOf(b) || '').localeCompare(ociaCohortDateOf(a) || ''),
  noneLabel: 'No Cohort',
  subGroupBy: (p) => candTypeOf(p) === 'candidate' ? 'candidate' : 'catechumen',
  subGroupOrder: ['catechumen', 'candidate'],
  subGroupLabel: (sk) => sk === 'candidate' ? 'Candidates' : 'Catechumens',

  canManage: () => ociaCanManage(),
  canManageTemplate: () => isSacramentCoordinator('ocia'),
  openTemplate: () => window.openOciaTemplates?.(),
  openCreate: () => window.openOciaCreate?.(),

  fetchRecords: async () => getOciaRecords(),
  fetchRecord: (id) => getOciaRecord(id),
  searchText: (p) => ociaName(p),
  compare: (a, b) => ociaLastName(a).toLowerCase().localeCompare(ociaLastName(b).toLowerCase()),

  statusFilters: [
    { key: 'all',         label: 'All',                  match: () => true },
    { key: 'inquirer',    label: 'Inquirer',             match: p => ociaStatusOf(p) === 'inquirer' && !p.archived },
    { key: 'preparation', label: 'In Preparation',       match: p => ociaStatusOf(p) === 'preparation' && !p.archived },
    { key: 'complete',    label: 'Preparation Complete', match: p => ociaStatusOf(p) === 'complete' && !p.archived },
    { key: 'received',    label: 'Received',             match: p => ociaStatusOf(p) === 'received' && !p.archived },
    { key: 'inactive',    label: 'Inactive',             match: p => ociaStatusOf(p) === 'inactive' || p.archived },
  ],

  listItem: (p) => ({
    title: ociaName(p) + (ociaAge(p.dob) !== null ? ` (${ociaAge(p.dob)})` : ''),
    secondary: receptionLine(p) ? `🕊 ${receptionLine(p)}` : '',
    chips: [statusChip(p), typeChip(p)],
    flags: [],
  }),

  detailHeader: (p) => {
    const ck = cohortKeyOf(p);
    const chips = [statusChip(p), typeChip(p)];
    if (ck) chips.push({ label: ociaCohortName(ck), tone: 'neutral' });
    return { initials: initialsOf(ociaName(p)), name: ociaName(p), chips, flags: [] };
  },

  detailSections: [
    { title: 'Candidate details', render: personDetails },
    { title: 'Notes',             render: notes },
    { title: 'Timeline',          render: timeline },
  ],

  // Phase 2: inline type-driven edit form (Catechumen/Candidate) rendered into the
  // shell detail pane; the shell supplies Save / Cancel / Delete.
  editForm: (p) => buildOciaEditForm(p),
  saveRecord: (id) => ociaSaveEdit(id),
  deleteRecord: (id) => ociaDeleteRec(id),
};
