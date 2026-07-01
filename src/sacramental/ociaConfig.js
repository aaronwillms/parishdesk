// ── OCIA config for the sacramental master-detail shell ─────────────────────
// Subject is one PERSON ("Person Files"). Two-level grouping (Confirmation path):
// cohort (top) → candidate_type (sub: Catechumens / Candidates). Inline type-driven
// edit form, viewer notes-add (notes_log) + per-note hover-X, minor parent/guardian
// permission (editable + lock-gate, read-only once granted) + card chip + Priority
// Actions, fa-dove avatar. NO timeline (OCIA carries none). Reuses panels/ocia.js.
//
// status_code: inquirer | preparation | complete | received | inactive
// (default 'inquirer'). The `archived` boolean is independent of status and pulls a
// record into the bottom "Archived" group.

import { formatDateDisplay, fmtDate, docCheckStampHtml } from '../utils.js';
import { formatPhone } from '../utils/phone.js';
import { isSacramentCoordinator } from '../roles.js';
import {
  getOciaRecords, getOciaRecord, ociaCanManage, OCIA_STATUS,
  ociaName, ociaLastName, ociaStatusOf, candTypeOf, ociaAge, ociaNotesOf, ociaIsMinor, ociaNeedsAnnulment,
  pmHowEnded, pmDisplayName,
  cohortKeyOf, ociaCohortName, ociaCohortDateOf,
  buildOciaEditForm, ociaSaveEdit, ociaDeleteRec, ociaDocsOf,
} from '../panels/ocia.js';
import { chipHtml } from './panelShell.js';
import { noteEditedMarker } from './noteEdit.js';
import { registerLinkPanel, linkSectionHtml } from './recordLinks.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

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
// Sort: status (Inquirer → In Preparation → Preparation Complete → Received → Inactive)
// → preparer name → last name. (OCIA's own status set — unchanged.)
const STATUS_ORDER = ['inquirer', 'preparation', 'complete', 'received', 'inactive'];
const statusRank = (p) => { const i = STATUS_ORDER.indexOf(ociaStatusOf(p)); return i < 0 ? 999 : i; };
const prepKey = (p) => (p?.preparer || '').trim().toLowerCase() || '￿';   // no-preparer sorts last

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
  // Candidate baptism location (+ country only alongside a real location).
  const bap = [p.baptism_church, p.baptism_city, p.baptism_state].filter(Boolean);
  if (bap.length && p.baptism_country) bap.push(p.baptism_country);
  // Prior marriages — spouse name + how-it-ended (DERIVED at read time when a case
  // is linked, via pmHowEnded) + annulment link/needed.
  const prior = (p.prior_marriages || []).filter(m => m && (pmDisplayName(m) || m.annulment_case_id || m.how_ended)).map(m => {
    const he = pmHowEnded(m);
    const annul = m.annulment_case_id ? ' · annulment linked' : (he === 'Civil Divorce Only' ? ' · annulment needed' : '');
    return `<div>${esc(pmDisplayName(m) || 'Prior spouse')}${he ? ` — ${esc(he)}` : ''}${annul}</div>`;
  }).join('');
  return [
    row('Candidate type', candTypeOf(p) === 'candidate' ? 'Candidate' : 'Catechumen'),
    row('Status', esc((OCIA_STATUS[ociaStatusOf(p)] || OCIA_STATUS.inquirer).label)),
    row('Cohort', ck ? esc(ociaCohortName(ck)) : ''),
    row('Date of birth', p.dob ? `${esc(formatDateDisplay(p.dob))}${age !== null ? ` (age ${age})` : ''}` : ''),
    row('Place of birth', p.place_of_birth ? esc(p.place_of_birth) : ''),
    row('Contact', contact),
    row('Sponsor', (p.sponsor_name || p.sponsor1) ? esc(p.sponsor_name || p.sponsor1) : ''),
    row('Baptism', bap.length ? bap.map(esc).join(', ') + (p.baptism_by_affidavit ? ' (By Affidavit)' : '') : (p.baptism_by_affidavit ? '(By Affidavit)' : '')),
    row('Date of Baptism', p.baptism_date ? esc(formatDateDisplay(p.baptism_date)) : ''),
    row('Prior marriages', prior),
    row('OCIA Prep', p.preparer ? esc(p.preparer) : ''),
    row('Reception', receptionLine(p)),
  ].filter(Boolean).join('') || '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No details yet.</div>';
}
// Notes (notes_log) — list with a per-note hover-X delete (shared sac-tl-* pattern)
// plus an "Add Note" input. Writes route through the retry wrapper.
function notes(p) {
  const canManage = ociaCanManage();
  const list = ociaNotesOf(p);
  const body = list.length
    ? `<div class="sac-tl">${list.map((n, i) => `<div class="sac-tl-entry">
        <div class="sac-tl-row"><span class="sac-tl-text" style="white-space:pre-wrap;">${esc(n.note)}</span>${canManage ? `${!n.legacy ? `<button class="sac-tl-x" title="Edit" onclick="ociaEditNote('${p.id}',${i})" style="font-size:12px;">✎</button>` : ''}<button class="sac-tl-x" title="Delete" onclick="ociaDeleteNote('${p.id}',${i})">×</button>` : ''}</div>
        ${(n.by || n.created_at || n.edited_at) ? `<div class="sac-tl-time">${n.created_at ? esc(fmtDate(String(n.created_at).slice(0, 10))) : ''}${n.by ? ' · ' + esc(n.by) : ''}${noteEditedMarker(n.edited_at)}</div>` : ''}
      </div>`).join('')}</div>`
    : '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No notes yet.</div>';
  let add = '';
  if (canManage) {
    add = `<div class="sac-add-block">
      <div class="sac-add-head">Add Note</div>
      <div style="display:flex;gap:6px;align-items:center;">
        <input type="text" id="ocia-note-input-${p.id}" placeholder="Write a note…" onkeydown="if(event.key==='Enter'){event.preventDefault();ociaAddNote('${p.id}');}" style="flex:1;box-sizing:border-box;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;" />
        <button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;white-space:nowrap;" onclick="ociaAddNote('${p.id}')">+ Add note</button>
      </div>
    </div>`;
  }
  return body + add;
}
// Minor parent/guardian permission. NOT granted → editable inline (name + date) with
// a lock-gated "Permission Granted" checkbox (disabled until both filled; forward-
// only). GRANTED → read-only display. Reuses the baptism-doc lock-gate structure.
const PERM_LOCK_TIP = 'Enter the parent/guardian name and the date before marking permission granted.';
function minorPermission(p) {
  const canManage = ociaCanManage();
  if (p.parental_consent) {
    const name = p.minor_guardian_name || p.consent_parent_name || '';
    const date = p.minor_permission_date || p.consent_date || '';
    return `<div style="font-size:13px;color:#2D6A4F;font-weight:600;margin-bottom:4px;">✅ Parent/Guardian Permission Granted</div>
      ${row('Parent / Guardian', name ? esc(name) : '')}
      ${row('Date granted', date ? esc(formatDateDisplay(date)) : '')}`;
  }
  const filled = String(p.minor_guardian_name || '').trim() && String(p.minor_permission_date || '').trim();
  if (!canManage) return '<div style="font-size:13px;color:#9A6A1E;font-style:italic;">Parent/guardian permission not yet granted.</div>';
  const inS = `border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.3rem .5rem;font-size:12px;font-family:'Inter',sans-serif;background:#fff;box-sizing:border-box;`;
  return `<div style="display:flex;gap:5px;flex-wrap:wrap;">
      <input type="text" id="ocia-perm-name-${p.id}" value="${esc(p.minor_guardian_name || '')}" placeholder="Parent/Guardian name" onchange="ociaSavePermField('${p.id}','name',this)" style="${inS}flex:2;min-width:0;" />
      <input type="date" id="ocia-perm-date-${p.id}" value="${esc((p.minor_permission_date || '').slice(0, 10))}" onchange="ociaSavePermField('${p.id}','date',this)" style="${inS}flex:1;min-width:0;" />
    </div>
    <label style="display:inline-flex;align-items:center;gap:8px;margin-top:8px;font-size:13px;cursor:${filled ? 'pointer' : 'not-allowed'};color:var(--navy);">
      <input type="checkbox" id="ocia-perm-box-${p.id}" ${filled ? '' : 'disabled'} onchange="ociaTogglePermission('${p.id}',this.checked)" ${filled ? '' : `title="${esc(PERM_LOCK_TIP)}"`} style="width:15px;height:15px;accent-color:var(--cardinal);${filled ? '' : 'opacity:.45;cursor:not-allowed;'}" />
      Parent/Guardian Permission Granted
    </label>
    <div id="ocia-perm-note-${p.id}" style="display:${filled ? 'none' : 'block'};font-size:11px;color:#9A6A1E;margin-top:5px;"><i class="fa-solid fa-circle-info" style="margin-right:4px;"></i>${esc(PERM_LOCK_TIP)}</div>`;
}

// Viewer document checklist — the FULL per-type list (checked + unchecked), each
// toggleable, MM/DD/YYYY date-stamped on check. Mirrors the other sacramental panels
// (Confirmation's documents()). OCIA's checklist lives on the record's `documents`
// (seeded from ocia_templates at creation); ociaToggleDoc persists each flip.
function documents(p) {
  const docs = ociaDocsOf(p), done = docs.filter(d => d.received).length;
  const progress = docs.length ? Math.round((done / docs.length) * 100) : null;
  let h = '';
  if (docs.length) {
    if (progress !== null) h += `<div class="prog-bar-wrap"><div class="prog-bar-fill" style="width:${progress}%;background:${progress === 100 ? '#2D6A4F' : 'var(--gold)'};"></div></div><div style="font-size:11px;color:#888;margin-bottom:6px;">${done}/${docs.length} received</div>`;
    h += docs.map((d, i) => `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;">
      <span style="font-size:15px;cursor:pointer;" onclick="ociaToggleDoc('${p.id}',${i})">${d.received ? '✅' : '⬜'}</span>
      <span style="flex:1;cursor:pointer;color:${d.received ? '#2D6A4F' : 'var(--navy)'};" onclick="ociaToggleDoc('${p.id}',${i})">${esc(d.name)}</span>
      ${docCheckStampHtml(d)}
      ${d.deletable === false ? `<i class="fa-solid fa-lock" style="color:#C9C2B6;font-size:11px;margin-left:8px;" title="Required"></i>` : ''}
    </div>`).join('');
  } else { h += `<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No documents.</div>`; }
  return h;
}

// ── Config object ───────────────────────────────────────────────────────────
// Card flag chip — a minor lacking parent/guardian permission needs attention.
function permissionChip(p) {
  return (ociaIsMinor(p) && !p.parental_consent)
    ? { label: 'Parent/Guardian Permission Needed', tone: 'pending', style: 'background:#FEF9E7;color:#7D6608;' }
    : null;
}
// Card flag chip — a prior marriage is Civil-Divorce-Only with no annulment linked.
// Same attention/pending tone + mechanism as permissionChip; clears once an annulment
// is linked to the prior marriage (ociaNeedsAnnulment).
function annulmentChip(p) {
  return ociaNeedsAnnulment(p)
    ? { label: 'Annulment Needed', tone: 'pending', style: 'background:#FEF9E7;color:#7D6608;' }
    : null;
}

// Cross-panel link adapter (mechanism B): OCIA links to Marriage + Annulment (never
// OCIA↔OCIA). Reused by the shared recordLinks module for search/list/chips/open.
registerLinkPanel('ocia', {
  label: 'OCIA',
  canManage: () => ociaCanManage(),
  recordTitle: (p) => ociaName(p),
  chipsHtml: (p) => chipHtml(statusChip(p)) + chipHtml(typeChip(p)),
  openCall: (id) => `window.expandOcia('${id}')`,
  searchTable: 'sacramental_ocia',
  searchCols: 'id, name',
  searchFilter: (safe) => `name.ilike.%${safe}%`,
  searchTitle: (r) => r.name || 'OCIA record',
  displayCols: 'id, name, status_code, candidate_type, baptismal_status',
});
function linkedRecords(p) { return linkSectionHtml('ocia', p.id); }

export const ociaConfig = {
  panelKey: 'ocia',
  pinRecordType: 'ocia',
  sacramentKeys: ['ocia'],   // parish switcher: access keys that gate visible parishes
  title: 'Person Files',
  newLabel: '+ Add Person',
  cohortIcon: 'fa-people-group',

  // Two-level grouping: cohort (top) → candidate_type (sub). Reuses the shell's
  // Confirmation path (groupBy/subGroupBy). Uncohorted records fall to "No Cohort";
  // archived records route to a single bottom "Archived" group (shell sinks it last
  // and defaults it collapsed), independent of status.
  groupBy: (p) => p.archived ? '__archived' : cohortKeyOf(p),
  groupLabel: (key) => key === '__archived' ? 'Archived' : ociaCohortName(key),
  groupCompare: (a, b) => (ociaCohortDateOf(a) || '').localeCompare(ociaCohortDateOf(b) || ''),   // soonest reception date first
  noneLabel: 'No Cohort',
  subGroupBy: (p) => candTypeOf(p) === 'candidate' ? 'candidate' : 'catechumen',
  subGroupOrder: ['catechumen', 'candidate'],
  subGroupLabel: (sk) => sk === 'candidate' ? 'Candidates' : 'Catechumens',

  canManage: () => ociaCanManage(),
  canManageTemplate: () => isSacramentCoordinator('ocia'),
  openTemplate: () => window.openOciaTemplates?.(),
  openManageCohorts: () => window.openCohortManager?.('ocia'),   // shared cohort manager
  openCreate: () => window.openOciaCreate?.(),

  fetchRecords: async () => getOciaRecords(),
  fetchRecord: (id) => getOciaRecord(id),
  searchText: (p) => ociaName(p),
  // Within each cohort/sub-group: status → preparer name → last name.
  compare: (a, b) => statusRank(a) - statusRank(b)
    || prepKey(a).localeCompare(prepKey(b))
    || ociaLastName(a).toLowerCase().localeCompare(ociaLastName(b).toLowerCase()),

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
    secondary: [p.preparer ? `Prep: ${p.preparer}` : '', receptionLine(p) ? `🕊 ${receptionLine(p)}` : ''].filter(Boolean).join(' · '),
    chips: [statusChip(p), typeChip(p), permissionChip(p), annulmentChip(p)].filter(Boolean),
    flags: [],
  }),

  detailHeader: (p) => {
    const ck = cohortKeyOf(p);
    const chips = [statusChip(p), typeChip(p)];
    if (ck) chips.push({ label: ociaCohortName(ck), tone: 'neutral' });
    return { avatarIcon: 'fa-dove', name: ociaName(p), chips, flags: [] };   // gold dove on navy
  },

  detailSections: [
    { title: 'Candidate details',            render: personDetails },
    { title: 'Documents',                    render: documents },
    { title: 'Parent/Guardian Permission',   render: minorPermission, when: (p) => ociaIsMinor(p) },
    { title: 'Linked Records',               render: linkedRecords },
    { title: 'Notes',                        render: notes },
  ],

  // Phase 2: inline type-driven edit form (Catechumen/Candidate) rendered into the
  // shell detail pane; the shell supplies Save / Cancel / Delete.
  editForm: (p) => buildOciaEditForm(p),
  saveRecord: (id) => ociaSaveEdit(id),
  deleteRecord: (id) => ociaDeleteRec(id),
};
