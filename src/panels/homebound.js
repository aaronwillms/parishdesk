// ── Sick & Homebound (Pastoral Care) — Tab 1 Recipients + managed facilities ──
// Two-tab module mounted into #homebound-root. Tab 1 ("Recipients") plugs into the
// shared sacramental master-detail shell. Locations: home → home address fields;
// facility OR hospital → a parish-managed FACILITY DROPDOWN (homebound_facilities,
// shared by both care-types) + "Other" inline fallback + per-person room. Facility
// identity drives card grouping AND a facility chip; the file view renders the
// location/mailing as a two-line address block, with copy-to-clipboard on the
// LOCATION only. Tab 2 ("Ministers to the Sick") is an empty placeholder (3b).
// Access uses the Step 2 helpers — no new access logic. Facilities are NOT parish
// institutions (separate table; they must not pollute the institution dropdowns).

import { sb, withWriteRetry, deleteWithRetry } from '../supabase.js';
import { store } from '../store.js';
import { logActivity, formatAddressBlock, formatAddressFlat } from '../utils.js';
import { renderSacramentalPanel, refreshActivePanel } from '../sacramental/panelShell.js';
import { isHomeboundBroad, canAccessHomeboundRecipient } from '../roles.js';
import { setFieldLocked } from '../sacramental/churchLocation.js';
import { closeModal } from '../ui/modal.js';
import { flashSavedThen } from '../ui/saveButton.js';
import { showToast } from '../ui/toast.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const CARE_LABEL   = { home: 'Home', facility: 'Facility', hospital: 'Hospital' };
const STATUS_LABEL = { active: 'Active', resolved_discharged: 'Resolved / Discharged', deceased: 'Deceased' };

const ROLE_LABEL = { sacramental: 'Sacramental', communion: 'Communion', visitor: 'Visitor' };

// ── Data ────────────────────────────────────────────────────────────────────
let _recipients = [];
let _facilities = [];
let _rosterLinkedIds = [];   // personnel ids = program_coordinators(program='homebound').coordinator_ids
let _rosterInline = [];      // homebound_roster_inline rows (record-only members)
let _assignments = [];       // homebound_assignments rows
async function loadFacilities() {
  const { data } = await sb.from('homebound_facilities').select('*');
  _facilities = data || [];
  store.homeboundFacilities = _facilities;
}
async function loadRoster() {
  const [coordRes, inlineRes] = await Promise.all([
    sb.from('program_coordinators').select('coordinator_ids').eq('program', 'homebound').maybeSingle(),
    sb.from('homebound_roster_inline').select('*'),
  ]);
  _rosterLinkedIds = coordRes.data?.coordinator_ids || [];
  _rosterInline = inlineRes.data || [];
}
async function loadAssignments() {
  const { data } = await sb.from('homebound_assignments').select('*');
  _assignments = data || [];
}
async function loadHomeboundData() {
  const [recRes] = await Promise.all([
    sb.from('homebound_recipients').select('*'),
    loadFacilities(), loadRoster(), loadAssignments(),
  ]);
  _recipients = recRes.data || [];
  store.homeboundRecipients = _recipients;
  return _recipients;
}

// Combined roster (both kinds), sorted by name. linked = account-linked (grants
// access); inline = record-only (no account, not routable). value-encoded by ID
// (uuid) so names with quotes/commas can't break option values.
function rosterMembers() {
  const linked = _rosterLinkedIds.map(pid => ({
    kind: 'linked', personnelId: pid, name: (store.personnel || []).find(x => x.id === pid)?.name || '(unknown)',
  }));
  const inline = _rosterInline.map(r => ({ kind: 'inline', inlineId: r.id, name: r.name || '(unnamed)' }));
  return [...linked, ...inline].sort((a, b) => a.name.localeCompare(b.name));
}
const assignmentsFor = (recipientId) => _assignments.filter(a => a.recipient_id === recipientId);

// ── Identity / display helpers (inline-or-directory, mirrors Discernment) ─────
function recipientName(r) {
  if (!r) return '';
  if (r.personnel_id) {
    const p = (store.personnel || []).find(x => x.id === r.personnel_id);
    if (p?.name) return p.name;
  }
  const parts = [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' ');
  return parts || r.name || 'Unnamed';
}
function recipientLastName(r) {
  const full = recipientName(r);
  const parts = String(full).trim().split(/\s+/).filter(Boolean);
  return r.last_name || (parts.length ? parts[parts.length - 1] : '');
}
const isActive = (r) => r.status === 'active' && !r.archived_at;

// ── Facility helpers (facility_id → managed list, or inline "Other" name) ─────
function facilityOf(r) { return r.facility_id ? _facilities.find(f => f.id === r.facility_id) : null; }
function facilityName(r) { return facilityOf(r)?.name || r.facility_inline_name || ''; }
function hasFacility(r) { return (r.care_type === 'facility' || r.care_type === 'hospital') && !!(r.facility_id || r.facility_inline_name); }
// The location address: home → home_*; facility/hospital → the managed facility's
// address (Other has no address). Mailing is separate (handled in mailingRead).
function locationAddrOf(r) {
  if (r.care_type === 'home') return { street: r.home_street, city: r.home_city, state: r.home_state, zip: r.home_zip };
  const f = facilityOf(r);
  return f ? { street: f.street, city: f.city, state: f.state, zip: f.zip } : null;
}

// Group key + label for facility care: keyed by facility_id (or the inline name for
// "Other"), so two recipients at the same facility group together regardless of typos.
function facKey(r) { return r.facility_id ? r.facility_id : `other:${(r.facility_inline_name || 'Other facility').trim()}`; }
function facLabelFromGroupKey(k) {
  const key = k.slice(4);   // strip "fac:"
  if (key.startsWith('other:')) return key.slice(6) || 'Other facility';
  return _facilities.find(f => f.id === key)?.name || 'Facility';
}

function locationSummary(r) {
  if (r.care_type === 'facility' || r.care_type === 'hospital') return r.room_unit ? 'Room ' + r.room_unit : '';
  return [r.home_city, r.home_state].filter(Boolean).join(', ') || 'Home';
}

// ── Read-view section helpers ────────────────────────────────────────────────
const _line  = (l, v) => v ? `<div style="display:flex;gap:8px;font-size:13px;margin-bottom:3px;"><span style="color:#9CA3AF;min-width:96px;flex-shrink:0;">${esc(l)}</span><span style="color:var(--navy);">${esc(v)}</span></div>` : '';
const _muted = (t) => `<div style="font-size:13px;color:#9CA3AF;font-style:italic;">${esc(t)}</div>`;
const _addrBlockHtml = (addr) => { const b = formatAddressBlock(addr); return b ? `<div style="font-size:13px;color:var(--navy);white-space:pre-line;">${esc(b)}</div>` : ''; };

function contactRead(r) {
  const rows = (r.personnel_id ? _line('Directory', recipientName(r)) : '')
    + _line('Phone', r.phone) + _line('Email', r.email)
    + _line('Status', STATUS_LABEL[r.status] || r.status);
  return rows || _muted('No contact details on file.');
}
function locationRead(r) {
  const head = (hasFacility(r) ? _line('Facility', facilityName(r)) : '') + (r.room_unit ? _line('Room', r.room_unit) : '');
  const block = _addrBlockHtml(locationAddrOf(r));
  let addrRow = '';
  if (block) {
    // Copy icon on the LOCATION/VISIT address only (a navigate-to target).
    const copy = `<button onclick="window.hbCopyAddress('${r.id}')" title="Copy address" aria-label="Copy address" style="background:none;border:none;cursor:pointer;color:#8FA8BF;padding:0 0 0 6px;font-size:13px;line-height:1;flex-shrink:0;"><i class="fa-solid fa-copy"></i></button>`;
    addrRow = `<div style="display:flex;align-items:flex-start;gap:2px;margin-top:${head ? '4px' : '0'};">${block}${copy}</div>`;
  }
  return (head + addrRow) || _muted('No location on file.');
}
function mailingRead(r) {
  const block = _addrBlockHtml({ street: r.mailing_street, city: r.mailing_city, state: r.mailing_state, zip: r.mailing_zip });
  return block || _muted('Same as home / none on file.');
}

// ── Copy-to-clipboard (location address; flat maps-friendly form) ────────────
async function hbCopyAddress(id) {
  const r = _recipients.find(x => x.id === id);
  if (!r) return;
  const flat = formatAddressFlat(locationAddrOf(r));
  if (!flat) return;
  const ok = () => showToast('Copied', { type: 'success', duration: 1500 });
  // Secure context (HTTPS / localhost / installed PWA) → async clipboard API.
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try { await navigator.clipboard.writeText(flat); ok(); return; } catch (e) { /* fall through */ }
  }
  // Fallback: hidden textarea + execCommand (older / non-secure contexts).
  try {
    const ta = document.createElement('textarea');
    ta.value = flat; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); ok();
  } catch (e) { showToast('Copy unavailable — long-press to copy', { type: 'warning' }); }
}

// ── Recipient form (shared by the inline edit form AND the create modal) ──────
const LS = `font-size:11.5px;font-weight:600;color:#6B7280;display:block;margin:.5rem 0 2px;`;
const IS = `width:100%;box-sizing:border-box;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;outline:none;`;
const SECT = `font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#9CA3AF;margin:.5rem 0 .25rem;`;
const _field = (id, label, val, type = 'text') => `<label style="${LS}">${esc(label)}</label><input type="${type}" id="${id}" value="${esc(val || '')}" style="${IS}" />`;
const _select = (id, label, options, val, onchange = '') => {
  const opts = options.map(([v, l]) => `<option value="${v}"${val === v ? ' selected' : ''}>${esc(l)}</option>`).join('');
  return `<label style="${LS}">${esc(label)}</label><select id="${id}" ${onchange} style="${IS}">${opts}</select>`;
};

// Facility dropdown options (shared by facility + hospital care-types). Preselects
// the linked facility, or "Other…" when an inline fallback name is stored.
function facilityOptionsHtml(r) {
  const fid = r.facility_id || '';
  const isOther = !fid && !!r.facility_inline_name;
  const opts = _facilities.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map(f => `<option value="${f.id}"${fid === f.id ? ' selected' : ''}>${esc(f.name)}</option>`).join('');
  return `<option value="">— Select facility —</option>${opts}<option value="__other"${isOther ? ' selected' : ''}>Other…</option>`;
}

function recipientFormHtml(r = {}) {
  const linked = r.personnel_id || '';
  const personnelOptions = `<option value="">— Not in directory (enter name) —</option>` +
    (store.personnel || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      .map(p => `<option value="${p.id}"${linked === p.id ? ' selected' : ''}>${esc(p.name || '(no name)')}</option>`).join('');
  return `<div data-hbform>
    <label style="${LS}">Directory person (optional)</label>
    <select id="hb-personnel" onchange="window._hbIdentityToggle(this)" style="${IS}">${personnelOptions}</select>
    <div id="hb-inline-identity">
      <div style="display:flex;gap:6px;">
        <div style="flex:1;">${_field('hb-first', 'First', r.first_name)}</div>
        <div style="flex:1;">${_field('hb-middle', 'Middle', r.middle_name)}</div>
        <div style="flex:1;">${_field('hb-last', 'Last', r.last_name)}</div>
      </div>
      <div style="display:flex;gap:6px;">
        <div style="flex:1;">${_field('hb-phone', 'Phone', r.phone, 'tel')}</div>
        <div style="flex:1;">${_field('hb-email', 'Email', r.email, 'email')}</div>
      </div>
    </div>

    <div style="display:flex;gap:6px;margin-top:.4rem;">
      <div style="flex:1;">${_select('hb-ct', 'Care type', [['home', 'Home'], ['facility', 'Facility'], ['hospital', 'Hospital']], r.care_type || 'home', 'onchange="window._hbSwapLocation(this)"')}</div>
      <div style="flex:1;">${_select('hb-status', 'Status', [['active', 'Active'], ['resolved_discharged', 'Resolved / Discharged'], ['deceased', 'Deceased']], r.status || 'active')}</div>
    </div>

    <div id="hb-loc-home" style="margin-top:.4rem;">
      <div style="${SECT}">Home address</div>
      ${_field('hb-home-street', 'Street', r.home_street)}
      <div style="display:flex;gap:6px;">
        <div style="flex:2;">${_field('hb-home-city', 'City', r.home_city)}</div>
        <div style="flex:1;">${_field('hb-home-state', 'State', r.home_state)}</div>
        <div style="flex:1;">${_field('hb-home-zip', 'ZIP', r.home_zip)}</div>
      </div>
    </div>
    <div id="hb-loc-facility" style="margin-top:.4rem;display:none;">
      <div style="${SECT}">Facility / Hospital</div>
      <label style="${LS}">Facility</label>
      <select id="hb-fac" onchange="window._hbFacilityChange(this)" style="${IS}">${facilityOptionsHtml(r)}</select>
      <div id="hb-fac-other-wrap" style="display:none;">${_field('hb-fac-other', 'Facility name (not listed)', r.facility_inline_name)}</div>
      ${_field('hb-fac-room', 'Room / Unit', r.room_unit)}
      <div id="hb-fac-addr" style="display:none;margin-top:.3rem;">
        ${_field('hb-fac-street', 'Street', '')}
        <div style="display:flex;gap:6px;">
          <div style="flex:2;">${_field('hb-fac-city', 'City', '')}</div>
          <div style="flex:1;">${_field('hb-fac-state', 'State', '')}</div>
          <div style="flex:1;">${_field('hb-fac-zip', 'ZIP', '')}</div>
        </div>
      </div>
    </div>

    <div style="margin-top:.7rem;">
      <div style="${SECT}">Mailing address <span style="font-weight:400;text-transform:none;letter-spacing:0;color:#9CA3AF;">— where the bulletin goes</span></div>
      <label style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--navy);margin-bottom:.4rem;cursor:pointer;">
        <input type="checkbox" id="hb-mail-same" onchange="window._hbMailingToggle(this)" style="width:15px;height:15px;accent-color:var(--cardinal);" /> Same as home address
      </label>
      ${_field('hb-mail-street', 'Street', r.mailing_street)}
      <div style="display:flex;gap:6px;">
        <div style="flex:2;">${_field('hb-mail-city', 'City', r.mailing_city)}</div>
        <div style="flex:1;">${_field('hb-mail-state', 'State', r.mailing_state)}</div>
        <div style="flex:1;">${_field('hb-mail-zip', 'ZIP', r.mailing_zip)}</div>
      </div>
    </div>
  </div>`;
}

// ── Dynamic form behavior (scoped to the form's [data-hbform] wrapper) ────────
const _q = (root, id) => root ? root.querySelector('#' + id) : null;

function _applyMailing(root, same) {
  [['hb-mail-street', 'hb-home-street'], ['hb-mail-city', 'hb-home-city'], ['hb-mail-state', 'hb-home-state'], ['hb-mail-zip', 'hb-home-zip']]
    .forEach(([m, h]) => {
      const me = _q(root, m), he = _q(root, h);
      if (!me) return;
      if (same) { me.value = he?.value || ''; setFieldLocked(me, true); }
      else setFieldLocked(me, false);
    });
}
function _hbIdentityToggle(el) {
  const root = el.closest('[data-hbform]');
  const block = _q(root, 'hb-inline-identity');
  if (block) block.style.display = _q(root, 'hb-personnel')?.value ? 'none' : 'block';
}
function _hbSwapLocation(el) {
  const root = el.closest('[data-hbform]');
  const ct = _q(root, 'hb-ct')?.value || 'home';
  const home = _q(root, 'hb-loc-home'); if (home) home.style.display = ct === 'home' ? 'block' : 'none';
  const fac = _q(root, 'hb-loc-facility'); if (fac) fac.style.display = (ct === 'facility' || ct === 'hospital') ? 'block' : 'none';
  if (_q(root, 'hb-mail-same')?.checked) _applyMailing(root, true);
}
// Facility select change → autofill + lock the address preview (managed facility),
// or reveal the free "Other" name input. The address preview is derived/locked and
// NOT persisted (facility identity lives in facility_id; address lives on the list).
function _hbFacilityChange(el) {
  const root = el.closest('[data-hbform]');
  const val = _q(root, 'hb-fac')?.value || '';
  const otherWrap = _q(root, 'hb-fac-other-wrap');
  const addrWrap = _q(root, 'hb-fac-addr');
  if (val === '__other') {
    if (otherWrap) otherWrap.style.display = 'block';
    if (addrWrap) addrWrap.style.display = 'none';
  } else if (val) {
    if (otherWrap) otherWrap.style.display = 'none';
    const f = _facilities.find(x => x.id === val);
    [['hb-fac-street', 'street'], ['hb-fac-city', 'city'], ['hb-fac-state', 'state'], ['hb-fac-zip', 'zip']].forEach(([id, k]) => {
      const e = _q(root, id); if (!e) return; e.value = f?.[k] || ''; setFieldLocked(e, true);
    });
    if (addrWrap) addrWrap.style.display = 'block';
  } else {
    if (otherWrap) otherWrap.style.display = 'none';
    if (addrWrap) addrWrap.style.display = 'none';
  }
}
function _hbMailingToggle(el) {
  const root = el.closest('[data-hbform]');
  _applyMailing(root, !!_q(root, 'hb-mail-same')?.checked);
}
// Set initial visibility + mailing default after the form mounts.
function _hbHydrateForm(root) {
  if (!root) return;
  const idBlock = _q(root, 'hb-inline-identity');
  if (idBlock) idBlock.style.display = _q(root, 'hb-personnel')?.value ? 'none' : 'block';
  const ct = _q(root, 'hb-ct')?.value || 'home';
  const home = _q(root, 'hb-loc-home'); if (home) home.style.display = ct === 'home' ? 'block' : 'none';
  const fac = _q(root, 'hb-loc-facility'); if (fac) fac.style.display = (ct === 'facility' || ct === 'hospital') ? 'block' : 'none';
  const facSel = _q(root, 'hb-fac'); if (facSel) _hbFacilityChange(facSel);
  const g = id => (_q(root, id)?.value || '').trim();
  const homeV = ['hb-home-street', 'hb-home-city', 'hb-home-state', 'hb-home-zip'].map(g);
  const mailV = ['hb-mail-street', 'hb-mail-city', 'hb-mail-state', 'hb-mail-zip'].map(g);
  const same = mailV.every(x => !x) || mailV.join('|') === homeV.join('|');
  const cb = _q(root, 'hb-mail-same'); if (cb) cb.checked = same;
  _applyMailing(root, same);
}

// Read the form (scoped to root) into a homebound_recipients payload, or null.
function _hbReadForm(root) {
  if (!root) return null;
  const v = id => (_q(root, id)?.value || '').trim();
  const personnel_id = v('hb-personnel') || null;
  const first = v('hb-first'), middle = v('hb-middle'), last = v('hb-last');
  const name = personnel_id
    ? ((store.personnel || []).find(p => p.id === personnel_id)?.name || null)
    : ([first, middle, last].filter(Boolean).join(' ') || null);
  if (!personnel_id && !name) { alert('Enter a name or link a directory person.'); return null; }
  const ct = v('hb-ct') || 'home';
  let facility_id = null, facility_inline_name = null, room_unit = null;
  if (ct === 'facility' || ct === 'hospital') {
    const fsel = v('hb-fac');
    if (fsel === '__other') facility_inline_name = v('hb-fac-other') || null;
    else if (fsel) facility_id = fsel;
    room_unit = v('hb-fac-room') || null;
  }
  return {
    personnel_id,
    first_name:  personnel_id ? null : (first || null),
    middle_name: personnel_id ? null : (middle || null),
    last_name:   personnel_id ? null : (last || null),
    name,
    phone: personnel_id ? null : (v('hb-phone') || null),
    email: personnel_id ? null : (v('hb-email') || null),
    care_type: ct,
    status: v('hb-status') || 'active',
    home_street: v('hb-home-street') || null, home_city: v('hb-home-city') || null, home_state: v('hb-home-state') || null, home_zip: v('hb-home-zip') || null,
    facility_id, facility_inline_name, room_unit,
    mailing_street: v('hb-mail-street') || null, mailing_city: v('hb-mail-city') || null, mailing_state: v('hb-mail-state') || null, mailing_zip: v('hb-mail-zip') || null,
    updated_at: new Date().toISOString(),
  };
}

// ── Persist (recipient) ───────────────────────────────────────────────────────
async function homeboundSaveEdit(id) {
  if (!isHomeboundBroad()) return { ok: false };
  const root = document.querySelector('#sac-editform [data-hbform]');
  const payload = _hbReadForm(root);
  if (!payload) return { ok: false };
  const { error } = await withWriteRetry(() => sb.from('homebound_recipients').update(payload).eq('id', id), { kind: 'update' });
  if (error) { alert('Save failed: ' + error.message); return { ok: false }; }
  logActivity({ action: 'updated homebound recipient', entityType: 'homebound_recipient', entityName: payload.name || 'Recipient', contextType: 'homebound', contextId: id });
  await loadHomeboundData();
  return { ok: true };
}

function openRecipientCreate() {
  if (!isHomeboundBroad()) return;
  document.getElementById('modal-content').innerHTML = `
    <div class="modal-title">New Recipient</div>
    ${recipientFormHtml({})}
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" onclick="window.hbCreateSave()">Create</button>
    </div>`;
  document.getElementById('modal-overlay').classList.add('open');
  setTimeout(() => _hbHydrateForm(document.querySelector('#modal-overlay [data-hbform]')), 0);
}
async function hbCreateSave() {
  if (!isHomeboundBroad()) return;
  const root = document.querySelector('#modal-overlay [data-hbform]');
  const payload = _hbReadForm(root);
  if (!payload) return;
  payload.created_at = new Date().toISOString();
  const { data, error } = await withWriteRetry(() => sb.from('homebound_recipients').insert(payload).select('id').single(), { kind: 'create' });
  if (error) { alert('Create failed: ' + error.message); return; }
  logActivity({ action: 'created homebound recipient', entityType: 'homebound_recipient', entityName: payload.name || 'Recipient', contextType: 'homebound' });
  await loadHomeboundData();
  flashSavedThen(() => { closeModal(); refreshActivePanel(); location.hash = `#/homebound/${data.id}`; });
}

// ── Facilities manager (panel settings cog; broad users only) ─────────────────
function openFacilitiesManager() {
  if (!isHomeboundBroad()) return;
  _renderFacilitiesManager();
  document.getElementById('modal-overlay').classList.add('open');
}
function _renderFacilitiesManager() {
  const list = _facilities.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const rows = list.length ? list.map(f => {
    const addr = formatAddressFlat({ street: f.street, city: f.city, state: f.state, zip: f.zip });
    return `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:.45rem .55rem;background:#F8F7F4;border:.5px solid var(--stone);border-radius:6px;margin-bottom:.35rem;">
      <div style="min-width:0;"><div style="font-size:13px;color:var(--navy);font-weight:600;">${esc(f.name)}</div>${addr ? `<div style="font-size:11.5px;color:#6B7280;">${esc(addr)}</div>` : ''}</div>
      <div style="display:flex;gap:8px;flex-shrink:0;">
        <button class="card-action" onclick="window.hbFacilityEdit('${f.id}')">Edit</button>
        <button class="card-action" style="color:#A32D2D;" onclick="window.hbFacilityRemove('${f.id}')">Remove</button>
      </div></div>`;
  }).join('') : `<div style="font-size:12.5px;color:#9CA3AF;font-style:italic;margin-bottom:.5rem;">No facilities yet.</div>`;
  document.getElementById('modal-content').innerHTML = `
    <div class="modal-title">Facilities &amp; Hospitals</div>
    <div style="font-size:11.5px;color:#9CA3AF;margin-bottom:.7rem;">Shared by facility &amp; hospital recipients — manage the list so locations group and autofill consistently.</div>
    <div style="max-height:240px;overflow-y:auto;margin-bottom:.8rem;">${rows}</div>
    <div data-hbfac style="background:var(--parch);border:.5px solid var(--stone);border-radius:var(--radius-sm);padding:.7rem;">
      <div style="${SECT}">Add facility</div>
      ${_field('hbf-name', 'Name', '')}
      ${_field('hbf-street', 'Street', '')}
      <div style="display:flex;gap:6px;">
        <div style="flex:2;">${_field('hbf-city', 'City', '')}</div>
        <div style="flex:1;">${_field('hbf-state', 'State', '')}</div>
        <div style="flex:1;">${_field('hbf-zip', 'ZIP', '')}</div>
      </div>
      <button class="btn-secondary" style="margin-top:.5rem;padding:.35rem .9rem;font-size:12px;" onclick="window.hbFacilityAdd()">+ Add facility</button>
    </div>
    <div class="modal-actions"><button class="btn-secondary" onclick="closeModal()">Done</button></div>`;
}
function _readFacilityForm() {
  const root = document.querySelector('#modal-content [data-hbfac]');
  const g = id => (root?.querySelector('#' + id)?.value || '').trim();
  const name = g('hbf-name');
  if (!name) { alert('Facility name is required.'); return null; }
  return { name, street: g('hbf-street') || null, city: g('hbf-city') || null, state: g('hbf-state') || null, zip: g('hbf-zip') || null };
}
async function hbFacilityAdd() {
  if (!isHomeboundBroad()) return;
  const payload = _readFacilityForm(); if (!payload) return;
  const { error } = await withWriteRetry(() => sb.from('homebound_facilities').insert(payload), { kind: 'create' });
  if (error) { alert('Add failed: ' + error.message); return; }
  logActivity({ action: 'added homebound facility', entityType: 'homebound_facility', entityName: payload.name, contextType: 'homebound' });
  await loadFacilities(); _renderFacilitiesManager(); refreshActivePanel();
}
function hbFacilityEdit(id) {
  const f = _facilities.find(x => x.id === id); if (!f) return;
  document.getElementById('modal-content').innerHTML = `
    <div class="modal-title">Edit Facility</div>
    <div data-hbfac>
      ${_field('hbf-name', 'Name', f.name)}
      ${_field('hbf-street', 'Street', f.street)}
      <div style="display:flex;gap:6px;">
        <div style="flex:2;">${_field('hbf-city', 'City', f.city)}</div>
        <div style="flex:1;">${_field('hbf-state', 'State', f.state)}</div>
        <div style="flex:1;">${_field('hbf-zip', 'ZIP', f.zip)}</div>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="window.hbFacilityBack()">Back</button>
      <button class="btn-primary" onclick="window.hbFacilitySave('${id}')">Save</button>
    </div>`;
}
async function hbFacilitySave(id) {
  if (!isHomeboundBroad()) return;
  const payload = _readFacilityForm(); if (!payload) return;
  const { error } = await withWriteRetry(() => sb.from('homebound_facilities').update(payload).eq('id', id), { kind: 'update' });
  if (error) { alert('Save failed: ' + error.message); return; }
  logActivity({ action: 'updated homebound facility', entityType: 'homebound_facility', entityName: payload.name, contextType: 'homebound' });
  await loadFacilities(); _renderFacilitiesManager(); refreshActivePanel();
}
async function hbFacilityRemove(id) {
  if (!isHomeboundBroad()) return;
  const f = _facilities.find(x => x.id === id);
  if (!confirm(`Remove ${f?.name || 'this facility'} from the list? Recipients there keep their record but lose the facility link.`)) return;
  const { error } = await deleteWithRetry(() => sb.from('homebound_facilities').delete().eq('id', id));
  if (error) { alert('Remove failed: ' + error.message); return; }
  logActivity({ action: 'removed homebound facility', entityType: 'homebound_facility', entityName: f?.name || 'Facility', contextType: 'homebound' });
  await loadHomeboundData(); _renderFacilitiesManager(); refreshActivePanel();
}
function hbFacilityBack() { _renderFacilitiesManager(); }

// ── Tab 2 — Ministers to the Sick roster ──────────────────────────────────────
const _badge = (text, cls, title) => `<span class="badge ${cls}" title="${esc(title || text)}" style="font-size:10px;">${esc(text)}</span>`;

function renderRosterTab() {
  const el = document.getElementById('hb-tab-ministers');
  if (!el) return;
  const broad = isHomeboundBroad();
  const members = rosterMembers();
  const memberRows = members.length ? members.map(m => {
    const badge = m.kind === 'linked'
      ? _badge('Account · grants access', 'badge-active', 'Account-linked — grants broad access; locks their Admin Panel toggle')
      : _badge('No account — record only', 'badge-complete', 'Record-only — no account, no access, not notified');
    const remove = broad
      ? `<button class="card-action" style="color:#A32D2D;" onclick="window.${m.kind === 'linked' ? `hbRosterRemoveLinked('${m.personnelId}')` : `hbRosterRemoveInline('${m.inlineId}')`}">Remove</button>`
      : '';
    const icon = m.kind === 'linked' ? 'fa-user' : 'fa-user-tag';
    return `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:.45rem .55rem;background:#F8F7F4;border:.5px solid var(--stone);border-radius:6px;margin-bottom:.35rem;">
      <div style="display:flex;align-items:center;gap:9px;min-width:0;">
        <i class="fa-solid ${icon}" style="color:#8FA8BF;font-size:13px;flex-shrink:0;"></i>
        <div style="min-width:0;"><div style="font-size:13px;color:var(--navy);font-weight:600;">${esc(m.name)}</div><div style="margin-top:2px;">${badge}</div></div>
      </div>
      ${remove}
    </div>`;
  }).join('') : `<div style="font-size:12.5px;color:#9CA3AF;font-style:italic;margin-bottom:.5rem;">No ministers on the roster yet.</div>`;

  // Add control (broad only): directory person OR "+Other" inline name.
  const avail = (store.personnel || []).filter(p => !_rosterLinkedIds.includes(p.id))
    .slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const addControl = broad ? `
    <div style="background:var(--parch);border:.5px solid var(--stone);border-radius:var(--radius-sm);padding:.7rem;margin-top:.4rem;">
      <div style="${SECT}">Add a minister</div>
      <select id="hb-roster-pick" onchange="window._hbRosterPickChange(this)" style="${IS}">
        <option value="">— Select directory person —</option>
        ${avail.map(p => `<option value="${p.id}">${esc(p.name || '(no name)')}</option>`).join('')}
        <option value="__other">+ Other (name only, no account)…</option>
      </select>
      <div id="hb-roster-other-wrap" style="display:none;">${_field('hb-roster-other', 'Name', '')}</div>
      <button class="btn-secondary" style="margin-top:.5rem;padding:.35rem .9rem;font-size:12px;" onclick="window.hbRosterAdd()">+ Add to roster</button>
    </div>` : `<div style="font-size:12px;color:#9CA3AF;font-style:italic;">Roster management is limited to Sick &amp; Homebound coordinators.</div>`;

  el.innerHTML = `
    <div style="max-width:560px;">
      <div style="font-size:11.5px;color:#9CA3AF;margin-bottom:.7rem;">Account-linked members get full access (and lock their Admin Panel toggle). Record-only members appear here and in assignments but have no account, no access, and are not notified.</div>
      ${memberRows}
      ${addControl}
    </div>`;
}

function _hbRosterPickChange(el) {
  const wrap = document.getElementById('hb-roster-other-wrap');
  if (wrap) wrap.style.display = el.value === '__other' ? 'block' : 'none';
}
async function hbRosterAdd() {
  if (!isHomeboundBroad()) return;
  const val = document.getElementById('hb-roster-pick')?.value || '';
  if (!val) return;
  if (val === '__other') {
    const name = (document.getElementById('hb-roster-other')?.value || '').trim();
    if (!name) { alert('Enter a name.'); return; }
    const { error } = await withWriteRetry(() => sb.from('homebound_roster_inline').insert({ name }), { kind: 'create' });
    if (error) { alert('Add failed: ' + error.message); return; }
    logActivity({ action: 'added record-only minister to the sick', entityType: 'homebound_roster', entityName: name, contextType: 'homebound' });
  } else {
    const ids = [...new Set([..._rosterLinkedIds, val])];
    const { error } = await sb.from('program_coordinators').upsert({ program: 'homebound', coordinator_ids: ids, updated_at: new Date().toISOString() }, { onConflict: 'program' });
    if (error) { alert('Add failed: ' + error.message); return; }
    const nm = (store.personnel || []).find(p => p.id === val)?.name || 'Minister';
    logActivity({ action: 'added minister to the sick', entityType: 'homebound_roster', entityName: nm, contextType: 'homebound' });
  }
  await loadRoster(); renderRosterTab();
}
async function hbRosterRemoveLinked(pid) {
  if (!isHomeboundBroad()) return;
  const nm = (store.personnel || []).find(p => p.id === pid)?.name || 'this minister';
  if (!confirm(`Remove ${nm} from the roster? They lose roster-based access on their next sign-in / roles reload (cached — not instant).`)) return;
  const ids = _rosterLinkedIds.filter(x => x !== pid);
  const { error } = await sb.from('program_coordinators').upsert({ program: 'homebound', coordinator_ids: ids, updated_at: new Date().toISOString() }, { onConflict: 'program' });
  if (error) { alert('Remove failed: ' + error.message); return; }
  logActivity({ action: 'removed minister to the sick', entityType: 'homebound_roster', entityName: nm, contextType: 'homebound' });
  await loadRoster(); renderRosterTab();
}
async function hbRosterRemoveInline(id) {
  if (!isHomeboundBroad()) return;
  const nm = _rosterInline.find(x => x.id === id)?.name || 'this minister';
  if (!confirm(`Remove ${nm} (record-only) from the roster?`)) return;
  const { error } = await deleteWithRetry(() => sb.from('homebound_roster_inline').delete().eq('id', id));
  if (error) { alert('Remove failed: ' + error.message); return; }
  logActivity({ action: 'removed record-only minister to the sick', entityType: 'homebound_roster', entityName: nm, contextType: 'homebound' });
  await loadRoster(); renderRosterTab();
}

// ── Per-file assignment (recipient detail section) ────────────────────────────
function ministersSection(r) {
  const broad = isHomeboundBroad();
  const list = assignmentsFor(r.id);
  const rows = list.length ? list.map(a => {
    const linked = !!a.minister_personnel_id;
    const name = linked
      ? ((store.personnel || []).find(p => p.id === a.minister_personnel_id)?.name || '(unknown)')
      : (a.minister_inline_name || '(unnamed)');
    const roleChip = a.role ? _badge(ROLE_LABEL[a.role] || a.role, 'badge-complete') : '';
    const recordOnly = linked ? '' : `<span style="font-size:10.5px;color:#9CA3AF;font-style:italic;">record only</span>`;
    const rm = broad ? `<button class="card-action" style="color:#A32D2D;" onclick="window.hbUnassign('${a.id}')" title="Unassign">Remove</button>` : '';
    return `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:.4rem .5rem;background:#F8F7F4;border:.5px solid var(--stone);border-radius:6px;margin-bottom:.3rem;">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;">
        <span style="font-size:13px;color:var(--navy);">${esc(name)}</span>${roleChip}${recordOnly}
      </div>${rm}</div>`;
  }).join('') : `<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No ministers assigned.</div>`;

  let add = '';
  if (broad) {
    const opts = rosterMembers().map(m =>
      `<option value="${m.kind === 'linked' ? 'p:' + m.personnelId : 'i:' + m.inlineId}">${esc(m.name)}${m.kind === 'inline' ? ' (record only)' : ''}</option>`).join('');
    const roleOpts = Object.entries(ROLE_LABEL).map(([v, l]) => `<option value="${v}"${v === 'communion' ? ' selected' : ''}>${l}</option>`).join('');
    const noRoster = rosterMembers().length === 0;
    add = noRoster
      ? `<div style="font-size:12px;color:#9CA3AF;font-style:italic;margin-top:.5rem;">Add ministers to the roster (Tab 2) to assign them here.</div>`
      : `<div style="display:flex;gap:6px;margin-top:.55rem;flex-wrap:wrap;align-items:center;">
          <select id="hb-assign-pick-${r.id}" style="${IS}flex:1;min-width:150px;"><option value="">— Roster member —</option>${opts}</select>
          <select id="hb-assign-role-${r.id}" style="${IS}width:auto;">${roleOpts}</select>
          <button class="btn-secondary" style="padding:.4rem .9rem;font-size:12px;white-space:nowrap;" onclick="window.hbAssign('${r.id}')">Assign</button>
        </div>`;
  }
  return rows + add;
}
async function hbAssign(recipientId) {
  if (!isHomeboundBroad()) return;
  const v = document.getElementById('hb-assign-pick-' + recipientId)?.value || '';
  if (!v) return;
  let minister_personnel_id = null, minister_inline_name = null;
  if (v.startsWith('p:')) minister_personnel_id = v.slice(2);
  else if (v.startsWith('i:')) minister_inline_name = _rosterInline.find(x => x.id === v.slice(2))?.name || null;
  const role = document.getElementById('hb-assign-role-' + recipientId)?.value || null;
  const { error } = await withWriteRetry(() => sb.from('homebound_assignments').insert({ recipient_id: recipientId, minister_personnel_id, minister_inline_name, role }), { kind: 'create' });
  if (error) { alert('Assign failed: ' + error.message); return; }
  const nm = minister_personnel_id ? ((store.personnel || []).find(p => p.id === minister_personnel_id)?.name || 'Minister') : (minister_inline_name || 'Minister');
  logActivity({ action: 'assigned minister to recipient', entityType: 'homebound_assignment', entityName: nm, contextType: 'homebound', contextId: recipientId });
  await loadAssignments(); refreshActivePanel();
}
async function hbUnassign(assignmentId) {
  if (!isHomeboundBroad()) return;
  const { error } = await deleteWithRetry(() => sb.from('homebound_assignments').delete().eq('id', assignmentId));
  if (error) { alert('Remove failed: ' + error.message); return; }
  logActivity({ action: 'unassigned minister from recipient', entityType: 'homebound_assignment', contextType: 'homebound' });
  await loadAssignments(); refreshActivePanel();
}

// ── Shell config — Tab 1 Recipients ──────────────────────────────────────────
const homeboundConfig = {
  panelKey: 'homebound',
  title: 'Recipients',
  newLabel: '+ New',
  canManage: () => isHomeboundBroad(),
  // Settings cog → manage the shared facilities list (broad users only).
  canManageTemplate: () => isHomeboundBroad(),
  openTemplate: () => openFacilitiesManager(),

  fetchRecords: () => _recipients.filter(r => isActive(r) && canAccessHomeboundRecipient(r.id)),
  fetchRecord: (id) => _recipients.find(r => r.id === id),
  searchText: (r) => [recipientName(r), facilityName(r), r.home_city].filter(Boolean).join(' '),
  compare: (a, b) => recipientLastName(a).toLowerCase().localeCompare(recipientLastName(b).toLowerCase())
    || recipientName(a).toLowerCase().localeCompare(recipientName(b).toLowerCase()),

  // Hospital/Temporary (top, one cluster — the chip distinguishes which hospital) →
  // one group per facility (alphabetical, middle, keyed by facility_id) → Private
  // Homes (bottom).
  groupBy: (r) => r.care_type === 'hospital' ? '__hospital'
    : r.care_type === 'home' ? '__home'
      : `fac:${facKey(r)}`,
  groupLabel: (k) => k === '__hospital' ? 'Hospital / Temporary' : k === '__home' ? 'Private Homes' : facLabelFromGroupKey(k),
  groupCompare: (a, b) => {
    const rank = (k) => k === '__hospital' ? 0 : k === '__home' ? 2 : 1;
    return rank(a) - rank(b) || facLabelFromGroupKey(a).toLowerCase().localeCompare(facLabelFromGroupKey(b).toLowerCase());
  },

  listItem: (r) => ({
    title: recipientName(r),
    secondary: locationSummary(r),
    chips: [
      { label: CARE_LABEL[r.care_type] || '—', tone: r.care_type === 'hospital' ? 'urgent' : r.care_type === 'facility' ? 'active' : 'neutral' },
      ...(hasFacility(r) ? [{ label: facilityName(r), tone: 'neutral' }] : []),
    ],
  }),

  detailHeader: (r) => ({
    name: recipientName(r),
    avatarIcon: r.care_type === 'hospital' ? 'fa-hospital' : r.care_type === 'facility' ? 'fa-house-medical' : 'fa-house',
    chips: [
      { label: CARE_LABEL[r.care_type] || '—', tone: 'neutral' },
      ...(hasFacility(r) ? [{ label: facilityName(r), tone: 'neutral' }] : []),
    ],
  }),
  detailSections: [
    { title: 'Contact',          render: (r) => contactRead(r) },
    { title: 'Ministers',        render: (r) => ministersSection(r) },
    { title: 'Current Location', render: (r) => locationRead(r) },
    { title: 'Mailing Address',  render: (r) => mailingRead(r) },
  ],

  editForm: (r) => recipientFormHtml(r),
  onEditMount: () => _hbHydrateForm(document.querySelector('#sac-editform [data-hbform]')),
  saveRecord: (id) => homeboundSaveEdit(id),
  openCreate: () => openRecipientCreate(),
};

// ── Tabs + mount ──────────────────────────────────────────────────────────────
const TAB    = `padding:.5rem .9rem;font-size:13px;font-weight:500;color:#6B7280;background:none;border:none;border-bottom:2px solid transparent;cursor:pointer;font-family:'Inter',sans-serif;`;
const TAB_ON = `color:var(--navy);border-bottom-color:var(--cardinal);font-weight:600;`;

export async function loadHomebound() {
  const root = document.getElementById('homebound-root');
  if (!root) return;
  await loadHomeboundData();
  const tab = (key, label) => `<button data-hbtab="${key}" class="hb-tab" style="${TAB}${key === 'recipients' ? TAB_ON : ''}">${label}</button>`;
  root.innerHTML = `
    <div class="hb-tabbar" style="display:flex;gap:4px;border-bottom:.5px solid var(--stone);margin-bottom:1rem;">
      ${tab('recipients', 'Recipients')}
      ${tab('ministers', 'Ministers to the Sick')}
    </div>
    <div id="hb-tab-recipients"></div>
    <div id="hb-tab-ministers" style="display:none;"></div>`;
  root.querySelector('.hb-tabbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-hbtab]'); if (!b) return;
    const key = b.dataset.hbtab;
    root.querySelectorAll('.hb-tab').forEach(x => { x.style.cssText = TAB + (x.dataset.hbtab === key ? TAB_ON : ''); });
    document.getElementById('hb-tab-recipients').style.display = key === 'recipients' ? 'block' : 'none';
    document.getElementById('hb-tab-ministers').style.display  = key === 'ministers'  ? 'block' : 'none';
  });
  renderSacramentalPanel(document.getElementById('hb-tab-recipients'), homeboundConfig);
  renderRosterTab();
}

Object.assign(window, {
  _hbIdentityToggle, _hbSwapLocation, _hbFacilityChange, _hbMailingToggle,
  hbCreateSave, hbCopyAddress,
  hbFacilityAdd, hbFacilityEdit, hbFacilitySave, hbFacilityRemove, hbFacilityBack,
  _hbRosterPickChange, hbRosterAdd, hbRosterRemoveLinked, hbRosterRemoveInline,
  hbAssign, hbUnassign,
});
