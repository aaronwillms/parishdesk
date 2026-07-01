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

import { formatDateDisplay, fmtDate, todayCST, docCheckStampHtml } from '../utils.js';
import { formatPhone } from '../utils/phone.js';
import { isSacramentCoordinator } from '../roles.js';
import {
  getCaseRecords, getCaseRecord, anlCanManage, anlCanView, CASE_STATUS, TYPE_BADGE,
  caseType, petName, respName, petLast, respLast, advocateName, caseDocs,
  buildAnlEditForm, anlSaveEdit, anlDeleteRec, TIMELINE_EVENTS, parseCaseNotes, BAP_STATUS, loadCasesData,
} from '../panels/annulments.js';
import { registerFamilyPanel, familyLink, familyUnlink } from './familyLink.js';
import { chipHtml, refreshActivePanel } from './panelShell.js';
import { noteEditedMarker } from './noteEdit.js';
import { registerLinkPanel, linkSectionHtml } from './recordLinks.js';
import { sb } from '../supabase.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Group keys: the five status_code values + '__archived' (the archived boolean
// section, always last). archived overrides status placement.
const GROUP_ORDER = ['prep', 'tribunal', 'affirm', 'negative', 'archived', '__archived'];
const GROUP_LABEL = { prep: 'Preparing', tribunal: 'In Tribunal', affirm: 'Affirmative Judgement', negative: 'Negative Judgement', archived: 'Inactive', __archived: 'Archived' };

function isFinalized(c) { return c.judgement_finalized === 'yes' || c.judgement_finalized === true; }
// SIDEBAR CARD title — "Last vs Last", maiden overriding last; degrade to "—".
function caseTitle(c) { return `${petLast(c) || '—'} vs ${respLast(c) || '—'}`; }
// FILE VIEWER heading — full legal name "First Last (Maiden)" per party, maiden in
// parentheses (NOT overriding the last name), parens omitted when no maiden.
// petName/respName already produce exactly this; respondent degrades to "—".
function viewerTitle(c) {
  return `${petName(c)} vs ${respName(c) || '—'}`;
}

// ── Chips ────────────────────────────────────────────────────────────────────
// All colors are REUSED from the existing CASE_STATUS palette / the existing
// briefer chip — no new hex introduced. Dark mode slates badge bg/color via the
// shared !important rule (consistent with every badge); the pending dashed border
// (its own color) survives, keeping pending visually distinct in both themes.
function typeChip(c) {
  // Briefer replaces the FORMAL type chip, so render it IDENTICALLY to a type chip
  // (grey/neutral, same size/padding) — it should read as a type, not stand out.
  if (c.briefer_process) return { label: 'Briefer Process', tone: 'neutral' };
  return { label: TYPE_BADGE[caseType(c)] || 'Type', tone: 'neutral' };
}
// Status-chip palette (light mode): Preparing = purple (the design-system enrolled/
// inquirer purple), In Tribunal = yellow, Affirmative = green, Negative = red,
// Inactive = grey. Dark mode slates all badges via the shared !important rule; the
// pending dashed border (its own hue) survives so pending stays distinct.
const STATUS_CHIP_STYLE = {
  prep:     'background:#EDE9FE;color:#4A1D96;',
  tribunal: 'background:#FEF9E7;color:#7D6608;',
  affirm:   'background:#D8F3DC;color:#2D6A4F;',
  negative: 'background:#FDEDEC;color:#922B21;',
  archived: 'background:#F2F3F4;color:#616A6B;',
};
const PENDING_BORDER = { affirm: '#2D6A4F', negative: '#922B21' };
function statusChip(c) {
  const code = c.status_code || 'prep';
  const base = STATUS_CHIP_STYLE[code] || STATUS_CHIP_STYLE.prep;
  if (code === 'affirm' || code === 'negative') {
    const label = code === 'affirm' ? 'Affirmative' : 'Negative';
    return isFinalized(c)
      ? { label, tone: 'neutral', style: base }
      : { label: `${label} · Pending`, tone: 'neutral', style: `${base}border:1px dashed ${PENDING_BORDER[code]};` };
  }
  return { label: (CASE_STATUS[code] || CASE_STATUS.prep).label, tone: 'neutral', style: base };
}
// Green "Docs Complete" — ONLY on Preparing and Inactive cases, and only when every
// document is checked. Never shown on In Tribunal / Judgement; no "incomplete" chip
// (missing docs surface in the Phase 2 Priority Actions banner).
function docsCompleteChip(c) {
  const code = c.status_code || 'prep';
  if (code !== 'prep' && code !== 'archived') return null;
  // Ignore baptism docs that are HIDDEN by the baptismal-status logic (petitioner 5/6,
  // or respondent doc not applicable) — they aren't required, so they must not block.
  const petNoBap = partyNoBaptism(c, 'pet'), respNoBap = partyNoBaptism(c, 'resp');
  const docs = caseDocs(c).filter(d => {
    const isResp = /baptism/i.test(d.name) && /respondent/i.test(d.name);
    const isPet = /baptism/i.test(d.name) && !/respondent/i.test(d.name);
    if (isPet && petNoBap) return false;
    if (isResp && (!petNoBap || respNoBap)) return false;
    return true;
  });
  if (!docs.length || !docs.every(d => d.received)) return null;
  return { label: 'Docs Complete', tone: 'active' };
}

// ── Read-detail renderers ────────────────────────────────────────────────────
function row(label, val) {
  return val ? `<div style="display:flex;gap:10px;font-size:13px;padding:3px 0;"><span style="color:#6B7280;min-width:140px;">${esc(label)}</span><span style="flex:1;color:var(--navy);">${val}</span></div>` : '';
}
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
  const petAddr = [c.petitioner_street, c.petitioner_city, c.petitioner_state, c.petitioner_zip].filter(Boolean).map(esc).join(', ');
  // Previous annulments (entered list of {spouse_name, diocese}) — one line each.
  const prevAnn = (c.previous_annulments || []).filter(a => a && (a.spouse_name || a.diocese))
    .map(a => `<div>${esc(a.spouse_name || 'Prior spouse')}${a.diocese ? ` — ${esc(a.diocese)}` : ''}</div>`).join('');
  return [
    row('Petitioner', petName(c) ? esc(petName(c)) : ''),
    row('Respondent', respName(c) ? esc(respName(c)) : ''),
    // Briefer Process: the respondent IS the co-petitioner by definition — derive the
    // display from the respondent's name (not a separately-entered co_petitioner value).
    c.briefer_process && respName(c) ? row('Co-Petitioner', esc(respName(c))) : '',
    row('Type', c.briefer_process ? 'Briefer Process' : esc(TYPE_BADGE[caseType(c)] || '')),
    row('Status', esc(statusLabel(c))),
    row('Date of birth', c.petitioner_dob ? esc(formatDateDisplay(c.petitioner_dob)) : ''),
    row('Address', petAddr),
    row('Tribunal diocese', c.tribunal_diocese ? esc(c.tribunal_diocese) : ''),
    row('Date filed', c.date_filed ? esc(formatDateDisplay(c.date_filed)) : ''),
    row('Date received', c.date_received ? esc(formatDateDisplay(c.date_received)) : ''),
    row('Phone', phone ? esc(formatPhone(phone)) : ''),
    row('Email', email ? esc(email) : ''),
    row('Advocate', advocateName(c) ? esc(advocateName(c)) : ''),
    row('Previous annulments', prevAnn),
    // Marriage location — church (or its absence when Non-Church Wedding), date,
    // county, city, state (when present), country.
    c.non_church_wedding ? row('Marriage', 'Non-Church Wedding') : row('Church of marriage', c.marriage_church ? esc(c.marriage_church) : ''),
    row('Date of marriage', c.marriage_date ? esc(formatDateDisplay(c.marriage_date)) : ''),
    row('County', c.marriage_county ? esc(c.marriage_county) : ''),
    row('City', c.marriage_city ? esc(c.marriage_city) : ''),
    row('State', c.marriage_state ? esc(c.marriage_state) : ''),
    row('Country', c.marriage_country ? esc(c.marriage_country) : ''),
  ].filter(Boolean).join('') || '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No details yet.</div>';
}
// Per-party baptism column map + doc detection. 'pet' = petitioner, 'resp' =
// respondent. The respondent doc name contains "respondent"; the petitioner doc is any
// "baptism" doc that is NOT the respondent's.
const VIEWER_BAP_COLS = {
  pet:  { church: 'petitioner_baptism_church', city: 'petitioner_baptism_city', state: 'petitioner_baptism_state', country: 'petitioner_baptism_country', affidavit: 'petitioner_baptism_by_affidavit' },
  resp: { church: 'respondent_baptism_church', city: 'respondent_baptism_city', state: 'respondent_baptism_state', country: 'respondent_baptism_country', affidavit: 'respondent_baptism_by_affidavit' },
};
function baptismDocIdx(docs, party) {
  return party === 'resp'
    ? docs.findIndex(d => /baptism/i.test(d.name) && /respondent/i.test(d.name))
    : docs.findIndex(d => /baptism/i.test(d.name) && !/respondent/i.test(d.name));
}
// A party is "unbaptized" (no baptism doc/fields apply) when (5) Never or (6) Non-Religious.
const partyNoBaptism = (c, party) => party === 'resp'
  ? !!(c.resp_bap_never || c.resp_bap_nonreligious)
  : !!(c.pet_bap_never || c.pet_bap_nonreligious);
// Compact read-only baptism location (shown beneath the doc line when received).
// A "(By Affidavit)" suffix is appended when that party's by-affidavit flag is true.
function baptismReadonly(c, party) {
  const m = VIEWER_BAP_COLS[party];
  const cityState = [c[m.city], c[m.state]].filter(Boolean).map(esc).join(', ');
  const parts = [c[m.church] ? esc(c[m.church]) : '', cityState, c[m.country] ? esc(c[m.country]) : ''].filter(Boolean);
  const aff = c[m.affidavit] ? ' (By Affidavit)' : '';
  const wrap = (txt, italic) => `<div style="margin:0 0 5px 23px;font-size:11.5px;color:${italic ? '#9CA3AF' : '#6B7280'};${italic ? 'font-style:italic;' : ''}line-height:1.4;">${txt}</div>`;
  if (parts.length) return wrap(parts.join(' · ') + aff, false);
  return c[m.affidavit] ? wrap('(By Affidavit)', false) : wrap('No baptism location recorded.', true);
}
// All four of that party's baptism fields filled (trimmed)? Gates the baptism checkbox.
export const BAPTISM_LOCK_TIP = 'Enter the church name, city, and state before marking the baptism record received.';
function baptismFilled(c, party) { const m = VIEWER_BAP_COLS[party]; return [m.church, m.city, m.state, m.country].every(k => String(c[k] || '').trim()); }

// Inline-editable baptism location (shown beneath the doc line when NOT received).
// Pre-populated from the stored {party}_baptism_* values; each field saves on change
// via the write-retry wrapper (anlSaveBaptismField). When `locked` (not all fields
// filled), shows the prompt explaining why the checkbox is disabled.
function baptismEditable(c, party, locked) {
  const m = VIEWER_BAP_COLS[party];
  const inS = `border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.3rem .5rem;font-size:12px;font-family:'Inter',sans-serif;background:#fff;box-sizing:border-box;`;
  const fld = (field, ph, val, grow) => `<input type="text" value="${esc(val || '')}" placeholder="${ph}" onchange="anlSaveBaptismField('${c.id}','${party}','${field}',this)" style="${inS}flex:${grow};min-width:0;" />`;
  return `<div style="margin:1px 0 8px 23px;">
    <div style="font-size:10px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#9CA3AF;margin-bottom:4px;">Baptism location (record not yet received)</div>
    <div style="display:flex;gap:5px;flex-wrap:wrap;">
      ${fld('church', 'Church of Baptism', c[m.church], 2)}
      ${fld('city', 'City', c[m.city], 1)}
      ${fld('state', 'State', c[m.state], 1)}
      ${fld('country', 'Country', c[m.country] || 'United States of America', 1)}
    </div>
    <label style="display:inline-flex;align-items:center;gap:5px;margin-top:6px;font-size:11.5px;color:#6B7280;cursor:pointer;">
      <input type="checkbox" ${c[m.affidavit] ? 'checked' : ''} onchange="anlToggleBaptismAffidavit('${c.id}','${party}',this.checked)" style="width:13px;height:13px;accent-color:var(--cardinal);" />By Affidavit
    </label>
    <div id="anl-bdoc-note-${party}-${c.id}" style="display:${locked ? 'block' : 'none'};font-size:11px;color:#9A6A1E;margin-top:5px;">
      <i class="fa-solid fa-circle-info" style="margin-right:4px;"></i>${esc(BAPTISM_LOCK_TIP)}
    </div>
  </div>`;
}
// Checklist driven by the case's type template; checkboxes are viewer-editable and
// route through the write-retry wrapper (toggleCaseDoc). Beneath the petitioner
// baptism doc, the four baptism-location fields render state-dependently: editable
// inputs while unchecked, compact read-only text once received. The baptism doc's
// checkbox is DISABLED (forward-only gate) until all four fields are filled — an
// already-received doc is never force-unchecked.
function docLine(c, d, i, opts = {}) {
  const canManage = anlCanManage();
  const clickable = canManage && !opts.locked;
  const click = clickable ? `onclick="toggleCaseDoc('${c.id}',${i})"` : '';
  const boxStyle = `font-size:15px;${clickable ? 'cursor:pointer;' : (opts.locked ? 'cursor:not-allowed;opacity:.45;' : '')}`;
  const boxAttrs = `${opts.boxId ? `id="${opts.boxId}" ` : ''}${click}${opts.locked ? ` title="${esc(BAPTISM_LOCK_TIP)}"` : ''}`;
  return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px;">
    <span style="${boxStyle}" ${boxAttrs}>${d.received ? '✅' : '⬜'}</span>
    <span style="flex:1;${clickable ? 'cursor:pointer;' : ''}color:${d.received ? '#2D6A4F' : 'var(--navy)'};" ${click}>${esc(d.name)}</span>
    ${docCheckStampHtml(d)}
    ${d.deletable === false ? `<i class="fa-solid fa-lock" style="color:#C9C2B6;font-size:11px;margin-left:8px;" title="Required"></i>` : ''}
  </div>`;
}
// Render a baptism doc line for a party with its location block + forward-only lock.
function baptismDocBlock(c, d, i, party, canManage) {
  const locked = canManage && !d.received && !baptismFilled(c, party);
  const line = docLine(c, d, i, { locked, boxId: `anl-bdoc-box-${party}-${c.id}` });
  const extra = d.received ? baptismReadonly(c, party) : (canManage ? baptismEditable(c, party, locked) : baptismReadonly(c, party));
  return line + extra;
}
// Readable list of the party's CHECKED baptismal statuses (human labels, semicolon-
// separated). Empty string when none are checked. party = 'pet' | 'resp'.
function baptismStatusList(c, party) {
  const prefix = party === 'resp' ? 'resp' : 'pet';
  return BAP_STATUS.filter(o => c[`${prefix}_bap_${o.suffix}`]).map(o => o.label).join('; ');
}
// One labeled, small/secondary status line ("Petitioner/Respondent Baptismal Status:
// …"). Empty when no statuses are checked (so the none-checked case shows nothing).
// `indent` aligns it under a baptism record's location block (23px) vs. the top
// (documents-heading) placement, which sits flush above the first document.
function baptismStatusLine(c, party, indent) {
  const list = baptismStatusList(c, party);
  if (!list) return '';
  const who = party === 'resp' ? 'Respondent' : 'Petitioner';
  return `<div style="${indent ? 'margin:1px 0 8px 23px;' : 'margin:0 0 10px;'}font-size:11.5px;color:#6B7280;line-height:1.4;">
    <span style="font-weight:600;color:var(--navy);">${who} Baptismal Status:</span> ${esc(list)}</div>`;
}
function documents(c) {
  const canManage = anlCanManage();
  const docs = caseDocs(c);
  const petIdx = baptismDocIdx(docs, 'pet');
  const respIdx = baptismDocIdx(docs, 'resp');
  const petNoBap = partyNoBaptism(c, 'pet');     // petitioner 5/6 → record cleared
  const respNoBap = partyNoBaptism(c, 'resp');   // respondent 5/6 → record cleared
  const showRespSection = petNoBap;              // respondent status shown only when section shown

  // A party's status sits UNDER its baptism record when that record is present (party
  // not 5/6) AND a baptism doc exists to anchor it; otherwise it sits in the top block
  // (under the Documents heading, above the first doc) — same flag as the grey-out.
  const petUnderRecord = !petNoBap && petIdx >= 0;
  const respUnderRecord = showRespSection && !respNoBap && respIdx >= 0;

  let top = '';
  if (!petUnderRecord) top += baptismStatusLine(c, 'pet', false);                 // petitioner: always
  if (showRespSection && !respUnderRecord) top += baptismStatusLine(c, 'resp', false);

  if (!docs.length) return (top || '') + '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No documents.</div>';

  const body = docs.map((d, i) => {
    // Petitioner baptism doc: hidden (kept in data) when the petitioner is 5/6; when
    // present, its checked-status list renders directly under the record.
    if (i === petIdx) return petNoBap ? '' : (baptismDocBlock(c, d, i, 'pet', canManage) + baptismStatusLine(c, 'pet', true));
    // Respondent baptism doc: shown only when the PETITIONER is 5/6 (cross-party) AND
    // the respondent is NOT 5/6 (two-layer); status renders under the record when present.
    if (i === respIdx) return (!showRespSection || respNoBap) ? '' : (baptismDocBlock(c, d, i, 'resp', canManage) + baptismStatusLine(c, 'resp', true));
    return docLine(c, d, i);
  }).join('');
  return top + body;
}
// Shared timeline/notes list entry: a gold bullet on a gold vertical line, the text
// label with a small timestamp beneath, and a hover-X (revealed on row hover) sitting
// immediately to the right of the label. Bullets are UNIFORM — auto-milestones and
// manual entries look identical (type is still stored, just not shown). The classes
// are panel-agnostic (sac-tl-*) so the same pattern carries to other panels.
function tlEntry(text, when, delHandler, canManage, opts = {}) {
  // opts (notes only): { editHandler, editedAt }. Timeline calls omit opts, so they
  // render exactly as before — no edit affordance, no "edited" marker.
  const edited = opts.editedAt ? noteEditedMarker(opts.editedAt) : '';
  const editBtn = (canManage && opts.editHandler)
    ? `<button class="sac-tl-x" title="Edit" onclick="${opts.editHandler}" style="font-size:12px;">✎</button>` : '';
  return `<div class="sac-tl-entry">
    <div class="sac-tl-row">
      <span class="sac-tl-text">${esc(text)}</span>
      ${canManage && delHandler ? `${editBtn}<button class="sac-tl-x" title="Delete" onclick="${delHandler}">×</button>` : ''}
    </div>
    ${(when || edited) ? `<div class="sac-tl-time">${esc(when)}${edited}</div>` : ''}
  </div>`;
}
const tlWhen = (e) => (e.created_at || e.date) ? fmtDate(String(e.created_at || e.date).slice(0, 10)) : '';

// Full timeline — gold line + uniform bullets. Below the list, the "Add Event"
// control: a dropdown of preseeded procedural events + "Other…" free-text + an
// editable date picker (today by default; an earlier date backdates the entry).
function timeline(c) {
  const canManage = anlCanManage();
  const raw = Array.isArray(c.timeline) ? c.timeline : [];
  const body = raw.length
    ? `<div class="sac-tl">${raw.map((e, i) => tlEntry(e.text || e.event || '', tlWhen(e), `anlDeleteTimelineEntry('${c.id}',${i})`, canManage)).join('')}</div>`
    : '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No timeline entries yet.</div>';

  let add = '';
  if (canManage) {
    const opts = TIMELINE_EVENTS.map(ev => `<option value="${esc(ev)}">${esc(ev)}</option>`).join('');
    add = `<div class="sac-add-block">
      <div class="sac-add-head">Add Event</div>
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

// Notes — a deletable list (text + timestamp) using the same line/bullet + hover-X
// styling as the timeline, plus an "Add Note" control styled like "Add Event".
// Stored as a JSON array in the `notes` TEXT column (parseCaseNotes tolerates a
// legacy plain-string note). Writes route through the retry wrapper.
function notes(c) {
  const canManage = anlCanManage();
  const list = parseCaseNotes(c);
  const body = list.length
    ? `<div class="sac-tl">${list.map((n, i) => tlEntry(n.text || '', tlWhen(n), `anlDeleteNote('${c.id}',${i})`, canManage, { editHandler: `anlEditNote('${c.id}',${i})`, editedAt: n.edited_at })).join('')}</div>`
    : '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No notes yet.</div>';

  let add = '';
  if (canManage) {
    add = `<div class="sac-add-block">
      <div class="sac-add-head">Add Note</div>
      <div style="display:flex;gap:6px;align-items:center;">
        <input type="text" id="anl-note-input-${c.id}" placeholder="Write a note…" onkeydown="if(event.key==='Enter'){event.preventDefault();anlAddNote('${c.id}');}" style="flex:1;box-sizing:border-box;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;" />
        <button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;white-space:nowrap;" onclick="anlAddNote('${c.id}')">+ Add note</button>
      </div>
    </div>`;
  }
  return body + add;
}

// ── Linked Cases (annulment ↔ annulment via shared case_group_id) ────────────
// Reuses the shared family-link mechanism (group create/join/merge/unlink) — same
// rules, transitive grouping, confirm-before-merge — configured for annulments via
// the adapter below. Display is annulment-specific: each linked case shows its
// [Status][Type] chips (identical to its card chips) so the whole group's state is
// visible at a glance. Link/unlink route through window.famSearch/famPick/famUnlink.
registerFamilyPanel('annulments', {
  table: 'annulment_cases',
  groupCol: 'case_group_id',
  selectCols: 'id, status_code, judgement_finalized, annulment_type, briefer_process, petitioner, petitioner_last, petitioner_maiden, respondent, respondent_last, respondent_maiden, co_petitioner',
  nameOf: (c) => caseTitle(c),
  optionLabel: (c) => caseTitle(c),
  searchFilter: (safe) => `petitioner.ilike.%${safe}%,respondent.ilike.%${safe}%,petitioner_last.ilike.%${safe}%,respondent_last.ilike.%${safe}%,petitioner_maiden.ilike.%${safe}%,respondent_maiden.ilike.%${safe}%`,
  getAll: () => getCaseRecords(),
  refresh: async () => { await loadCasesData(); refreshActivePanel(); },
  canManage: () => anlCanManage(),
  groupNoun: 'case group',
  groupedSuffix: 'in a group',
  pluralNoun: 'cases',
  linkAction: 'linked annulment case',
  unlinkAction: 'unlinked annulment case',
  groupContext: 'annulments',
});
// Cross-panel link adapter (mechanism B): Annulment links to OCIA + Marriage (never
// annulment↔annulment — that's mechanism A above). groupMembers powers the BRIDGE
// RULE so a cross-panel link to a grouped annulment surfaces the whole group.
registerLinkPanel('annulment', {
  label: 'Annulment',
  canManage: () => anlCanManage(),
  recordTitle: (c) => caseTitle(c),
  chipsHtml: (c) => chipHtml(statusChip(c)) + chipHtml(typeChip(c)),
  openCall: (id) => `window.expandCase('${id}')`,
  searchTable: 'annulment_cases',
  searchCols: 'id, petitioner, petitioner_last, petitioner_maiden, respondent, respondent_last, respondent_maiden',
  searchFilter: (safe) => `petitioner.ilike.%${safe}%,respondent.ilike.%${safe}%,petitioner_last.ilike.%${safe}%,respondent_last.ilike.%${safe}%`,
  searchTitle: (r) => `${r.petitioner_maiden || r.petitioner_last || '—'} vs ${r.respondent_maiden || r.respondent_last || '—'}`,
  displayCols: 'id, status_code, judgement_finalized, annulment_type, type, briefer_process, petitioner, petitioner_last, petitioner_maiden, respondent, respondent_last, respondent_maiden, co_petitioner, case_group_id',
  // SAME-TYPE mechanism (annulment↔annulment): the transitive case-group (mechanism A,
  // case_group_id + familyLink) — NOT record_links. Wired so the unified "Linked
  // Records" search can route an annulment pick to the group while OCIA/Marriage picks
  // go to record_links. DB-driven members so the list is correct without a full reload.
  sameType: {
    members: async (id) => {
      const { data: me } = await sb.from('annulment_cases').select('case_group_id').eq('id', id).maybeSingle();
      if (!me?.case_group_id) return [];
      const { data: sibs } = await sb.from('annulment_cases').select('id').eq('case_group_id', me.case_group_id).neq('id', id);
      return (sibs || []).map(s => s.id);
    },
    link: async (selfId, otherId) => { const ok = await familyLink('annulments', selfId, otherId); if (ok) await loadCasesData(); return ok; },
    unlink: async (memberId) => { const ok = await familyUnlink('annulments', memberId); if (ok) await loadCasesData(); return ok; },
  },
});
// Unified "Linked Records" section (read view + editor): one search over Annulment +
// OCIA + Marriage, all links listed together. The shared recordLinks module routes a
// pick by type — annulment → the case-group mechanism (familyLink, via the adapter's
// sameType hook above); OCIA/Marriage → direct record_links pairs. Bridge rule applies.
function linkedRecords(c) { return linkSectionHtml('annulment', c.id); }
if (typeof window !== 'undefined') window._anlLinkedRecordsEditor = (c) => linkSectionHtml('annulment', c.id);

// ── Config object ────────────────────────────────────────────────────────────
export const annulmentConfig = {
  panelKey: 'annulments',
  pinRecordType: 'annulments',
  title: 'Annulment Cases',
  newLabel: '+ Add Case',

  // Group by STATUS; the archived boolean routes to a single bottom group.
  groupBy: (c) => c.archived ? '__archived' : (c.status_code || 'prep'),
  groupLabel: (k) => GROUP_LABEL[k] || k,
  groupCompare: (a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b),

  canManage: () => anlCanManage(),
  canView: (r) => anlCanView(r),   // cura: coordinators see all; advocates see their cases; + grants
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
    chips: [statusChip(c), typeChip(c), docsCompleteChip(c)].filter(Boolean),
    flags: [],
  }),

  detailHeader: (c) => ({
    avatarIcon: 'fa-scale-balanced',   // scales of justice (a case has two parties)
    name: viewerTitle(c),
    chips: [statusChip(c), typeChip(c), docsCompleteChip(c)].filter(Boolean),
    flags: [],
  }),

  detailSections: [
    { title: 'Case details',  render: caseDetails },
    { title: 'Linked Records', render: linkedRecords },
    { title: 'Documents',     render: documents },
    { title: 'Timeline',      render: timeline },
    { title: 'Notes',         render: notes },
  ],

  // Phase 2: inline type-driven edit form rendered into the shell's detail pane;
  // the shell supplies Save / Cancel / Delete. Save + delete route through the
  // write-retry wrapper inside panels/annulments.js.
  editForm: (c) => buildAnlEditForm(c),
  saveRecord: (id) => anlSaveEdit(id),
  deleteRecord: (id) => anlDeleteRec(id),
};
