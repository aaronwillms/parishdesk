// ── Confirmation config for the sacramental master-detail shell ─────────────
// First TWO-LEVEL grouped panel: cohort (top) then youth/adult (sub) within each
// cohort. Service hours are YOUTH ONLY. Preparer-only (no officiant). Reuses the
// existing Confirmation data/cohort/type/status/edit-form/save logic from
// panels/confirmation.js — nothing reimplemented here.

import { formatDateDisplay, fmtDate } from '../utils.js';
import { formatPhone } from '../utils/phone.js';
import { isSacramentCoordinator } from '../roles.js';
import {
  getConfRecords, getConfRecord, confCanManage, CONF_STATUS,
  nameOf, lastNameOf, statusOf, tmplType, confDate, normDocs, notesOf, ageOf,
  svcEnabled, svcIncomplete, isYouth, cohortKeyOf, cohortName, cohortDateOf,
  preparerOf, confChurch, buildConfEditForm, confSaveEdit, confDeleteRec, confBulkStatus,
} from '../panels/confirmation.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const STATUS_TONE = { enrolled: 'pending', preparation: 'active', complete: 'active', confirmed: 'complete', inactive: 'neutral' };
function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}
function statusChip(p) { const k = statusOf(p); return { label: (CONF_STATUS[k] || {}).label || k, tone: STATUS_TONE[k] || 'neutral' }; }
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
  const parentLine = parentName ? `${esc(parentName)}${p.parent_phone ? ' · ' + esc(formatPhone(p.parent_phone)) : ''}` : '';
  return [
    row('Type', isYouth(p) ? 'Youth' : 'Adult'),
    row('Cohort', ck ? esc(cohortName(ck)) : ''),
    row('Date of birth', p.dob ? `${esc(formatDateDisplay(p.dob))}${ageOf(p.dob) !== null ? ` (age ${ageOf(p.dob)})` : ''}` : ''),
    row('Preparer', preparerOf(p) ? esc(preparerOf(p)) : ''),
    row('Sponsor', (p.sponsor_name || p.sponsor) ? esc(p.sponsor_name || p.sponsor) : ''),
    row('Confirmation name', p.confirmation_name ? esc(p.confirmation_name) : ''),
    row('Candidate contact', !isYouth(p) && (candPhone || p.candidate_email) ? `${candPhone ? esc(formatPhone(candPhone)) : ''}${p.candidate_email ? (candPhone ? ' · ' : '') + esc(p.candidate_email) : ''}` : ''),
    row('Parent / Guardian', isYouth(p) ? parentLine : ''),
    row('Confirmation', confDate(p) ? `${esc(formatDateDisplay(confDate(p)))}${confChurch(p) ? ' · ' + esc(confChurch(p)) : ''}` : ''),
    row('Baptism', [p.baptism_church, p.baptism_city, p.baptism_state].filter(Boolean).map(esc).join(', ')),
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
      ${d.deletable === false ? `<i class="fa-solid fa-lock" style="color:#C9C2B6;font-size:11px;" title="Required"></i>` : ''}
    </div>`).join('');
  } else { h += `<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No documents.</div>`; }
  return h;
}
function activity(p) {
  const notes = notesOf(p);
  const add = confCanManage() ? `<div style="display:flex;gap:6px;margin-bottom:8px;">
      <input type="text" id="cfn-${p.id}" placeholder="Add a note…" onkeydown="if(event.key==='Enter'){event.preventDefault();addConfNote('${p.id}');}"
        style="flex:1;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;outline:none;" />
      <button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="addConfNote('${p.id}')">Add</button>
    </div>` : '';
  const list = notes.length
    ? notes.map(n => `<div style="font-size:13px;color:#555;margin-bottom:6px;padding:8px 12px;background:#FFF8EE;border-left:3px solid var(--gold);border-radius:3px;"><div style="white-space:pre-wrap;">${esc(n.note)}</div>${(n.by || n.created_at) ? `<div style="font-size:11px;color:#9CA3AF;margin-top:3px;">${n.created_at ? esc(fmtDate(String(n.created_at).slice(0, 10))) : ''}${n.by ? ' · ' + esc(n.by) : ''}</div>` : ''}</div>`).join('')
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
  title: 'Confirmation',
  newLabel: '+ Add Candidate',

  // Two-level grouping: cohort, then youth/adult within each cohort.
  groupBy: (p) => cohortKeyOf(p),
  groupLabel: (key) => cohortName(key),
  groupCompare: (a, b) => (cohortDateOf(b) || '').localeCompare(cohortDateOf(a) || ''),
  noneLabel: 'No Cohort',                       // uncohorted top section (not "Unassigned")
  subGroupBy: (p) => isYouth(p) ? 'youth' : 'adult',
  subGroupOrder: ['youth', 'adult'],
  subGroupLabel: (sk, parentKey) => parentKey === '__none'
    ? (sk === 'adult' ? 'Adult Candidates' : 'Youth Candidates')
    : (sk === 'adult' ? 'Adults' : 'Youth'),

  canManage: () => confCanManage(),
  canManageTemplate: () => isSacramentCoordinator('confirmation'),
  openTemplate: () => window.openConfTemplates?.(),
  openManageCohorts: () => window.openCohortManager?.(),
  openCreate: () => window.openConfCreate?.(),

  fetchRecords: async () => getConfRecords(),
  fetchRecord: (id) => getConfRecord(id),
  searchText: (r) => nameOf(r),
  compare: (a, b) => lastNameOf(a).toLowerCase().localeCompare(lastNameOf(b).toLowerCase()),

  statusFilters: [
    { key: 'all',         label: 'All',         match: () => true },
    { key: 'enrolled',    label: 'Enrolled',    match: p => statusOf(p) === 'enrolled' && !p.archived },
    { key: 'preparation', label: 'In Prep',     match: p => statusOf(p) === 'preparation' && !p.archived },
    { key: 'complete',    label: 'Prep Done',   match: p => statusOf(p) === 'complete' && !p.archived },
    { key: 'confirmed',   label: 'Confirmed',   match: p => statusOf(p) === 'confirmed' && !p.archived },
    { key: 'inactive',    label: 'Inactive',    match: p => statusOf(p) === 'inactive' || p.archived },
  ],

  listItem: (p) => ({
    title: nameOf(p) + (ageOf(p.dob) !== null ? ` (${ageOf(p.dob)})` : ''),
    secondary: confDate(p) ? `🎓 ${formatDateDisplay(confDate(p))}` : '',
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
    { key: 'complete',    label: 'Preparation Complete' },
    { key: 'confirmed',   label: 'Confirmed' },
    { key: 'inactive',    label: 'Inactive' },
  ],
  bulkUpdateStatus: (ids, status) => confBulkStatus(ids, status),
};
