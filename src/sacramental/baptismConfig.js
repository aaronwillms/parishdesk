// ── Baptism config for the sacramental master-detail shell ──────────────────
// All panel-specific behavior. Reuses the existing Baptism data/status/flag/
// validation/edit-form/save logic from panels/baptism.js — nothing is
// reimplemented here. See ARCHITECTURE.md for the config schema.

import { store } from '../store.js';
import { fmtDate, formatDateDisplay } from '../utils.js';
import { formatPhone } from '../utils/phone.js';
import { isAdmin, canAccessSacrament, isSacramentCoordinator } from '../roles.js';
import {
  getBapRecords, getBapRecord, bapCanManage, bapTemplate,
  nameOf, lastNameOf, statusOf, bapDate, dobOf, bapAgeOf, bapEsc, gpInvalid, delegationFlag, ageFlag, notesOf, churchName, officiantName,
  BAP_STATUS, buildBapEditForm, bapSaveEdit, bapDeleteRec, bapBulkStatus,
} from '../panels/baptism.js';

const esc = bapEsc;
const STATUS_TONE = { scheduled: 'pending', complete: 'complete', inactive: 'neutral' };
function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}
function statusChip(p) { const k = statusOf(p); return { label: (BAP_STATUS[k] || {}).label || k, tone: STATUS_TONE[k] || 'neutral' }; }
function flagsOf(p) {
  const out = [];
  if (ageFlag(p))        out.push({ icon: 'fa-triangle-exclamation', tone: 'urgent', label: 'Above age of reason — use OCIA', short: 'Age' });
  if (gpInvalid(p))      out.push({ icon: 'fa-triangle-exclamation', tone: 'urgent', label: 'Godparent requirements not met', short: 'Godparents' });
  if (delegationFlag(p)) out.push({ icon: 'fa-envelope-open-text',   tone: 'warn',   label: 'Send Letter of Delegation', short: 'Delegation' });
  if (p.is_adopted)      out.push({ icon: 'fa-child-reaching',        tone: 'info',   label: 'Adoption — birth-parent info confidential', short: 'Adopted' });
  return out;
}

// ── Read-detail section renderers ───────────────────────────────────────────
function row(label, val) {
  return val ? `<div style="display:flex;gap:10px;font-size:13px;padding:3px 0;"><span style="color:#6B7280;min-width:120px;">${esc(label)}</span><span style="flex:1;color:var(--navy);">${val}</span></div>` : '';
}
function fileDetails(p) {
  const age = bapAgeOf(dobOf(p));
  const par1 = `${p.parent1_first || ''} ${p.parent1_last || ''}`.trim();
  const par2 = `${p.parent2_first || ''} ${p.parent2_last || ''}`.trim();
  const parLine = (n, nm, phone, cath) => nm ? `${esc(nm)}${cath === false ? ' <span style="color:#854F0B;">(non-Catholic)</span>' : ''}${phone ? ' · ' + esc(formatPhone(phone)) : ''}` : '';
  return [
    row('Date of birth', dobOf(p) ? `${esc(formatDateDisplay(dobOf(p)))}${age !== null ? ` (age ${age})` : ''}` : ''),
    row('Baptism date', bapDate(p) ? esc(formatDateDisplay(bapDate(p))) : ''),
    row('Church', churchName(p) ? esc(churchName(p)) : ''),
    row('Address', [p.child_street, p.child_city, p.child_state, p.child_zip].filter(Boolean).map(esc).join(', ')),
    row('Parent / Guardian 1', parLine(1, par1, p.parent1_phone, p.parent1_catholic)),
    par2 ? row('Parent / Guardian 2', parLine(2, par2, p.parent2_phone, p.parent2_catholic)) : '',
    row('Officiant', officiantName(p) ? esc(officiantName(p)) : ''),
  ].filter(Boolean).join('') || '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No details yet.</div>';
}
function godparents(p) {
  const gp = (nm, gender, cath) => nm ? `<div style="font-size:13px;padding:2px 0;">${esc(nm)}${gender ? ` (${esc(gender)})` : ''}${cath === false ? ' <span style="color:#854F0B;">— Christian witness only</span>' : ''}</div>` : '';
  const body = [gp(p.godparent1_name, p.godparent1_gender, p.godparent1_catholic), gp(p.godparent2_name, p.godparent2_gender, p.godparent2_catholic)].filter(Boolean).join('');
  const warn = gpInvalid(p) ? `<div class="anl-info-box" style="background:#FDEDEC;border-left-color:#E74C3C;color:#922B21;margin-top:6px;">Godparent requirements not met (one male + one female; at least one Catholic).</div>` : '';
  return (body || '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No godparents recorded.</div>') + warn;
}
function documents(p) {
  const tpl = bapTemplate() || {};
  const docs = [{ name: 'Baptismal Certificate', deletable: false }, ...((tpl.documents) || [])];
  const docList = docs.map(d => `<div style="font-size:13px;padding:2px 0;color:#374151;"><i class="fa-regular fa-file" style="color:#9CA3AF;margin-right:6px;"></i>${esc(d.name)}</div>`).join('');
  const prep = `<div style="display:flex;align-items:center;gap:8px;margin-top:8px;padding:4px 0;">
      <span style="font-size:15px;cursor:pointer;" onclick="toggleBapPrep('${p.id}')">${p.preparation_complete ? '✅' : '⬜'}</span>
      <span style="flex:1;cursor:pointer;color:${p.preparation_complete ? '#2D6A4F' : 'var(--navy)'};" onclick="toggleBapPrep('${p.id}')">Parent / Guardian Preparation Complete</span>
      ${p.preparation_complete && p.preparation_complete_date ? `<span style="font-size:11px;color:#9CA3AF;">${esc(fmtDate(String(p.preparation_complete_date).slice(0, 10)))}</span>` : ''}
    </div>`;
  return docList + prep;
}
function activity(p) {
  const notes = notesOf(p);
  const add = bapCanManage() ? `<div style="display:flex;gap:6px;margin-bottom:8px;">
      <input type="text" id="bn-${p.id}" placeholder="Add a note…" onkeydown="if(event.key==='Enter'){event.preventDefault();addBapNote('${p.id}');}"
        style="flex:1;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;outline:none;" />
      <button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="addBapNote('${p.id}')">Add</button>
    </div>` : '';
  const noteList = notes.length
    ? notes.map(n => `<div style="font-size:13px;color:#555;margin-bottom:6px;padding:8px 12px;background:#FFF8EE;border-left:3px solid var(--gold);border-radius:3px;"><div style="white-space:pre-wrap;">${esc(n.note)}</div>${(n.by || n.created_at) ? `<div style="font-size:11px;color:#9CA3AF;margin-top:3px;">${n.created_at ? esc(fmtDate(String(n.created_at).slice(0, 10))) : ''}${n.by ? ' · ' + esc(n.by) : ''}</div>` : ''}</div>`).join('')
    : '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No notes yet.</div>';
  return add + noteList;
}

// ── Email family (mailto with a prefilled status summary) ───────────────────
function emailFamily(p) {
  const to = [p.parent1_email, p.parent2_email].filter(Boolean).join(',');
  const subject = `Baptism — ${nameOf(p)}`;
  const lines = [
    `Re: Baptismal preparation for ${nameOf(p)}`,
    ``,
    `Status: ${(BAP_STATUS[statusOf(p)] || {}).label || statusOf(p)}`,
    bapDate(p) ? `Baptism date: ${formatDateDisplay(bapDate(p))}` : `Baptism date: not yet scheduled`,
    `Parent preparation: ${p.preparation_complete ? 'complete' : 'not yet complete'}`,
  ];
  const href = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n'))}`;
  window.location.href = href;
}

// ── Config object ───────────────────────────────────────────────────────────
export const baptismConfig = {
  panelKey: 'baptism',
  title: 'Baptismal Preparation',
  newLabel: '+ Add Child',
  groupBy: null,
  sortByDate: 'baptism_date',   // shell: upcoming-first + archived-last

  canManage: () => bapCanManage(),
  canManageTemplate: () => isSacramentCoordinator('baptism'),
  openTemplate: () => window.openBapTemplate?.(),
  openCreate: () => window.openBapCreate?.(),

  fetchRecords: async () => getBapRecords(),
  fetchRecord: (id) => getBapRecord(id),
  searchText: (r) => nameOf(r),
  // Cards sort alphabetically by last name.
  compare: (a, b) => lastNameOf(a).toLowerCase().localeCompare(lastNameOf(b).toLowerCase()),

  statusFilters: [
    { key: 'all',       label: 'All',       match: () => true },
    { key: 'scheduled', label: 'Scheduled', match: p => statusOf(p) === 'scheduled' && !p.archived },
    { key: 'complete',  label: 'Complete',  match: p => statusOf(p) === 'complete' && !p.archived },
    { key: 'inactive',  label: 'Inactive',  match: p => statusOf(p) === 'inactive' || p.archived },
  ],

  listItem: (p) => ({
    title: nameOf(p) + (bapAgeOf(dobOf(p)) !== null ? ` (${bapAgeOf(dobOf(p))})` : ''),
    secondary: bapDate(p) ? `💧 ${formatDateDisplay(bapDate(p))}` : '',
    chips: [statusChip(p)],
    flags: flagsOf(p),
  }),

  detailHeader: (p) => ({
    initials: initialsOf(nameOf(p)),
    name: nameOf(p),
    chips: [statusChip(p)],
    flags: flagsOf(p),
  }),
  actions: [{ label: 'Email family', icon: 'fa-envelope', handler: emailFamily }],

  detailSections: [
    { title: 'File details', render: fileDetails },
    { title: 'Godparents',   render: godparents },
    { title: 'Documents',    render: documents },
    { title: 'Activity',     render: activity },
  ],

  editForm: (p) => buildBapEditForm(p),
  saveRecord: (id) => bapSaveEdit(id),
  deleteRecord: (id) => bapDeleteRec(id),

  bulkStatusOptions: [
    { key: 'scheduled', label: 'Scheduled' },
    { key: 'complete',  label: 'Complete' },
    { key: 'inactive',  label: 'Inactive' },
  ],
  bulkUpdateStatus: (ids, status) => bapBulkStatus(ids, status),
};
