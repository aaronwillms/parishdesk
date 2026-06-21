// ── Marriage config for the sacramental master-detail shell ─────────────────
// First COUPLE-KEYED panel (subject is a couple, not one person) and the first
// to use the shared OFFICIANT dropdown. Flat list sorted by wedding date,
// upcoming-first. Reuses the existing Marriage queries / four-type / status /
// edit-form / save logic from panels/marriage.js — nothing reimplemented here.

import { fmtDate, formatDateDisplay, docCheckStampHtml } from '../utils.js';
import { noteEditedMarker } from './noteEdit.js';
import { formatPhone } from '../utils/phone.js';
import { store } from '../store.js';
import { isSacramentCoordinator } from '../roles.js';
import {
  getCouples, getCouple, marCanManage, COUPLE_STATUS, MTYPE_BADGE,
  marTypeReal, isVisitingOfficiant, coupleLabel, s1Name, s2Name, normDocs, normSteps, normFees, notesOf,
  feeTotals, weddingDateOf, officiantOf, preparerOf, weddingLocation,
  buildMarEditForm, marSaveEdit, marDeleteRec, marBulkStatus,
} from '../panels/marriage.js';
import { chipHtml } from './panelShell.js';
import { registerLinkPanel, linkSectionHtml } from './recordLinks.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const STATUS_TONE = { inprogress: 'active', complete: 'complete', external: 'neutral', inactive: 'neutral' };
// Explicit per-status chip colors (light mode): In Progress = yellow, Complete =
// green, External = blue, Archived/Inactive = grey. Dark mode's !important badge
// rule overrides these to slate, consistent with every other badge.
const STATUS_STYLE = {
  inprogress: 'background:#FEF9E7;color:#7D6608;',  // yellow
  complete:   'background:#D8F3DC;color:#2D6A4F;',  // green
  external:   'background:#D6EAF8;color:#1B4F72;',  // blue
  inactive:   'background:#F2F3F4;color:#616A6B;',  // grey (archived/inactive)
};
// Status-slot chip. External (is_external boolean) substitutes for the In Progress
// chip ONLY — any terminal status wins and the External chip is not shown:
//   is_external && inprogress → External · is_external && complete/inactive → that
//   status · archived → Inactive · is_external false → the real status.
function statusKey(c) {
  if (c.archived) return 'inactive';
  let s = c.status_code || 'inprogress';
  if (s === 'external') s = 'inprogress';            // legacy: 'external' was never a real status
  if (c.is_external && s === 'inprogress') return 'external';
  return s;
}
function statusChip(c) { const k = statusKey(c); return { label: (COUPLE_STATUS[k] || {}).label || k, tone: STATUS_TONE[k] || 'neutral', style: STATUS_STYLE[k] }; }
// The TYPE chip shows the real ceremony type (Nuptial Mass / Outside Mass /
// Convalidation / Sanatio), never "External" — the first chip owns the external
// badge. marTypeReal() drops marType()'s external short-circuit.
function typeChip(c) { return { label: MTYPE_BADGE[marTypeReal(c)] || 'Marriage', tone: 'neutral' }; }

// Derived card chips (READ-ONLY — they never write). Same green/yellow as the
// status palette; dark mode's !important badge rule slates them like every badge.
const CHIP_GREEN = 'background:#D8F3DC;color:#2D6A4F;';
const CHIP_YELLOW = 'background:#FEF9E7;color:#7D6608;';
const fmtMoney = (n) => (n % 1 === 0 ? String(n) : n.toFixed(2));
// Green "Documents Complete" when every document on the file is checked (and there
// is at least one). External files have no documents, so it never shows for them.
function docsCompleteChip(c) {
  const docs = normDocs(c);
  if (!docs.length || !docs.every(d => d.received)) return null;
  return { label: 'Documents Complete', tone: 'complete', style: CHIP_GREEN };
}
// Fee chip derived from feeTotals(c) (Σ amount / Σ paid; balance = total − paid):
//   • no fee set (no fees OR total ≤ 0) → NEITHER chip
//   • balance ≤ 0 (fully paid)          → green "Paid"
//   • balance > 0 (unpaid/partial)      → yellow "Unpaid $<remaining balance>"
// Mutually exclusive — only one ever returns.
function feeChip(c) {
  const ft = feeTotals(c);
  if (!ft || ft.total <= 0) return null;
  const balance = ft.total - ft.paid;
  return balance <= 0
    ? { label: 'Paid', tone: 'complete', style: CHIP_GREEN }
    : { label: `Unpaid $${fmtMoney(balance)}`, tone: 'pending', style: CHIP_YELLOW };
}
function ini(name) { const p = String(name || '').trim().split(/\s+/).filter(Boolean); return ((p[0]?.[0] || '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase(); }
function coupleInitials(c) { const a = ini(s1Name(c)) || '?', b = ini(s2Name(c)) || '?'; return `${a}·${b}`; }

// ── Read-detail section renderers ───────────────────────────────────────────
function row(label, val) {
  return val ? `<div style="display:flex;gap:10px;font-size:13px;padding:3px 0;"><span style="color:#6B7280;min-width:120px;">${esc(label)}</span><span style="flex:1;color:var(--navy);">${val}</span></div>` : '';
}
// Officiant cell — the name, plus an inline VIEWER-EDITABLE delegation checkbox
// when a visiting/external officiant is set (non-removable; check/uncheck only).
// The checkbox routes through the retry-wrapped toggleCoupleDelegation save path.
function officiantCell(c) {
  const name = officiantOf(c) ? esc(officiantOf(c)) : '';
  if (!isVisitingOfficiant(c)) return name;
  const on = !!c.delegation_given;
  return `${name}<span onclick="toggleCoupleDelegation('${c.id}')" style="display:inline-flex;align-items:center;gap:5px;margin-left:10px;cursor:pointer;vertical-align:middle;">
    <span style="font-size:14px;">${on ? '✅' : '⬜'}</span>
    <span style="font-size:12px;color:${on ? '#2D6A4F' : '#854F0B'};">${on ? 'Delegation given' : 'Delegation not given — send letter'}</span>
  </span>`;
}
// Completion chain (viewer-editable, non-removable, retry-wrapped): when status is
// Complete show "Wedding Complete"; once it's checked, the nested "Marriage File
// Placed in Parish Records" toggle appears beneath it.
function completionRows(c) {
  if (c.status_code !== 'complete') return '';
  const wc = !!c.wedding_complete;
  const chk = (on, label, handler, indent) => `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;${indent ? 'margin-left:1.5rem;' : ''}" onclick="${handler}('${c.id}')">
    <span style="font-size:15px;cursor:pointer;">${on ? '✅' : '⬜'}</span>
    <span style="flex:1;cursor:pointer;color:${on ? '#2D6A4F' : 'var(--navy)'};">${label}</span>
  </div>`;
  let h = chk(wc, 'Wedding Complete', 'toggleCoupleWeddingComplete', false);
  if (wc) h += chk(!!c.records_placed, 'Marriage File Placed in Parish Records', 'toggleCoupleRecordsPlaced', true);
  return h;
}
function priorList(prior) {
  return (prior || []).map(pm => {
    const ended = pm.how_ended || '';
    const annul = pm.annulment_case_id ? ' · annulment linked' : (ended === 'Annulment' ? ' · annulment needed' : '');
    return `<div>${esc(pm.spouse_name || 'Prior spouse')}${ended ? ` — ${esc(ended)}` : ''}${annul}</div>`;
  }).join('');
}
function spouseDetail(c, n) {
  const fullName = [c[`spouse${n}_first`], c[`spouse${n}_middle`], c[`spouse${n}_last`]].filter(Boolean).join(' ') || (n === 1 ? s1Name(c) : s2Name(c));
  const phone = n === 1 ? c.groom_phone : c.bride_phone;
  const email = n === 1 ? c.groom_email : c.bride_email;
  const dob = c[`spouse${n}_dob`];
  const unbap = c[`spouse${n}_unbaptized`], noncath = c[`spouse${n}_non_catholic`], inOcia = c[`spouse${n}_in_ocia`];
  const ociaId = c[`spouse${n}_ocia_id`];
  const ociaName = ociaId ? ((store.allOcia || []).find(x => x.id === ociaId)?.name || '') : '';
  const baptism = unbap ? '' : [c[`spouse${n}_baptism_church`], c[`spouse${n}_baptism_city`], c[`spouse${n}_baptism_state`]].filter(Boolean).map(esc).join(', ');
  const statusBits = [
    unbap ? 'Unbaptized' : null,
    (!unbap && noncath) ? 'Non-Catholic' : null,
    inOcia ? `In OCIA${ociaName ? ` (${esc(ociaName)})` : ''}` : null,
  ].filter(Boolean);
  const prior = c[`spouse${n}_prior_marriages`] || [];
  // External files hide the per-party PREP fields (DOB, baptism place, prior
  // marriages) in the viewer too, mirroring the form — so a field hidden at entry
  // isn't orphaned here. Name/contact/status still show.
  const ext = !!c.is_external;
  const out = [
    row('Name', fullName ? esc(fullName) : ''),
    (!ext && dob) ? row('Date of birth', esc(formatDateDisplay(dob))) : '',
    row('Phone', phone ? esc(formatPhone(phone)) : ''),
    row('Email', email ? esc(email) : ''),
    statusBits.length ? row('Status', statusBits.join(' · ')) : '',
    (!ext && baptism) ? row('Baptism', baptism) : '',
    (!ext && prior.length) ? row('Prior marriages', priorList(prior)) : '',
  ].filter(Boolean).join('');
  return out || '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No details.</div>';
}
function fileDetails(c) {
  const wd = weddingDateOf(c);
  const loc = weddingLocation(c);
  const dateLine = wd ? `${esc(formatDateDisplay(wd))}${c.wedding_time ? ' · ' + esc(c.wedding_time) : ''}` : '<span style="color:#9CA3AF;">Not set</span>';
  // Use the REAL ceremony type for type-conditional fields — marType() collapses
  // to 'external' for external files, which would hide the real type's fields.
  const type = marTypeReal(c);
  return [
    row('Type', esc(MTYPE_BADGE[type] || '') + (c.is_external ? ' · External' : '')),
    row('Civil marriage', c.civil_marriage_date ? esc(formatDateDisplay(c.civil_marriage_date)) : ''),
    type === 'sanatio' ? row('Faculty granted by', c.sanatio_faculty ? esc(c.sanatio_faculty) : '') : '',
    row('Wedding', dateLine),
    row('Location', loc.name ? esc(loc.name) : (c.non_church_wedding ? 'Non-church wedding' : '')),
    row('Address', loc.lines.length ? esc(loc.lines.join(', ')) : ''),
    row('Officiant', officiantCell(c)),                 // includes inline editable delegation toggle
    completionRows(c),                                  // Wedding Complete → records placed (Complete-only)
    row('Marriage Prep', preparerOf(c) ? esc(preparerOf(c)) : ''),
  ].filter(Boolean).join('') || '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No details yet.</div>';
}
// Documents + Steps — omitted entirely for external files (per the rule).
function documentsSteps(c) {
  const docs = normDocs(c), steps = normSteps(c);
  let h = '';
  if (docs.length) {
    h += `<div style="font-size:11px;color:#9CA3AF;text-transform:uppercase;letter-spacing:.05em;margin:2px 0 4px;">Documents</div>`;
    h += docs.map((d, i) => `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;">
      <span style="font-size:15px;cursor:pointer;" onclick="toggleCoupleDoc('${c.id}',${i})">${d.received ? '✅' : '⬜'}</span>
      <span style="flex:1;cursor:pointer;color:${d.received ? '#2D6A4F' : 'var(--navy)'};" onclick="toggleCoupleDoc('${c.id}',${i})">${esc(d.name)}</span>
      ${docCheckStampHtml(d)}
      ${!d.deletable ? `<i class="fa-solid fa-lock" style="color:#C9C2B6;font-size:11px;margin-left:8px;" title="Required"></i>` : ''}
    </div>`).join('');
  }
  if (steps.length) {
    h += `<div style="font-size:11px;color:#9CA3AF;text-transform:uppercase;letter-spacing:.05em;margin:10px 0 4px;">Steps of Preparation</div>`;
    h += steps.map((s, i) => `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;">
      <span style="font-size:15px;cursor:pointer;" onclick="toggleCoupleStep('${c.id}',${i})">${s.completed ? '✅' : '⬜'}</span>
      <span style="flex:1;cursor:pointer;color:${s.completed ? '#2D6A4F' : 'var(--navy)'};" onclick="toggleCoupleStep('${c.id}',${i})">${esc(s.step)}</span>
    </div>`).join('');
  }
  return h || '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">None.</div>';
}
// Fees — shown for ALL files INCLUDING external (external collects fees too;
// the old viewer hid them behind the "External — handled elsewhere" note).
function fees(c) {
  const list = normFees(c);
  if (!list.length) return '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No fees.</div>';
  const ft = feeTotals(c);
  return `<div style="font-size:11px;color:#9CA3AF;text-transform:uppercase;letter-spacing:.05em;margin:2px 0 4px;">$${ft.paid} paid / $${ft.total} total</div>`
    + list.map((f, i) => `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;">
      <span style="font-size:15px;cursor:pointer;" onclick="toggleCoupleFee('${c.id}',${i})">${f.paid ? '✅' : '⬜'}</span>
      <span style="flex:1;cursor:pointer;color:var(--navy);" onclick="toggleCoupleFee('${c.id}',${i})">${esc(f.name)}</span>
      <span style="font-size:12px;color:#5B4636;">$${Number(f.amount) || 0}</span>
    </div>`).join('');
}
function activity(c) {
  const notes = notesOf(c);
  const add = marCanManage() ? `<div style="display:flex;gap:6px;margin-bottom:8px;">
      <input type="text" id="cn-${c.id}" placeholder="Add a note…" onkeydown="if(event.key==='Enter'){event.preventDefault();addCoupleNoteLog('${c.id}');}"
        style="flex:1;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;outline:none;" />
      <button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="addCoupleNoteLog('${c.id}')">Add</button>
    </div>` : '';
  const list = notes.length
    ? notes.map((n, i) => `<div style="font-size:13px;color:#555;margin-bottom:6px;padding:8px 12px;background:#FFF8EE;border-left:3px solid var(--gold);border-radius:3px;"><div style="display:flex;gap:8px;align-items:flex-start;"><div style="white-space:pre-wrap;flex:1;">${esc(n.note)}</div>${marCanManage() && !n.legacy ? `<button title="Edit" onclick="coupleEditNoteLog('${c.id}',${i})" style="background:none;border:none;cursor:pointer;color:#C0A062;font-size:12px;line-height:1.2;padding:0;">✎</button>` : ''}</div>${(n.by || n.created_at || n.edited_at) ? `<div style="font-size:11px;color:#9CA3AF;margin-top:3px;">${n.created_at ? esc(fmtDate(String(n.created_at).slice(0, 10))) : ''}${n.by ? ' · ' + esc(n.by) : ''}${noteEditedMarker(n.edited_at)}</div>` : ''}</div>`).join('')
    : '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No notes yet.</div>';
  return add + list;
}

function emailCouple(c) {
  const to = [c.groom_email, c.bride_email].filter(Boolean).join(',');
  const subject = `Marriage Preparation — ${coupleLabel(c)}`;
  const wd = weddingDateOf(c);
  const loc = weddingLocation(c);
  const lines = [
    `Re: Marriage preparation for ${coupleLabel(c)}`,
    ``,
    `Status: ${(COUPLE_STATUS[statusKey(c)] || {}).label || statusKey(c)}`,
    wd ? `Wedding date: ${formatDateDisplay(wd)}` : `Wedding date: not yet set`,
    loc.full ? `Location: ${loc.full}` : '',
  ].filter(Boolean);
  window.location.href = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n'))}`;
}

// ── Config object ───────────────────────────────────────────────────────────
// Cross-panel link adapter (mechanism B): Marriage links to OCIA + Annulment (never
// Marriage↔Marriage). Reused by the shared recordLinks module.
registerLinkPanel('marriage', {
  label: 'Marriage',
  canManage: () => marCanManage(),
  recordTitle: (c) => coupleLabel(c),
  chipsHtml: (c) => chipHtml(statusChip(c)) + chipHtml(typeChip(c)),
  openCall: (id) => `window.expandCouple('${id}')`,
  searchTable: 'couples',
  searchCols: 'id, groom, bride',
  searchFilter: (safe) => `groom.ilike.%${safe}%,bride.ilike.%${safe}%`,
  searchTitle: (r) => `${r.groom || '?'} & ${r.bride || '?'}`,
  displayCols: 'id, groom, bride, spouse1_first, spouse1_last, spouse2_first, spouse2_last, status_code, is_external, archived, marriage_type, type',
});
function linkedRecords(c) { return linkSectionHtml('marriage', c.id); }

export const marriageConfig = {
  panelKey: 'marriage',
  title: 'Marriage Files',
  newLabel: '+ New File',
  groupBy: null,            // flat list
  sortByDate: 'wedding_date',   // shell handles upcoming-first + archived-last

  canManage: () => marCanManage(),
  openCreate: () => window.openCoupleAdd?.(),
  // Settings gear in the shell toolbar → marriage document/step/fee templates
  // (this replaced the old chrome's standalone gear button removed from index.html).
  canManageTemplate: () => isSacramentCoordinator('marriage'),
  openTemplate: () => window.openMarriageTemplates?.(),

  fetchRecords: async () => getCouples(),
  fetchRecord: (id) => getCouple(id),
  searchText: (c) => coupleLabel(c),
  // Tiebreak only (same date / both undated / within the archived cluster).
  compare: (a, b) => coupleLabel(a).toLowerCase().localeCompare(coupleLabel(b).toLowerCase()),

  statusFilters: [
    { key: 'all',        label: 'All',         match: () => true },
    { key: 'inprogress', label: 'In Progress', match: c => c.status_code === 'inprogress' && !c.archived },
    { key: 'complete',   label: 'Complete',    match: c => c.status_code === 'complete' && !c.archived },
    { key: 'external',   label: 'External',    match: c => (c.is_external || c.status_code === 'external') && !c.archived },
    { key: 'inactive',   label: 'Inactive',    match: c => c.status_code === 'inactive' || c.archived },
  ],

  listItem: (c) => ({
    title: coupleLabel(c),
    secondary: [preparerOf(c) ? `Prep: ${preparerOf(c)}` : '', weddingDateOf(c) ? formatDateDisplay(weddingDateOf(c)) : 'Date not set'].filter(Boolean).join(' · '),
    chips: [statusChip(c), typeChip(c), docsCompleteChip(c), feeChip(c)].filter(Boolean),
    flags: [],
  }),

  detailHeader: (c) => ({
    // Couple initials overflow the avatar circle, so the Marriage viewer shows a
    // single gold fa-champagne-glasses glyph instead (inherits the avatar's gold).
    avatarIcon: 'fa-champagne-glasses',
    initials: coupleInitials(c),
    name: coupleLabel(c),
    chips: [statusChip(c), typeChip(c)],
    flags: [],
  }),
  actions: [{ label: 'Email couple', icon: 'fa-envelope', handler: emailCouple }],

  detailSections: [
    { title: 'File details',         render: fileDetails },
    { title: 'Groom',                render: (c) => spouseDetail(c, 1) },
    { title: 'Bride',                render: (c) => spouseDetail(c, 2) },
    { title: 'Fees',                 render: fees },                                  // shown for external too
    { title: 'Documents & Steps',    render: documentsSteps, when: (c) => !c.is_external },  // omitted for external
    { title: 'Linked Records',       render: linkedRecords },
    { title: 'Notes',                render: activity },
  ],

  editForm: (c) => buildMarEditForm(c),
  saveRecord: (id) => marSaveEdit(id),
  deleteRecord: (id) => marDeleteRec(id),

  // External is not a status — it's the is_external toggle in the edit modal. Bulk
  // status writes only real statuses.
  bulkStatusOptions: [
    { key: 'inprogress', label: 'In Progress' },
    { key: 'complete',   label: 'Complete' },
    { key: 'inactive',   label: 'Inactive' },
  ],
  bulkUpdateStatus: (ids, status) => marBulkStatus(ids, status),
};
