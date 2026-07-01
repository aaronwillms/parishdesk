// ── Confirmation config for the sacramental master-detail shell ─────────────
// First TWO-LEVEL grouped panel: cohort (top) then youth/adult (sub) within each
// cohort. Service hours are YOUTH ONLY. Preparer-only (no officiant). Reuses the
// existing Confirmation data/cohort/type/status/edit-form/save logic from
// panels/confirmation.js — nothing reimplemented here.

import { formatDateDisplay, fmtDate, docCheckStampHtml } from '../utils.js';
import { noteEditedMarker } from './noteEdit.js';
import { formatPhone } from '../utils/phone.js';
import { isSacramentCoordinator } from '../roles.js';
import { familySectionHtml } from './familyLink.js';
import {
  getConfRecords, getConfRecord, confCanManage, confCanView, CONF_STATUS,
  nameOf, lastNameOf, statusOf, tmplType, confDate, normDocs, notesOf, ageOf,
  svcEnabled, svcIncomplete, isYouth, cohortKeyOf, cohortName, cohortDateOf,
  preparerOf, confChurch, buildConfEditForm, confSaveEdit, confDeleteRec, confBulkStatus,
} from '../panels/confirmation.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Explicit chip colors from CONF_STATUS (Enrolled purple · In Preparation yellow ·
// Complete green · Inactive grey); dark mode slates badges via the shared rule.
const STATUS_ORDER = ['enrolled', 'preparation', 'complete', 'inactive'];
const statusRank = (p) => { const i = STATUS_ORDER.indexOf(statusOf(p)); return i < 0 ? 999 : i; };
const prepKey = (p) => (preparerOf(p) || '').trim().toLowerCase() || '￿';   // no-preparer sorts last
function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}
function statusChip(p) { const k = statusOf(p), m = CONF_STATUS[k] || {}; return { label: m.label || k, tone: 'neutral', style: `background:${m.bg};color:${m.color};` }; }
function typeChip(p) { return { label: isYouth(p) ? 'Youth' : 'Adult', tone: 'neutral' }; }
function flagsOf(p) {
  const out = [];
  if (isYouth(p) && svcIncomplete(p)) out.push({ icon: 'fa-clock', tone: 'warn', label: `Service hours: ${p.service_hours_completed || 0}/${p.service_hours_required}`, short: 'Hours' });
  if (isYouth(p) && !p.parent_permission_granted) out.push({ icon: 'fa-triangle-exclamation', tone: 'warn', label: 'Parent permission outstanding', short: 'Permission' });
  const docs = normDocs(p), done = docs.filter(d => d.received).length;
  if (docs.length && done < docs.length) out.push({ icon: 'fa-file', tone: 'warn', label: `${done}/${docs.length} documents received`, short: 'Docs' });
  return out;
}

// ── Read-detail section renderers ───────────────────────────────────────────
function row(label, val) {
  return val ? `<div style="display:flex;gap:10px;font-size:13px;padding:3px 0;"><span style="color:#6B7280;min-width:120px;">${esc(label)}</span><span style="flex:1;color:var(--navy);">${val}</span></div>` : '';
}
function fileDetails(p) {
  const ck = cohortKeyOf(p);
  const candPhone = p.candidate_phone || p.phone;
  const parentName = p.parent_name || p.parent1 || '';
  const parentLine = parentName ? `${esc(parentName)}${p.parent_phone ? ' · ' + esc(formatPhone(p.parent_phone)) : ''}${p.parent_email ? ' · ' + esc(p.parent_email) : ''}` : '';
  // Confirmation church + city/state; baptism + First Communion locations + country
  // (country appended only alongside a real location so a defaulted country never shows alone).
  const confLoc = [confChurch(p), p.confirmation_city, p.confirmation_state].filter(Boolean).map(esc).join(' · ');
  const bap = [p.baptism_church, p.baptism_city, p.baptism_state].filter(Boolean);
  if (bap.length && p.baptism_country) bap.push(p.baptism_country);
  const fc = [p.first_communion_church, p.first_communion_city, p.first_communion_state].filter(Boolean);
  if (fc.length && p.first_communion_country) fc.push(p.first_communion_country);
  return [
    row('Type', isYouth(p) ? 'Youth' : 'Adult'),
    row('Cohort', ck ? esc(cohortName(ck)) : ''),
    row('Date of birth', p.dob ? `${esc(formatDateDisplay(p.dob))}${ageOf(p.dob) !== null ? ` (age ${ageOf(p.dob)})` : ''}` : ''),
    row('School', p.school_name ? esc(p.school_name) : ''),
    row('Grade', (p.grade_level || p.grade) ? esc(p.grade_level || p.grade) : ''),
    row('Person Responsible for Formation', preparerOf(p) ? esc(preparerOf(p)) : ''),
    row('Sponsor', (p.sponsor_name || p.sponsor) ? esc(p.sponsor_name || p.sponsor) : ''),
    row('Confirmation name', p.confirmation_name ? esc(p.confirmation_name) : ''),
    row('Candidate contact', !isYouth(p) && (candPhone || p.candidate_email) ? `${candPhone ? esc(formatPhone(candPhone)) : ''}${p.candidate_email ? (candPhone ? ' · ' : '') + esc(p.candidate_email) : ''}` : ''),
    row('Parent / Guardian', isYouth(p) ? parentLine : ''),
    row('Permission granted', p.parent_permission_date ? esc(formatDateDisplay(p.parent_permission_date)) : ''),
    row('Confirmation', confDate(p) ? `${esc(formatDateDisplay(confDate(p)))}${confLoc ? ' · ' + confLoc : ''}` : ''),
    row('Baptism', bap.map(esc).join(', ')),
    row('First Communion', fc.map(esc).join(', ')),
  ].filter(Boolean).join('') || '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No details yet.</div>';
}
function serviceHours(p) {   // YOUTH ONLY (gated via section `when`)
  const req = p.service_hours_required || 0, done = p.service_hours_completed || 0;
  const pct = req ? Math.min(100, Math.round((done / req) * 100)) : 0;
  return `<div style="font-size:13px;color:var(--navy);margin-bottom:4px;">${done} of ${req} hours completed</div>
    <div class="prog-bar-wrap"><div class="prog-bar-fill" style="width:${pct}%;background:${pct === 100 ? '#2D6A4F' : 'var(--gold)'};"></div></div>`;
}
function documents(p) {
  const docs = normDocs(p), done = docs.filter(d => d.received).length;
  const progress = docs.length ? Math.round((done / docs.length) * 100) : null;
  let h = '';
  if (docs.length) {
    if (progress !== null) h += `<div class="prog-bar-wrap"><div class="prog-bar-fill" style="width:${progress}%;background:${progress === 100 ? '#2D6A4F' : 'var(--gold)'};"></div></div><div style="font-size:11px;color:#888;margin-bottom:6px;">${done}/${docs.length} received</div>`;
    h += docs.map((d, i) => `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;">
      <span style="font-size:15px;cursor:pointer;" onclick="toggleConfDoc('${p.id}',${i})">${d.received ? '✅' : '⬜'}</span>
      <span style="flex:1;cursor:pointer;color:${d.received ? '#2D6A4F' : 'var(--navy)'};" onclick="toggleConfDoc('${p.id}',${i})">${esc(d.name)}</span>
      ${docCheckStampHtml(d)}
      ${d.deletable === false ? `<i class="fa-solid fa-lock" style="color:#C9C2B6;font-size:11px;margin-left:8px;" title="Required"></i>` : ''}
    </div>`).join('');
  } else { h += `<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No documents.</div>`; }
  return h;
}
function activity(p) {
  const notes = notesOf(p);
  const add = confCanManage(p) ? `<div style="display:flex;gap:6px;margin-bottom:8px;">
      <input type="text" id="cfn-${p.id}" placeholder="Add a note…" onkeydown="if(event.key==='Enter'){event.preventDefault();addConfNote('${p.id}');}"
        style="flex:1;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;outline:none;" />
      <button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="addConfNote('${p.id}')">Add</button>
    </div>` : '';
  const list = notes.length
    ? notes.map((n, i) => `<div style="font-size:13px;color:#555;margin-bottom:6px;padding:8px 12px;background:#FFF8EE;border-left:3px solid var(--gold);border-radius:3px;"><div style="display:flex;gap:8px;align-items:flex-start;"><div style="white-space:pre-wrap;flex:1;">${esc(n.note)}</div>${confCanManage(p) && !n.legacy ? `<button title="Edit" onclick="confEditNote('${p.id}',${i})" style="background:none;border:none;cursor:pointer;color:#C0A062;font-size:12px;line-height:1.2;padding:0;">✎</button>` : ''}</div>${(n.by || n.created_at || n.edited_at) ? `<div style="font-size:11px;color:#9CA3AF;margin-top:3px;">${n.created_at ? esc(fmtDate(String(n.created_at).slice(0, 10))) : ''}${n.by ? ' · ' + esc(n.by) : ''}${noteEditedMarker(n.edited_at)}</div>` : ''}</div>`).join('')
    : '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No notes yet.</div>';
  return add + list;
}

function emailFamily(p) {
  const to = [p.candidate_email, p.parent_email, p.email].filter(Boolean).join(',');
  const subject = `Confirmation — ${nameOf(p)}`;
  const lines = [
    `Re: Confirmation preparation for ${nameOf(p)}`,
    ``,
    `Status: ${(CONF_STATUS[statusOf(p)] || {}).label || statusOf(p)}`,
    confDate(p) ? `Confirmation date: ${formatDateDisplay(confDate(p))}` : `Confirmation date: not yet scheduled`,
    isYouth(p) && svcEnabled(p) ? `Service hours: ${p.service_hours_completed || 0} of ${p.service_hours_required}` : '',
  ].filter(Boolean);
  window.location.href = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n'))}`;
}

// ── Config object ───────────────────────────────────────────────────────────
export const confirmationConfig = {
  panelKey: 'confirmation',
  pinRecordType: 'confirmation',
  sacramentKeys: ['confirmation'],   // parish switcher: access keys that gate visible parishes
  title: 'Candidate Records',
  newLabel: '+ Add Candidate',

  // Two-level grouping: cohort, then youth/adult within each cohort.
  groupBy: (p) => cohortKeyOf(p),
  groupLabel: (key) => cohortName(key),
  groupCompare: (a, b) => (cohortDateOf(a) || '').localeCompare(cohortDateOf(b) || ''),   // soonest reception date first
  noneLabel: 'No Cohort',                       // uncohorted top section (not "Unassigned")
  subGroupBy: (p) => isYouth(p) ? 'youth' : 'adult',
  subGroupOrder: ['youth', 'adult'],
  subGroupLabel: (sk, parentKey) => parentKey === '__none'
    ? (sk === 'adult' ? 'Adult Candidates' : 'Youth Candidates')
    : (sk === 'adult' ? 'Adults' : 'Youth'),

  canManage: (r) => confCanManage(r),
  canView: (r) => confCanView(r),
  canManageTemplate: () => isSacramentCoordinator('confirmation'),
  openTemplate: () => window.openConfTemplates?.(),
  openManageCohorts: () => window.openCohortManager?.('confirmation'),
  openCreate: () => window.openConfCreate?.(),

  fetchRecords: async () => getConfRecords(),
  fetchRecord: (id) => getConfRecord(id),
  searchText: (r) => nameOf(r),
  // Within each cohort/sub-group: status (Enrolled → In Prep → Complete → Inactive) → preparer → last name.
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
    secondary: [preparerOf(p) ? `Prep: ${preparerOf(p)}` : '', confDate(p) ? `🎓 ${formatDateDisplay(confDate(p))}` : ''].filter(Boolean).join(' · '),
    chips: [statusChip(p), typeChip(p)],
    flags: flagsOf(p),
  }),

  detailHeader: (p) => {
    const ck = cohortKeyOf(p);
    const chips = [statusChip(p), typeChip(p)];
    if (ck) chips.push({ label: cohortName(ck), tone: 'neutral' });
    return { initials: initialsOf(nameOf(p)), name: nameOf(p), chips, flags: flagsOf(p) };
  },
  actions: [{ label: 'Email family', icon: 'fa-envelope', handler: emailFamily }],

  detailSections: [
    { title: 'File details',  render: fileDetails },
    { title: 'Family',        render: (p) => familySectionHtml('confirmation', p) },
    { title: 'Service Hours', render: serviceHours, when: (p) => isYouth(p) && svcEnabled(p) },   // YOUTH ONLY
    { title: 'Documents',     render: documents },
    { title: 'Activity',      render: activity },
  ],

  editForm: (p) => buildConfEditForm(p),
  saveRecord: (id) => confSaveEdit(id),
  deleteRecord: (id) => confDeleteRec(id),

  bulkStatusOptions: [
    { key: 'enrolled',    label: 'Enrolled' },
    { key: 'preparation', label: 'In Preparation' },
    { key: 'complete',    label: 'Complete' },
    { key: 'inactive',    label: 'Inactive' },
  ],
  bulkUpdateStatus: (ids, status) => confBulkStatus(ids, status),
};
