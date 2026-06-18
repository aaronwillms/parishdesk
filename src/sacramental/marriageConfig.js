// ── Marriage config for the sacramental master-detail shell ─────────────────
// First COUPLE-KEYED panel (subject is a couple, not one person) and the first
// to use the shared OFFICIANT dropdown. Flat list sorted by wedding date,
// upcoming-first. Reuses the existing Marriage queries / four-type / status /
// edit-form / save logic from panels/marriage.js — nothing reimplemented here.

import { fmtDate, formatDateDisplay } from '../utils.js';
import { formatPhone } from '../utils/phone.js';
import { store } from '../store.js';
import { clergyNames } from './preparerField.js';
import {
  getCouples, getCouple, marCanManage, COUPLE_STATUS, MTYPE_BADGE,
  marType, coupleLabel, s1Name, s2Name, normDocs, normSteps, normFees, notesOf,
  feeTotals, weddingDateOf, officiantOf, preparerOf, weddingLocation,
  buildMarEditForm, marSaveEdit, marDeleteRec, marBulkStatus,
} from '../panels/marriage.js';

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
function statusKey(c) { return c.archived ? 'inactive' : (c.status_code || 'inprogress'); }
function statusChip(c) { const k = statusKey(c); return { label: (COUPLE_STATUS[k] || {}).label || k, tone: STATUS_TONE[k] || 'neutral', style: STATUS_STYLE[k] }; }
function typeChip(c) { return { label: MTYPE_BADGE[marType(c)] || 'Marriage', tone: 'neutral' }; }
function ini(name) { const p = String(name || '').trim().split(/\s+/).filter(Boolean); return ((p[0]?.[0] || '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase(); }
function coupleInitials(c) { const a = ini(s1Name(c)) || '?', b = ini(s2Name(c)) || '?'; return `${a}·${b}`; }

// ── Read-detail section renderers ───────────────────────────────────────────
function row(label, val) {
  return val ? `<div style="display:flex;gap:10px;font-size:13px;padding:3px 0;"><span style="color:#6B7280;min-width:120px;">${esc(label)}</span><span style="flex:1;color:var(--navy);">${val}</span></div>` : '';
}
// A visiting/external officiant = the saved officiant isn't one of the parish
// clergy (free-text "Other"). Mirrors the edit form's gating of the Delegation
// field; legacy officiant_override (also a free-text name) counts as visiting.
function hasVisitingOfficiant(c) {
  const o = officiantOf(c);
  return (!!o && !clergyNames().includes(o)) || !!c.officiant_override;
}
function personResponsible(c) {
  if (c.preparation_responsible_id) return (store.personnel || []).find(p => p.id === c.preparation_responsible_id)?.name || '';
  return c.preparation_responsible_override || '';
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
  const out = [
    row('Name', fullName ? esc(fullName) : ''),
    row('Date of birth', dob ? esc(formatDateDisplay(dob)) : ''),
    row('Phone', phone ? esc(formatPhone(phone)) : ''),
    row('Email', email ? esc(email) : ''),
    statusBits.length ? row('Status', statusBits.join(' · ')) : '',
    baptism ? row('Baptism', baptism) : '',
    prior.length ? row('Prior marriages', priorList(prior)) : '',
  ].filter(Boolean).join('');
  return out || '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No details.</div>';
}
function fileDetails(c) {
  const wd = weddingDateOf(c);
  const loc = weddingLocation(c);
  const dateLine = wd ? `${esc(formatDateDisplay(wd))}${c.wedding_time ? ' · ' + esc(c.wedding_time) : ''}` : '<span style="color:#9CA3AF;">Not set</span>';
  // Use the RAW marriage_type for type-conditional fields — marType() collapses
  // to 'external' for external files, which would hide the real type's fields.
  const type = c.marriage_type || marType(c);
  return [
    row('Type', esc(MTYPE_BADGE[type] || '') + (c.is_external ? ' · External' : '')),
    row('Civil marriage', c.civil_marriage_date ? esc(formatDateDisplay(c.civil_marriage_date)) : ''),
    type === 'sanatio' ? row('Faculty granted by', c.sanatio_faculty ? esc(c.sanatio_faculty) : '') : '',
    row('Wedding', dateLine),
    row('Location', loc.name ? esc(loc.name) : (c.non_church_wedding ? 'Non-church wedding' : '')),
    row('Address', loc.lines.length ? esc(loc.lines.join(', ')) : ''),
    row('Officiant', officiantOf(c) ? esc(officiantOf(c)) : ''),
    hasVisitingOfficiant(c) ? row('Delegation', c.delegation_given ? 'Given' : '⚠️ Not given — send letter of delegation') : '',
    row('Preparer', preparerOf(c) ? esc(preparerOf(c)) : ''),
    row('Person responsible', personResponsible(c) ? esc(personResponsible(c)) : ''),
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
      ${!d.deletable ? `<i class="fa-solid fa-lock" style="color:#C9C2B6;font-size:11px;" title="Required"></i>` : ''}
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
    ? notes.map(n => `<div style="font-size:13px;color:#555;margin-bottom:6px;padding:8px 12px;background:#FFF8EE;border-left:3px solid var(--gold);border-radius:3px;"><div style="white-space:pre-wrap;">${esc(n.note)}</div>${(n.by || n.created_at) ? `<div style="font-size:11px;color:#9CA3AF;margin-top:3px;">${n.created_at ? esc(fmtDate(String(n.created_at).slice(0, 10))) : ''}${n.by ? ' · ' + esc(n.by) : ''}</div>` : ''}</div>`).join('')
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
export const marriageConfig = {
  panelKey: 'marriage',
  title: 'Marriage Prep',
  newLabel: '+ New File',
  groupBy: null,            // flat list
  sortByDate: 'wedding_date',   // shell handles upcoming-first + archived-last

  canManage: () => marCanManage(),
  openCreate: () => window.openCoupleAdd?.(),

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
    secondary: weddingDateOf(c) ? `💍 ${formatDateDisplay(weddingDateOf(c))}` : 'Date not set',
    chips: [statusChip(c), typeChip(c)],
    flags: [],
  }),

  detailHeader: (c) => ({
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
    { title: 'Activity',             render: activity },
  ],

  editForm: (c) => buildMarEditForm(c),
  saveRecord: (id) => marSaveEdit(id),
  deleteRecord: (id) => marDeleteRec(id),

  bulkStatusOptions: [
    { key: 'inprogress', label: 'In Progress' },
    { key: 'complete',   label: 'Complete' },
    { key: 'external',   label: 'External' },
    { key: 'inactive',   label: 'Inactive' },
  ],
  bulkUpdateStatus: (ids, status) => marBulkStatus(ids, status),
};
