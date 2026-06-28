// ── First Communion config for the sacramental master-detail shell ──────────
// First panel to use cohort GROUPING. Reuses the existing First Communion
// data/cohort/family-link/status/edit-form/save logic from panels/firstcomm.js —
// nothing is reimplemented here. See ARCHITECTURE.md for the config schema.

import { formatDateDisplay, fmtDate, docCheckStampHtml } from '../utils.js';
import { noteEditedMarker } from './noteEdit.js';
import { formatPhone } from '../utils/phone.js';
import { isSacramentCoordinator } from '../roles.js';
import { familySectionHtml } from './familyLink.js';
import {
  getFcRecords, getFcRecord, fcCanManage, FC_STATUS,
  nameOf, lastNameOf, statusOf, commDate, ageOf, normDocs, notesOf,
  cohortKeyOf, cohortName, cohortDateOf, communionChurch, preparerOf,
  buildFcEditForm, fcSaveEdit, fcDeleteRec, fcBulkStatus,
} from '../panels/firstcomm.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Explicit chip colors from FC_STATUS (Enrolled purple · In Preparation yellow ·
// Complete green · Inactive grey); dark mode slates badges via the shared rule.
const STATUS_ORDER = ['enrolled', 'preparation', 'complete', 'inactive'];
const statusRank = (p) => { const i = STATUS_ORDER.indexOf(statusOf(p)); return i < 0 ? 999 : i; };
const prepKey = (p) => (preparerOf(p) || '').trim().toLowerCase() || '￿';   // no-preparer sorts last
function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}
function statusChip(p) { const k = statusOf(p), m = FC_STATUS[k] || {}; return { label: m.label || k, tone: 'neutral', style: `background:${m.bg};color:${m.color};` }; }
function flagsOf(p) {
  const out = [];
  const a = ageOf(p.dob);
  if (a !== null && a > 13) out.push({ icon: 'fa-triangle-exclamation', tone: 'warn', label: 'Older candidate — consider Confirmation or OCIA', short: 'Age' });
  if (p.family_group_id) out.push({ icon: 'fa-people-roof', tone: 'info', label: `${lastNameOf(p)} Family`, short: 'Family' });
  const docs = normDocs(p), done = docs.filter(d => d.received).length;
  if (docs.length && done < docs.length) out.push({ icon: 'fa-file', tone: 'warn', label: `${done}/${docs.length} documents received`, short: 'Docs' });
  return out;
}

// ── Read-detail section renderers ───────────────────────────────────────────
function row(label, val) {
  return val ? `<div style="display:flex;gap:10px;font-size:13px;padding:3px 0;"><span style="color:#6B7280;min-width:120px;">${esc(label)}</span><span style="flex:1;color:var(--navy);">${val}</span></div>` : '';
}
function fileDetails(p) {
  const age = ageOf(p.dob);
  const par1 = `${p.parent1_first || ''} ${p.parent1_last || ''}`.trim() || p.parent1 || '';
  const parLine = par1 ? `${esc(par1)}${p.parent1_phone ? ' · ' + esc(formatPhone(p.parent1_phone)) : ''}${p.parent1_email ? ' · ' + esc(p.parent1_email) : ''}` : '';
  const ck = cohortKeyOf(p);
  // Communion church + its city/state; baptism location + country (country appended
  // only alongside an actual location so a defaulted country never shows alone).
  const commLoc = [communionChurch(p), p.communion_city, p.communion_state].filter(Boolean).map(esc).join(' · ');
  const bap = [p.baptism_church, p.baptism_city, p.baptism_state].filter(Boolean);
  if (bap.length && p.baptism_country) bap.push(p.baptism_country);
  return [
    row('Date of birth', p.dob ? `${esc(formatDateDisplay(p.dob))}${age !== null ? ` (age ${age})` : ''}` : ''),
    row('Grade', (p.grade_level || p.grade) ? esc(p.grade_level || p.grade) : ''),
    row('School', p.school_name ? esc(p.school_name) : ''),
    row('Address', [p.child_street, p.child_city, p.child_state, p.child_zip].filter(Boolean).map(esc).join(', ')),
    row('Parent / Guardian', parLine),
    row('Cohort', ck ? esc(cohortName(ck)) : ''),
    row('Linked family', p.family_group_id ? esc(`${lastNameOf(p)} Family`) : ''),
    row('First Communion', commDate(p) ? `${esc(formatDateDisplay(commDate(p)))}${commLoc ? ' · ' + commLoc : ''}` : ''),
    row('Baptism', bap.map(esc).join(', ')),
    row('Person Responsible for Formation', preparerOf(p) ? esc(preparerOf(p)) : ''),
  ].filter(Boolean).join('') || '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No details yet.</div>';
}
function documents(p) {
  const docs = normDocs(p), done = docs.filter(d => d.received).length;
  const progress = docs.length ? Math.round((done / docs.length) * 100) : null;
  let h = '';
  if (docs.length) {
    if (progress !== null) h += `<div class="prog-bar-wrap"><div class="prog-bar-fill" style="width:${progress}%;background:${progress === 100 ? '#2D6A4F' : 'var(--gold)'};"></div></div><div style="font-size:11px;color:#888;margin-bottom:6px;">${done}/${docs.length} received</div>`;
    h += docs.map((d, i) => `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;">
      <span style="font-size:15px;cursor:pointer;" onclick="toggleFcDoc('${p.id}',${i})">${d.received ? '✅' : '⬜'}</span>
      <span style="flex:1;cursor:pointer;color:${d.received ? '#2D6A4F' : 'var(--navy)'};" onclick="toggleFcDoc('${p.id}',${i})">${esc(d.name)}</span>
      ${docCheckStampHtml(d)}
      ${d.deletable === false ? `<i class="fa-solid fa-lock" style="color:#C9C2B6;font-size:11px;margin-left:8px;" title="Required"></i>` : ''}
    </div>`).join('');
  } else { h += `<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No documents.</div>`; }
  return h;
}
function activity(p) {
  const notes = notesOf(p);
  const add = fcCanManage() ? `<div style="display:flex;gap:6px;margin-bottom:8px;">
      <input type="text" id="fcn-${p.id}" placeholder="Add a note…" onkeydown="if(event.key==='Enter'){event.preventDefault();addFcNote('${p.id}');}"
        style="flex:1;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;outline:none;" />
      <button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="addFcNote('${p.id}')">Add</button>
    </div>` : '';
  const noteList = notes.length
    ? notes.map((n, i) => `<div style="font-size:13px;color:#555;margin-bottom:6px;padding:8px 12px;background:#FFF8EE;border-left:3px solid var(--gold);border-radius:3px;"><div style="display:flex;gap:8px;align-items:flex-start;"><div style="white-space:pre-wrap;flex:1;">${esc(n.note)}</div>${fcCanManage() && !n.legacy ? `<button title="Edit" onclick="fcEditNote('${p.id}',${i})" style="background:none;border:none;cursor:pointer;color:#C0A062;font-size:12px;line-height:1.2;padding:0;">✎</button>` : ''}</div>${(n.by || n.created_at || n.edited_at) ? `<div style="font-size:11px;color:#9CA3AF;margin-top:3px;">${n.created_at ? esc(fmtDate(String(n.created_at).slice(0, 10))) : ''}${n.by ? ' · ' + esc(n.by) : ''}${noteEditedMarker(n.edited_at)}</div>` : ''}</div>`).join('')
    : '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No notes yet.</div>';
  return add + noteList;
}

// ── Email family (mailto with a prefilled status summary) ───────────────────
function emailFamily(p) {
  const to = [p.parent1_email, p.email].filter(Boolean).join(',');
  const subject = `First Communion — ${nameOf(p)}`;
  const lines = [
    `Re: First Communion preparation for ${nameOf(p)}`,
    ``,
    `Status: ${(FC_STATUS[statusOf(p)] || {}).label || statusOf(p)}`,
    commDate(p) ? `First Communion date: ${formatDateDisplay(commDate(p))}` : `First Communion date: not yet scheduled`,
    `Parent preparation: ${p.preparation_complete ? 'complete' : 'not yet complete'}`,
  ];
  window.location.href = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n'))}`;
}

// ── Config object ───────────────────────────────────────────────────────────
export const firstCommunionConfig = {
  panelKey: 'firstcommunion',
  sacramentKeys: ['first_communion', 'firstcomm'],   // parish switcher: dual access keys
  title: 'Student Records',
  newLabel: '+ Add Student',

  // Cohort grouping — cohorts ordered by reception date, SOONEST first; "Unassigned"
  // last (shell-handled).
  groupBy: (p) => cohortKeyOf(p),
  groupLabel: (key) => cohortName(key),
  groupCompare: (a, b) => (cohortDateOf(a) || '').localeCompare(cohortDateOf(b) || ''),

  canManage: () => fcCanManage(),
  canManageTemplate: () => isSacramentCoordinator('first_communion') || isSacramentCoordinator('firstcomm'),
  openTemplate: () => window.openFcTemplate?.(),
  openManageCohorts: () => window.openCohortManager?.('firstcomm'),   // shared cohort manager
  openCreate: () => window.openFcCreate?.(),

  fetchRecords: async () => getFcRecords(),
  fetchRecord: (id) => getFcRecord(id),
  searchText: (r) => nameOf(r),
  // Within each cohort: status (Enrolled → In Prep → Complete → Inactive) → preparer → last name.
  compare: (a, b) => statusRank(a) - statusRank(b)
    || prepKey(a).localeCompare(prepKey(b))
    || lastNameOf(a).toLowerCase().localeCompare(lastNameOf(b).toLowerCase()),

  statusFilters: [
    { key: 'all',         label: 'All',         match: () => true },
    { key: 'enrolled',    label: 'Enrolled',    match: p => statusOf(p) === 'enrolled' && !p.archived },
    { key: 'preparation', label: 'In Prep',     match: p => statusOf(p) === 'preparation' && !p.archived },
    { key: 'complete',    label: 'Complete',    match: p => statusOf(p) === 'complete' && !p.archived },
    { key: 'inactive',    label: 'Inactive',    match: p => statusOf(p) === 'inactive' || p.archived },
  ],

  listItem: (p) => ({
    title: nameOf(p) + (ageOf(p.dob) !== null ? ` (${ageOf(p.dob)})` : ''),
    secondary: [preparerOf(p) ? `Prep: ${preparerOf(p)}` : '', commDate(p) ? `✠ ${formatDateDisplay(commDate(p))}` : ''].filter(Boolean).join(' · '),
    chips: [statusChip(p)],
    flags: flagsOf(p),
  }),

  detailHeader: (p) => {
    const ck = cohortKeyOf(p);
    const chips = [statusChip(p)];
    if (ck) chips.push({ label: cohortName(ck), tone: 'neutral' });
    return { initials: initialsOf(nameOf(p)), name: nameOf(p), chips, flags: flagsOf(p) };
  },
  actions: [{ label: 'Email family', icon: 'fa-envelope', handler: emailFamily }],

  detailSections: [
    { title: 'File details', render: fileDetails },
    { title: 'Family',       render: (p) => familySectionHtml('firstcomm', p) },
    { title: 'Documents',    render: documents },
    { title: 'Activity',     render: activity },
  ],

  editForm: (p) => buildFcEditForm(p),
  saveRecord: (id) => fcSaveEdit(id),
  deleteRecord: (id) => fcDeleteRec(id),

  bulkStatusOptions: [
    { key: 'enrolled',    label: 'Enrolled' },
    { key: 'preparation', label: 'In Preparation' },
    { key: 'complete',    label: 'Complete' },
    { key: 'inactive',    label: 'Inactive' },
  ],
  bulkUpdateStatus: (ids, status) => fcBulkStatus(ids, status),
};
