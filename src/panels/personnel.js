import { sb } from '../supabase.js';
import { store } from '../store.js';
import { isAdmin, isSuperAdmin } from '../roles.js';
import { logActivity, personTitle } from '../utils.js';
import { formatPhone, normalizePhone } from '../utils/phone.js';

// Clergy/religious types appear first, in this fixed order
const CLERGY_TYPES = ['pastor', 'parochial-vicar', 'priest-in-residence', 'deacon', 'religious'];
const CLERGY_LABELS = {
  'pastor':              'Pastor',
  'parochial-vicar':     'Parochial Vicar',
  'priest-in-residence': 'Priest-in-Residence',
  'deacon':              'Deacon',
  'religious':           'Religious',
};

const EMPLOYMENT_ORDER = ['full-time', 'part-time', 'under-contract'];
const EMPLOYMENT_LABELS = {
  'full-time':      'Full-Time',
  'part-time':      'Part-Time',
  'under-contract': 'Under Contract',
};

// Clergy is a manual directory-person boolean (personnel.clergy), set in the
// Add/Edit Person dialog. It is the single source of truth for clergy-aware
// dropdowns (consumed later by the sacramental panels via getInstitutionClergy).
function isClergy(p)    { return !!p.clergy; }
function isVolunteer(p) { return !p.clergy && (p.type === 'volunteer' || p.employment === 'volunteer'); }
function isLayStaff(p)  { return !p.clergy && !isVolunteer(p); }   // catch-all for non-clergy, non-volunteer
function showsEmployment(type) { return type === 'staff'; }

const alpha = (a, b) => a.name.localeCompare(b.name);

function calcAge(dob) {
  if (!dob) return null;
  const today = new Date();
  const birth = new Date(dob + 'T12:00:00');
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

function fmtDob(dob) {
  if (!dob) return '';
  const d = new Date(dob + 'T12:00:00');
  const formatted = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const age = calcAge(dob);
  return age !== null ? `${formatted} (${age} years old)` : formatted;
}

// ── Data loading ───────────────────────────────────────────────────────────────

export async function loadPersonnel() {
  const [{ data: instData, error: instErr }, { data: persData, error: persErr }, { data: titleData }] = await Promise.all([
    sb.from('institutions').select('*').order('sort_order').order('name'),
    sb.from('personnel').select('*').neq('active', false).order('name'),
    sb.from('person_current_titles').select('*'),
  ]);
  if (instErr) console.error('[institutions]', instErr);
  if (persErr) console.error('[personnel]', persErr);
  store.institutions  = instData || [];
  store.personnel     = persData || [];
  store.personTitles  = buildPersonTitles(titleData || []);
  renderPersonnel();
}

// Shape person_current_titles rows into the map personTitle() consumes:
//   { [personId]: { byInstitution: { [instName]: title }, all: [title, ...] } }
function buildPersonTitles(rows) {
  const map = {};
  rows.forEach(r => {
    if (!map[r.person_id]) map[r.person_id] = { byInstitution: {}, all: [] };
    if (r.institution_name) map[r.person_id].byInstitution[r.institution_name] = r.title;
    if (r.title) map[r.person_id].all.push(r.title);
  });
  return map;
}

// ── Render ─────────────────────────────────────────────────────────────────────

function contactChips(p) {
  let chips = '';
  if (p.phone) chips += `<a href="tel:${normalizePhone(p.phone)}" style="display:inline-flex;align-items:center;gap:3px;font-size:11.5px;color:#8FA8BF;text-decoration:none;">📞 ${formatPhone(p.phone)}</a>`;
  if (p.email) chips += `<a href="mailto:${p.email}" style="display:inline-flex;align-items:center;gap:3px;font-size:11.5px;color:#8FA8BF;text-decoration:none;">✉️ ${p.email}</a>`;
  return chips ? `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:3px;">${chips}</div>` : '';
}

function personCard(p, instName = null) {
  const controls = isAdmin() ? `
    <div style="display:flex;gap:6px;flex-shrink:0;">
      <button class="card-action" onclick="openPersonnelModal('${p.id}')">Edit</button>
      <button class="card-action" style="color:#C0392B;" onclick="deletePersonnel('${p.id}')">Delete</button>
    </div>` : '';
  const dobLine = p.date_of_birth
    ? `<div style="font-size:11.5px;color:#9CA3AF;margin-top:2px;">🎂 ${fmtDob(p.date_of_birth)}</div>`
    : '';
  const title = personTitle(p.id, instName);
  const clergyChip = p.clergy ? ` <span class="badge badge-pending" style="vertical-align:middle;">Clergy</span>` : '';
  return `<div class="evt-item" style="cursor:default;">
    <div style="flex:1;min-width:0;">
      <div style="font-weight:500;font-size:14px;color:var(--navy);">${p.name}${clergyChip}</div>
      ${title ? `<div style="font-size:12px;color:#6B7280;margin-top:1px;">${title}</div>` : ''}
      ${dobLine}
      ${contactChips(p)}
    </div>
    ${controls}
  </div>`;
}

function sectionDivider(label, marginTop = '1rem') {
  return `<div style="display:flex;align-items:center;gap:.6rem;margin-top:${marginTop};margin-bottom:.5rem;">
    <span style="font-size:13px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.05em;">${label}</span>
    <div style="flex:1;height:1px;background:#D1D5DB;"></div>
  </div>`;
}

function groupPill(label) {
  return `<div style="font-size:10.5px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:.08em;padding:.2rem .5rem;background:#F3F4F6;border-radius:3px;display:inline-block;margin-bottom:.35rem;">${label}</div>`;
}

function renderPersonnel() {
  const el = document.getElementById('personnel-list');
  if (!el) return;
  const insts = store.institutions || [];

  // Basic users only see personnel who share a team with them
  const rawAll = store.personnel || [];
  const teamPersonnelIds = store.currentUserRoles?.teamPersonnelIds;
  const all = isAdmin() || !teamPersonnelIds
    ? rawAll
    : rawAll.filter(p => teamPersonnelIds.includes(p.id));

  if (!insts.length && !all.length) {
    el.innerHTML = '<div style="font-size:13px;color:#6B7280;padding:.5rem 0;">No institutions or personnel added yet.</div>';
    return;
  }

  let html = '';

  insts.forEach(inst => {
    const group = all.filter(p => p.institution === inst.name);

    // Fix 5: basic users skip institutions with no visible personnel
    if (!isAdmin() && !group.length) return;

    const clergy   = group.filter(isClergy);
    const layStaff = group.filter(isLayStaff);
    const hasStaff = clergy.length || layStaff.length;

    html += `<div class="card">`;

    // Fix 1: institution icon; Fix 6: cogwheel only for super_admin
    const safeId   = inst.id;
    const safeName = inst.name.replace(/'/g, "\\'");
    const instIcon = inst.icon || 'fa-building';
    const cogwheel = isSuperAdmin()
      ? `<button onclick="openInstitutionSettingsModal('${safeId}','${safeName}')" title="Institution settings" style="background:none;border:none;cursor:pointer;font-size:15px;color:#9CA3AF;padding:2px 4px;line-height:1;flex-shrink:0;" onmouseover="this.style.color='var(--navy)'" onmouseout="this.style.color='#9CA3AF'">⚙</button>`
      : '';
    html += `<div style="display:flex;align-items:center;gap:.6rem;margin-bottom:.75rem;padding-bottom:.5rem;border-bottom:2px solid var(--navy);">
      <i class="fa-solid ${instIcon}" style="font-size:17px;color:#8B1A2F;flex-shrink:0;"></i>
      <span style="font-size:17px;font-weight:700;color:var(--navy);letter-spacing:-.01em;flex:1;">${inst.name}</span>
      ${cogwheel}
    </div>`;

    if (!hasStaff) {
      html += `<div style="font-size:13px;color:#6B7280;font-style:italic;">No staff assigned to this institution.</div>`;
    }

    if (hasStaff) {
      html += sectionDivider('Staff', '0');

      // Clergy (manual boolean) sort to the TOP, flat, each with a Clergy chip.
      if (clergy.length) {
        html += `<div>`;
        html += groupPill('Clergy');
        clergy.slice().sort(alpha).forEach(p => { html += personCard(p, inst.name); });
        html += `</div>`;
      }

      EMPLOYMENT_ORDER.forEach((emp, i) => {
        const empGroup = layStaff.filter(p => p.employment === emp).sort(alpha);
        if (!empGroup.length) return;
        html += `<div style="${clergy.length || i > 0 ? 'margin-top:.75rem;' : ''}">`;
        html += groupPill(EMPLOYMENT_LABELS[emp]);
        empGroup.forEach(p => { html += personCard(p, inst.name); });
        html += `</div>`;
      });

      const unclassified = layStaff.filter(p => !p.employment).sort(alpha);
      if (unclassified.length) {
        html += `<div style="margin-top:.75rem;">`;
        html += groupPill('Other Staff');
        unclassified.forEach(p => { html += personCard(p, inst.name); });
        html += `</div>`;
      }
    }

    html += `</div>`;
  });

  // People with no matching institution (safety net — excludes volunteers, handled below)
  const instNames = new Set(insts.map(i => i.name));
  const orphans = all.filter(p => !instNames.has(p.institution) && !isVolunteer(p));
  if (orphans.length) {
    html += `<div class="card">`;
    html += `<div style="margin-bottom:.75rem;padding-bottom:.5rem;border-bottom:2px solid var(--navy);">
      <span style="font-size:17px;font-weight:700;color:var(--navy);">Unassigned</span>
    </div>`;
    orphans.sort(alpha).forEach(p => { html += personCard(p); });
    html += `</div>`;
  }

  // Volunteers section — all volunteers across all institutions, always last
  const allVolunteers = all.filter(isVolunteer).sort(alpha);
  if (allVolunteers.length) {
    html += `<div class="card">`;
    html += `<div style="display:flex;align-items:center;gap:.6rem;margin-bottom:.75rem;padding-bottom:.5rem;border-bottom:2px solid var(--navy);">
      <i class="fa-solid fa-hands-helping" style="font-size:17px;color:#8B1A2F;flex-shrink:0;"></i>
      <span style="font-size:17px;font-weight:700;color:var(--navy);">Volunteers</span>
    </div>`;
    allVolunteers.forEach(p => { html += personCard(p); });
    html += `</div>`;
  }

  el.innerHTML = html || '<div style="font-size:13px;color:#6B7280;padding:.5rem 0;">No personnel added yet.</div>';
}

// ── Institution icon picker ────────────────────────────────────────────────────

const INST_ICONS = [
  { cls: 'fa-church',              label: 'Church' },
  { cls: 'fa-school',              label: 'School' },
  { cls: 'fa-graduation-cap',      label: 'College' },
  { cls: 'fa-hospital',            label: 'Healthcare' },
  { cls: 'fa-hand-holding-heart',  label: 'Outreach' },
  { cls: 'fa-building',            label: 'General' },
  { cls: 'fa-baby',                label: 'Childcare' },
  { cls: 'fa-cross',               label: 'Religious' },
  { cls: 'fa-book-open',           label: 'Ministry' },
  { cls: 'fa-dove',                label: 'Campus' },
];

function _instIconPickerHtml(currentIcon) {
  const selected = currentIcon || 'fa-building';
  return `
    <label>Icon</label>
    <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-bottom:.85rem;">
      ${INST_ICONS.map(ic => {
        const isSel = ic.cls === selected;
        return `<button type="button" class="if-icon-btn" data-icon="${ic.cls}"
          onclick="selectInstIcon('${ic.cls}')"
          style="display:flex;flex-direction:column;align-items:center;gap:4px;padding:.55rem .2rem;
            border-radius:6px;cursor:pointer;font-family:'Inter',sans-serif;font-size:10px;
            color:${isSel ? '#C9A84C' : '#6B7280'};
            border:1.5px solid ${isSel ? '#C9A84C' : '#E2DDD6'};
            background:${isSel ? '#FEF9E7' : '#fff'};"
          title="${ic.label}">
          <i class="fa-solid ${ic.cls}" style="font-size:14px;color:${isSel ? '#C9A84C' : '#9CA3AF'};"></i>
          <span>${ic.label}</span>
        </button>`;
      }).join('')}
    </div>
    <input type="hidden" id="if-icon" value="${selected}" />`;
}

window.selectInstIcon = function(icon) {
  document.getElementById('if-icon').value = icon;
  document.querySelectorAll('.if-icon-btn').forEach(btn => {
    const sel = btn.dataset.icon === icon;
    btn.style.border = `1.5px solid ${sel ? '#C9A84C' : '#E2DDD6'}`;
    btn.style.background = sel ? '#FEF9E7' : '#fff';
    btn.style.color = sel ? '#C9A84C' : '#6B7280';
    btn.querySelector('i').style.color = sel ? '#C9A84C' : '#9CA3AF';
  });
};

// ── Institution modals ─────────────────────────────────────────────────────────

function openInstitutionModal() {
  document.getElementById('modal-content').innerHTML = `
    <div class="modal-title">Add institution</div>
    <label>Name</label><input id="if-name" placeholder="e.g. Outreach Center" />
    ${_instIconPickerHtml('fa-building')}
    <label>Sort order</label><input type="number" id="if-sort" placeholder="0" style="width:80px;" />
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" onclick="saveInstitution()">Save</button>
    </div>`;
  document.getElementById('modal-overlay').classList.add('open');
}

async function saveInstitution() {
  const name = document.getElementById('if-name').value.trim();
  if (!name) { alert('Name is required.'); return; }
  const { data, error } = await sb.from('institutions').insert({
    name,
    icon: document.getElementById('if-icon')?.value || 'fa-building',
    sort_order: parseInt(document.getElementById('if-sort').value) || 0,
  }).select('id').single();
  if (error) { alert('Save failed: ' + error.message); return; }
  // Every institution gets exactly one permanent root position automatically.
  if (data?.id) {
    await sb.from('positions').insert({ institution_id: data.id, title: 'Root Administrator', parent_position_id: null, is_administrator: true });
  }
  closeModal();
  await loadPersonnel();
}

function openInstitutionSettingsModal(id, currentName) {
  const inst = (store.institutions || []).find(i => i.id === id);
  const currentSort = inst?.sort_order ?? '';
  const currentIcon = inst?.icon || 'fa-building';
  const safeName = currentName.replace(/'/g, "\\'");
  document.getElementById('modal-content').innerHTML = `
    <div class="modal-title">Institution settings</div>
    <label>Name</label>
    <input id="if-rename" value="${currentName}" />
    ${_instIconPickerHtml(currentIcon)}
    <label>Sort order</label>
    <input type="number" id="if-sort" value="${currentSort}" placeholder="0" style="width:80px;" />
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" onclick="saveInstitutionSettings('${id}','${safeName}')">Save</button>
    </div>
    <div style="margin-top:1.25rem;padding-top:1rem;border-top:.5px solid var(--stone);">
      <div style="font-size:12px;color:#6B7280;margin-bottom:.6rem;">Deleting this institution will remove it from all personnel records. This cannot be undone.</div>
      <button class="btn-secondary" style="color:#C0392B;border-color:#C0392B;" onclick="deleteInstitution('${id}','${safeName}')">Delete institution</button>
    </div>`;
  document.getElementById('modal-overlay').classList.add('open');
}

async function saveInstitutionSettings(id, oldName) {
  const newName   = document.getElementById('if-rename').value.trim();
  const sortOrder = parseInt(document.getElementById('if-sort').value) || 0;
  const icon      = document.getElementById('if-icon')?.value || 'fa-building';
  if (!newName) { alert('Name is required.'); return; }
  const { error: instErr } = await sb.from('institutions').update({ name: newName, sort_order: sortOrder, icon }).eq('id', id);
  if (instErr) { alert('Save failed: ' + instErr.message); return; }
  if (newName !== oldName) {
    const { error: persErr } = await sb.from('personnel')
      .update({ institution: newName, updated_at: new Date().toISOString() })
      .eq('institution', oldName);
    if (persErr) { alert('Failed to update personnel records: ' + persErr.message); return; }
  }
  closeModal();
  await loadPersonnel();
}

async function deleteInstitution(id, name) {
  if (!confirm(`Deleting "${name}" will remove it from all personnel records. This cannot be undone. Continue?`)) return;
  const { error: persErr } = await sb.from('personnel')
    .update({ institution: null, updated_at: new Date().toISOString() })
    .eq('institution', name);
  if (persErr) { alert('Failed to clear personnel: ' + persErr.message); return; }
  const { error } = await sb.from('institutions').delete().eq('id', id);
  if (error) { alert('Delete failed: ' + error.message); return; }
  closeModal();
  await loadPersonnel();
}

// ── Personnel modal ────────────────────────────────────────────────────────────

function personnelForm(data) {
  const type = data?.type || 'staff';
  const inst = data?.institution || '';
  const instOptions = (store.institutions || [])
    .map(i => `<option value="${i.name}"${inst === i.name ? ' selected' : ''}>${i.name}</option>`)
    .join('');
  const isNa = !inst;
  return `<div class="modal-title">${data ? 'Edit person' : 'Add person'}</div>
  <label>Name</label><input id="pf-name" value="${data?.name || ''}" />
  <label>Date of Birth</label><input type="date" id="pf-dob" value="${data?.date_of_birth || ''}" />
  <label>Phone</label><input type="tel" id="pf-phone" value="${formatPhone(data?.phone || '')}" placeholder="e.g. (601) 555-0100" />
  <label>Email</label><input id="pf-email" value="${data?.email || ''}" />
  <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:.75rem;">
    <input type="checkbox" id="pf-clergy" ${data?.clergy ? 'checked' : ''} style="width:15px;height:15px;accent-color:var(--cardinal);" />
    Clergy <span style="font-size:11px;color:#9CA3AF;font-weight:400;">— marks this person as clergy for clergy-aware lists</span>
  </label>
  <label>Institution</label>
  <select id="pf-inst" onchange="personnelInstToggle()">
    <option value=""${isNa ? ' selected' : ''}>N/A</option>
    ${instOptions}
  </select>
  <label>Type</label>
  <select id="pf-type" onchange="personnelTypeToggle()">
    <optgroup label="Clergy &amp; Religious">
      ${CLERGY_TYPES.map(t => `<option value="${t}"${type === t ? ' selected' : ''}>${CLERGY_LABELS[t]}</option>`).join('')}
    </optgroup>
    <optgroup label="Lay">
      <option value="staff"${type === 'staff' ? ' selected' : ''}>Lay Staff</option>
      <option value="volunteer"${type === 'volunteer' ? ' selected' : ''}>Volunteer</option>
    </optgroup>
  </select>
  <div id="pf-emp-row" style="${showsEmployment(type) ? '' : 'display:none;'}">
    <label>Employment</label>
    <select id="pf-emp">
      <option value="full-time"${data?.employment === 'full-time' ? ' selected' : ''}>Full-Time</option>
      <option value="part-time"${data?.employment === 'part-time' ? ' selected' : ''}>Part-Time</option>
      <option value="under-contract"${data?.employment === 'under-contract' ? ' selected' : ''}>Under Contract</option>
    </select>
  </div>
  <label>Sort order</label><input type="number" id="pf-sort" value="${data?.sort_order ?? ''}" placeholder="0" style="width:80px;" />
  <div class="modal-actions">
    <button class="btn-secondary" onclick="closeModal()">Cancel</button>
    <button class="btn-primary" onclick="savePersonnel(${data ? `'${data.id}'` : null})">Save</button>
  </div>`;
}

function openPersonnelModal(id) {
  const data = id ? (store.personnel || []).find(p => p.id === id) : null;
  document.getElementById('modal-content').innerHTML = personnelForm(data);
  document.getElementById('modal-overlay').classList.add('open');
}

function personnelTypeToggle() {
  const type = document.getElementById('pf-type').value;
  document.getElementById('pf-emp-row').style.display = showsEmployment(type) ? '' : 'none';
}

window.personnelInstToggle = function() {
  const isNa = !document.getElementById('pf-inst').value;
  if (isNa) {
    const typeEl = document.getElementById('pf-type');
    if (typeEl) typeEl.value = 'volunteer';
    personnelTypeToggle();
  }
};

async function savePersonnel(id) {
  const type = document.getElementById('pf-type').value;
  const payload = {
    name:        document.getElementById('pf-name').value.trim(),
    phone:       normalizePhone(document.getElementById('pf-phone').value.trim()) || null,
    email:       document.getElementById('pf-email').value.trim() || null,
    institution: document.getElementById('pf-inst').value || null,
    type,
    clergy:      !!document.getElementById('pf-clergy')?.checked,
    employment:  showsEmployment(type) ? document.getElementById('pf-emp').value : null,
    date_of_birth: document.getElementById('pf-dob').value || null,
    sort_order:  parseInt(document.getElementById('pf-sort').value) || 0,
    active:      true,
    updated_at:  new Date().toISOString(),
  };
  if (!payload.name) { alert('Name is required.'); return; }
  if (id) {
    await sb.from('personnel').update(payload).eq('id', id);
    logActivity({ action: 'updated person in directory', entityType: 'personnel', entityName: payload.name, contextType: 'personnel' });
  } else {
    await sb.from('personnel').insert(payload);
    logActivity({ action: 'added person to directory', entityType: 'personnel', entityName: payload.name, contextType: 'personnel' });
  }
  closeModal();
  await loadPersonnel();
}

async function deletePersonnel(id) {
  if (!confirm('Remove this person from the directory?')) return;
  await sb.from('personnel').update({ active: false, updated_at: new Date().toISOString() }).eq('id', id);
  await loadPersonnel();
}

Object.assign(window, {
  openPersonnelModal, savePersonnel, deletePersonnel, personnelTypeToggle,
  openInstitutionModal, saveInstitution,
  openInstitutionSettingsModal, saveInstitutionSettings, deleteInstitution,
});
