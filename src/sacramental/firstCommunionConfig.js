// ── First Communion config for the sacramental master-detail shell ──────────
// First panel to use cohort GROUPING. Reuses the existing First Communion
// data/cohort/family-link/status/edit-form/save logic from panels/firstcomm.js —
// nothing is reimplemented here. See ARCHITECTURE.md for the config schema.

import { formatDateDisplay, fmtDate } from '../utils.js';
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

const STATUS_TONE = { enrolled: 'pending', preparation: 'active', complete: 'active', received: 'complete', inactive: 'neutral' };
function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}
function statusChip(p) { const k = statusOf(p); return { label: (FC_STATUS[k] || {}).label || k, tone: STATUS_TONE[k] || 'neutral' }; }
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
  const parLine = par1 ? `${esc(par1)}${p.parent1_phone ? ' · ' + esc(formatPhone(p.parent1_phone)) : ''}` : '';
  const ck = cohortKeyOf(p);
  return [
    row('Date of birth', p.dob ? `${esc(formatDateDisplay(p.dob))}${age !== null ? ` (age ${age})` : ''}` : ''),
    row('Grade', (p.grade_level || p.grade) ? esc(p.grade_level || p.grade) : ''),
    row('School', p.school_name ? esc(p.school_name) : ''),
    row('Address', [p.child_street, p.child_city, p.child_state, p.child_zip].filter(Boolean).map(esc).join(', ')),
    row('Parent / Guardian', parLine),
    row('Cohort', ck ? esc(cohortName(ck)) : ''),
    row('Linked family', p.family_group_id ? esc(`${lastNameOf(p)} Family`) : ''),
    row('First Communion', commDate(p) ? `${esc(formatDateDisplay(commDate(p)))}${communionChurch(p) ? ' · ' + esc(communionChurch(p)) : ''}` : ''),
    row('Baptism', [p.baptism_church, p.baptism_city, p.baptism_state].filter(Boolean).map(esc).join(', ')),
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
      ${d.deletable === false ? `<i class="fa-solid fa-lock" style="color:#C9C2B6;font-size:11px;" title="Required"></i>` : ''}
    </div>`).join('');
  } else { h += `<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No documents.</div>`; }
  h += `<div style="display:flex;align-items:center;gap:8px;margin-top:8px;padding:6px 0 0;border-top:.5px solid #F0EDE8;">
      <span style="font-size:15px;cursor:pointer;" onclick="toggleFcPrep('${p.id}')">${p.preparation_complete ? '✅' : '⬜'}</span>
      <span style="flex:1;cursor:pointer;color:${p.preparation_complete ? '#2D6A4F' : 'var(--navy)'};" onclick="toggleFcPrep('${p.id}')">Parent / Guardian Preparation Complete</span>
      ${p.preparation_complete && p.preparation_complete_date ? `<span style="font-size:11px;color:#9CA3AF;">${esc(fmtDate(String(p.preparation_complete_date).slice(0, 10)))}</span>` : ''}
    </div>`;
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
    ? notes.map(n => `<div style="font-size:13px;color:#555;margin-bottom:6px;padding:8px 12px;background:#FFF8EE;border-left:3px solid var(--gold);border-radius:3px;"><div style="white-space:pre-wrap;">${esc(n.note)}</div>${(n.by || n.created_at) ? `<div style="font-size:11px;color:#9CA3AF;margin-top:3px;">${n.created_at ? esc(fmtDate(String(n.created_at).slice(0, 10))) : ''}${n.by ? ' · ' + esc(n.by) : ''}</div>` : ''}</div>`).join('')
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
  title: 'First Communion',
  newLabel: '+ Add Student',

  // Cohort grouping — newest cohort first, "Unassigned" last (shell-handled).
  groupBy: (p) => cohortKeyOf(p),
  groupLabel: (key) => cohortName(key),
  groupCompare: (a, b) => (cohortDateOf(b) || '').localeCompare(cohortDateOf(a) || ''),

  canManage: () => fcCanManage(),
  canManageTemplate: () => isSacramentCoordinator('first_communion') || isSacramentCoordinator('firstcomm'),
  openTemplate: () => window.openFcTemplate?.(),
  openManageCohorts: () => window.openCohortManager?.(),   // cohort CREATION lives here, not in Add Student
  openCreate: () => window.openFcCreate?.(),

  fetchRecords: async () => getFcRecords(),
  fetchRecord: (id) => getFcRecord(id),
  searchText: (r) => nameOf(r),
  compare: (a, b) => lastNameOf(a).toLowerCase().localeCompare(lastNameOf(b).toLowerCase()),

  statusFilters: [
    { key: 'all',         label: 'All',         match: () => true },
    { key: 'enrolled',    label: 'Enrolled',    match: p => statusOf(p) === 'enrolled' && !p.archived },
    { key: 'preparation', label: 'In Prep',     match: p => statusOf(p) === 'preparation' && !p.archived },
    { key: 'complete',    label: 'Prep Done',   match: p => statusOf(p) === 'complete' && !p.archived },
    { key: 'received',    label: 'Received',    match: p => statusOf(p) === 'received' && !p.archived },
    { key: 'inactive',    label: 'Inactive',    match: p => statusOf(p) === 'inactive' || p.archived },
  ],

  listItem: (p) => ({
    title: nameOf(p) + (ageOf(p.dob) !== null ? ` (${ageOf(p.dob)})` : ''),
    secondary: commDate(p) ? `🍞 ${formatDateDisplay(commDate(p))}` : '',
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
    { key: 'complete',    label: 'Preparation Complete' },
    { key: 'received',    label: 'Received First Communion' },
    { key: 'inactive',    label: 'Inactive' },
  ],
  bulkUpdateStatus: (ids, status) => fcBulkStatus(ids, status),
};
