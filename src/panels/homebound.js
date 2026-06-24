// ── Sick & Homebound (Pastoral Care) — Step 3a: panel shell + Tab 1 Recipients ──
// Two-tab module mounted into #homebound-root. Tab 1 ("Recipients") plugs into the
// shared sacramental master-detail shell (renderSacramentalPanel); cards group by
// care_type (Hospital/Temporary, Facilities-by-name, Private Homes). The recipient
// file is full create/edit/view — the type-driven LOCATION form (Home/Facility/
// Hospital field sets) + a SEPARATE mailing address (defaults from home, overridable)
// are the centerpiece, following the OCIA inline-type-switch + churchLocation
// locked/unlocked primitive (NOT the HR cf engine). Tab 2 ("Ministers to the Sick")
// is an empty placeholder, built in 3b. Access uses the Step 2 helpers — no new
// access logic. Facilities are NOT parish institutions (store.institutions is
// parish/school only), so facility/hospital use plain fields, not the institution
// dropdown autofill.

import { sb, withWriteRetry } from '../supabase.js';
import { store } from '../store.js';
import { logActivity } from '../utils.js';
import { renderSacramentalPanel, refreshActivePanel } from '../sacramental/panelShell.js';
import { isHomeboundBroad, canAccessHomeboundRecipient } from '../roles.js';
import { setFieldLocked } from '../sacramental/churchLocation.js';
import { closeModal } from '../ui/modal.js';
import { flashSavedThen } from '../ui/saveButton.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const CARE_LABEL   = { home: 'Home', facility: 'Facility', hospital: 'Hospital' };
const STATUS_LABEL = { active: 'Active', resolved_discharged: 'Resolved / Discharged', deceased: 'Deceased' };

// ── Data ────────────────────────────────────────────────────────────────────
let _recipients = [];
async function loadHomeboundData() {
  const { data } = await sb.from('homebound_recipients').select('*');
  _recipients = data || [];
  store.homeboundRecipients = _recipients;
  return _recipients;
}

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

function locationSummary(r) {
  if (r.care_type === 'hospital') return [r.hospital_name, r.hospital_room && 'Rm ' + r.hospital_room].filter(Boolean).join(' · ') || 'Hospital';
  if (r.care_type === 'facility') return [r.facility_name, r.facility_room_unit && 'Rm ' + r.facility_room_unit].filter(Boolean).join(' · ') || 'Facility';
  return [r.home_city, r.home_state].filter(Boolean).join(', ') || 'Home';
}

// ── Read-view section helpers ────────────────────────────────────────────────
const _line  = (l, v) => v ? `<div style="display:flex;gap:8px;font-size:13px;margin-bottom:3px;"><span style="color:#9CA3AF;min-width:96px;flex-shrink:0;">${esc(l)}</span><span style="color:var(--navy);">${esc(v)}</span></div>` : '';
const _muted = (t) => `<div style="font-size:13px;color:#9CA3AF;font-style:italic;">${esc(t)}</div>`;
const _addr  = (street, city, state, zip) => [street, [city, state].filter(Boolean).join(', '), zip].filter(Boolean).join(' · ');

function contactRead(r) {
  const rows = (r.personnel_id ? _line('Directory', recipientName(r)) : '')
    + _line('Phone', r.phone) + _line('Email', r.email)
    + _line('Status', STATUS_LABEL[r.status] || r.status);
  return rows || _muted('No contact details on file.');
}
function locationRead(r) {
  if (r.care_type === 'hospital') return (_line('Hospital', r.hospital_name) + _line('Room', r.hospital_room)) || _muted('No hospital on file.');
  if (r.care_type === 'facility') return (_line('Facility', r.facility_name) + _line('Room / Unit', r.facility_room_unit)) || _muted('No facility on file.');
  return _line('Home', _addr(r.home_street, r.home_city, r.home_state, r.home_zip)) || _muted('No home address on file.');
}
function mailingRead(r) {
  const a = _addr(r.mailing_street, r.mailing_city, r.mailing_state, r.mailing_zip);
  return a ? _line('Mailing', a) : _muted('Same as home / none on file.');
}

// ── Recipient form (shared by the inline edit form AND the create modal) ──────
// Both forms are wrapped in [data-hbform]; every field lookup is scoped to that
// wrapper (root.querySelector), so the two forms can coexist without id clashes.
const LS = `font-size:11.5px;font-weight:600;color:#6B7280;display:block;margin:.5rem 0 2px;`;
const IS = `width:100%;box-sizing:border-box;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;outline:none;`;
const SECT = `font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#9CA3AF;margin:.5rem 0 .25rem;`;
const _field = (id, label, val, type = 'text') => `<label style="${LS}">${esc(label)}</label><input type="${type}" id="${id}" value="${esc(val || '')}" style="${IS}" />`;
const _select = (id, label, options, val, onchange = '') => {
  const opts = options.map(([v, l]) => `<option value="${v}"${val === v ? ' selected' : ''}>${esc(l)}</option>`).join('');
  return `<label style="${LS}">${esc(label)}</label><select id="${id}" ${onchange} style="${IS}">${opts}</select>`;
};

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
      <div style="${SECT}">Facility</div>
      ${_field('hb-fac-name', 'Facility name', r.facility_name)}
      ${_field('hb-fac-room', 'Room / Unit', r.facility_room_unit)}
    </div>
    <div id="hb-loc-hospital" style="margin-top:.4rem;display:none;">
      <div style="${SECT}">Hospital</div>
      ${_field('hb-hosp-name', 'Hospital name', r.hospital_name)}
      ${_field('hb-hosp-room', 'Room', r.hospital_room)}
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
  ['home', 'facility', 'hospital'].forEach(t => { const x = _q(root, 'hb-loc-' + t); if (x) x.style.display = t === ct ? 'block' : 'none'; });
  if (_q(root, 'hb-mail-same')?.checked) _applyMailing(root, true);   // keep mailing tracking home
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
  ['home', 'facility', 'hospital'].forEach(t => { const x = _q(root, 'hb-loc-' + t); if (x) x.style.display = t === ct ? 'block' : 'none'; });
  // "Same as home" defaults ON when no distinct mailing address is stored.
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
    facility_name: v('hb-fac-name') || null, facility_room_unit: v('hb-fac-room') || null,
    hospital_name: v('hb-hosp-name') || null, hospital_room: v('hb-hosp-room') || null,
    mailing_street: v('hb-mail-street') || null, mailing_city: v('hb-mail-city') || null, mailing_state: v('hb-mail-state') || null, mailing_zip: v('hb-mail-zip') || null,
    updated_at: new Date().toISOString(),
  };
}

// ── Persist ───────────────────────────────────────────────────────────────────
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

// ── Shell config — Tab 1 Recipients ──────────────────────────────────────────
const homeboundConfig = {
  panelKey: 'homebound',
  title: 'Recipients',
  newLabel: '+ New',
  // Broad users manage (New + Edit); assignment-only (visits-only) users see files
  // READ-ONLY (no New, no Edit) — they only add visits, built in 3c.
  canManage: () => isHomeboundBroad(),

  // Active recipients the user may access (broad → all; assignment-only → assigned).
  // Resolved/deceased (archived_at or non-active status) are excluded here; the
  // status-filter archive group is a later sub-step.
  fetchRecords: () => _recipients.filter(r => isActive(r) && canAccessHomeboundRecipient(r.id)),
  fetchRecord: (id) => _recipients.find(r => r.id === id),
  searchText: (r) => [recipientName(r), r.facility_name, r.hospital_name, r.home_city].filter(Boolean).join(' '),
  compare: (a, b) => recipientLastName(a).toLowerCase().localeCompare(recipientLastName(b).toLowerCase())
    || recipientName(a).toLowerCase().localeCompare(recipientName(b).toLowerCase()),

  // Group: Hospital/Temporary (top) → one group per facility (alphabetical, middle)
  // → Private Homes (bottom). One group per facility mirrors the FC/Confirmation
  // church grouping; the subGroupBy path is global to all groups so it isn't used.
  groupBy: (r) => r.care_type === 'hospital' ? '__hospital'
    : r.care_type === 'home' ? '__home'
      : `fac:${(r.facility_name || 'Unnamed facility').trim()}`,
  groupLabel: (k) => k === '__hospital' ? 'Hospital / Temporary' : k === '__home' ? 'Private Homes' : k.slice(4),
  groupCompare: (a, b) => {
    const rank = (k) => k === '__hospital' ? 0 : k === '__home' ? 2 : 1;
    return rank(a) - rank(b) || a.slice(4).toLowerCase().localeCompare(b.slice(4).toLowerCase());
  },

  listItem: (r) => ({
    title: recipientName(r),
    secondary: locationSummary(r),
    chips: [{ label: CARE_LABEL[r.care_type] || '—', tone: r.care_type === 'hospital' ? 'urgent' : r.care_type === 'facility' ? 'active' : 'neutral' }],
  }),

  detailHeader: (r) => ({
    name: recipientName(r),
    avatarIcon: r.care_type === 'hospital' ? 'fa-hospital' : r.care_type === 'facility' ? 'fa-house-medical' : 'fa-house',
    chips: [{ label: CARE_LABEL[r.care_type] || '—', tone: 'neutral' }],
  }),
  detailSections: [
    { title: 'Contact',          render: (r) => contactRead(r) },
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
}

Object.assign(window, { _hbIdentityToggle, _hbSwapLocation, _hbMailingToggle, hbCreateSave });
