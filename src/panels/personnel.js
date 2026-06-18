import { sb, withWriteRetry } from '../supabase.js';
import { store } from '../store.js';
import { isAdmin, isSuperAdmin, coordinatorChipLabels } from '../roles.js';
import { logActivity, personTitle, reportWriteError } from '../utils.js';
import { formatPhone, normalizePhone } from '../utils/phone.js';

// Institution membership and employment are DERIVED from HR (person_positions →
// positions.institution_id, plus person_positions.employment_type). HR is the
// sole owner of assignment; the directory only reads it. These are the HR
// employment tokens for the Full/Part/Contract sub-grouping (per-position).
const HR_EMP_ORDER = ['full_time', 'part_time', 'contract'];
const HR_EMP_LABELS = { full_time: 'Full-Time', part_time: 'Part-Time', contract: 'Contract' };

// Clergy is a manual directory-person boolean (personnel.clergy), set in the
// Add/Edit Person dialog. It is the single source of truth for clergy-aware
// lists, the directory clergy chip, and the clergy top-sort. (person-level)
function isClergy(p) { return !!p.clergy; }

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

// personnel.id → [coordinator label-keys] from the ACTUAL coordinator assignment
// (program_coordinators.coordinator_ids), keyed directly by personnel id — NOT
// panel access / sacramental_roles. Access != coordination.
let _coordByPersonnel = new Map();

// program_coordinators.program uses 'firstcomm'; the shared label map keys First
// Communion as 'first_communion'. Translate so the existing map (unchanged)
// resolves. Other programs already match the map keys.
const PROGRAM_TO_LABEL_KEY = { firstcomm: 'first_communion' };

// HR-derived institution membership (the directory no longer stores its own):
//   _byInstitution: institution_id → Map(personnel_id → best employment_type)
//   _personHasPosition: set of personnel_id holding ≥1 active position
// A person appears under every institution they hold an active position in;
// employment_type is per-position (best = most senior of their roles there).
let _byInstitution = new Map();
let _personHasPosition = new Set();

export async function loadPersonnel() {
  const [{ data: instData, error: instErr }, { data: persData, error: persErr }, { data: titleData }, pcRes, ppRes, posRes] = await Promise.all([
    sb.from('institutions').select('*').order('sort_order').order('name'),
    sb.from('personnel').select('*').neq('active', false).order('name'),
    sb.from('person_current_titles').select('*'),
    sb.from('program_coordinators').select('program, coordinator_ids'),
    sb.from('person_positions').select('person_id, position_id, employment_type').is('unlinked_at', null),
    sb.from('positions').select('id, institution_id').is('archived_at', null),
  ]);
  if (instErr) console.error('[institutions]', instErr);
  if (persErr) console.error('[personnel]', persErr);
  store.institutions  = instData || [];
  store.personnel     = persData || [];
  store.personTitles  = buildPersonTitles(titleData || []);

  // Build the coordinator map from the actual assignment: every personnel id in a
  // program's coordinator_ids gets that program's chip (label-key translated).
  _coordByPersonnel = new Map();
  (pcRes.data || []).forEach(row => {
    const key = PROGRAM_TO_LABEL_KEY[row.program] || row.program;
    (row.coordinator_ids || []).forEach(pid => {
      if (!_coordByPersonnel.has(pid)) _coordByPersonnel.set(pid, []);
      _coordByPersonnel.get(pid).push(key);
    });
  });

  // Derive institution membership from active HR occupancy.
  const posInst = new Map();   // active position_id → institution_id
  (posRes.data || []).forEach(po => posInst.set(po.id, po.institution_id));
  const rank = (e) => { const i = HR_EMP_ORDER.indexOf(e); return i < 0 ? 99 : i; };
  _byInstitution = new Map();
  _personHasPosition = new Set();
  (ppRes.data || []).forEach(pp => {
    const instId = posInst.get(pp.position_id);
    if (!instId) return;                       // position archived/unknown → skip
    _personHasPosition.add(pp.person_id);
    if (!_byInstitution.has(instId)) _byInstitution.set(instId, new Map());
    const m = _byInstitution.get(instId);
    const cur = m.get(pp.person_id);           // one appearance per person per institution…
    if (cur === undefined || rank(pp.employment_type) < rank(cur)) m.set(pp.person_id, pp.employment_type || null);  // …in their most-senior role there
  });

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
  // Coordinator chips: one per program the person actually coordinates
  // (program_coordinators). Wrap after the clergy chip; existing badge styling.
  const coordChips = coordinatorChipLabels(_coordByPersonnel.get(p.id))
    .map(label => ` <span class="badge badge-active" style="vertical-align:middle;">${label}</span>`).join('');
  return `<div class="evt-item" style="cursor:default;">
    <div style="flex:1;min-width:0;">
      <div style="font-weight:500;font-size:14px;color:var(--navy);">${p.name}${clergyChip}${coordChips}</div>
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

  const allById = new Map(all.map(p => [p.id, p]));
  let html = '';

  insts.forEach((inst, i) => {
    // Appearances under this institution come from HR occupancy (derived), each
    // carrying that position's employment_type. Filter to visible+active people.
    const apps = [...(_byInstitution.get(inst.id) || new Map()).entries()]
      .map(([pid, emp]) => ({ p: allById.get(pid), emp }))
      .filter(a => a.p);

    // Basic users skip institutions with no visible personnel
    if (!isAdmin() && !apps.length) return;

    const clergyApps = apps.filter(a => isClergy(a.p)).sort((a, b) => alpha(a.p, b.p));
    const layApps    = apps.filter(a => !isClergy(a.p));
    const hasStaff = clergyApps.length || layApps.length;

    html += `<div class="card">`;

    // Fix 1: institution icon; Fix 6: cogwheel only for super_admin
    const safeId   = inst.id;
    const safeName = inst.name.replace(/'/g, "\\'");
    const instIcon = inst.icon || 'fa-building';
    const cogwheel = isSuperAdmin()
      ? `<button onclick="openInstitutionSettingsModal('${safeId}','${safeName}')" title="Institution settings" style="background:none;border:none;cursor:pointer;font-size:15px;color:#9CA3AF;padding:2px 4px;line-height:1;flex-shrink:0;" onmouseover="this.style.color='var(--navy)'" onmouseout="this.style.color='#9CA3AF'">⚙</button>`
      : '';
    // Reorder controls write the SAME global institutions.sort_order HR uses.
    // Admin/super-admin only; others see the order read-only.
    const reorder = isAdmin()
      ? `<span onclick="reorderInstitutionDir('${safeId}','up')" title="Move up" style="cursor:pointer;color:#9CA3AF;padding:0 3px;font-size:14px;${i === 0 ? 'visibility:hidden;' : ''}" onmouseover="this.style.color='var(--navy)'" onmouseout="this.style.color='#9CA3AF'">▲</span>
         <span onclick="reorderInstitutionDir('${safeId}','down')" title="Move down" style="cursor:pointer;color:#9CA3AF;padding:0 3px;font-size:14px;${i === insts.length - 1 ? 'visibility:hidden;' : ''}" onmouseover="this.style.color='var(--navy)'" onmouseout="this.style.color='#9CA3AF'">▼</span>`
      : '';
    html += `<div style="display:flex;align-items:center;gap:.6rem;margin-bottom:.75rem;padding-bottom:.5rem;border-bottom:2px solid var(--navy);">
      <i class="fa-solid ${instIcon}" style="font-size:17px;color:#8B1A2F;flex-shrink:0;"></i>
      <span style="font-size:17px;font-weight:700;color:var(--navy);letter-spacing:-.01em;flex:1;">${inst.name}</span>
      ${reorder}
      ${cogwheel}
    </div>`;

    if (!hasStaff) {
      html += `<div style="font-size:13px;color:#6B7280;font-style:italic;">No staff assigned to this institution.</div>`;
    }

    if (hasStaff) {
      html += sectionDivider('Staff', '0');

      // Clergy (person-level boolean) sort to the TOP, flat, each with a Clergy chip.
      if (clergyApps.length) {
        html += `<div>`;
        html += groupPill('Clergy');
        clergyApps.forEach(a => { html += personCard(a.p, inst.name); });
        html += `</div>`;
      }

      // Employment sub-groups — per-position (derived from this appearance's type).
      HR_EMP_ORDER.forEach((emp, j) => {
        const g = layApps.filter(a => a.emp === emp).sort((a, b) => alpha(a.p, b.p));
        if (!g.length) return;
        html += `<div style="${clergyApps.length || j > 0 ? 'margin-top:.75rem;' : ''}">`;
        html += groupPill(HR_EMP_LABELS[emp]);
        g.forEach(a => { html += personCard(a.p, inst.name); });
        html += `</div>`;
      });

      const other = layApps.filter(a => !HR_EMP_ORDER.includes(a.emp)).sort((a, b) => alpha(a.p, b.p));
      if (other.length) {
        html += `<div style="margin-top:.75rem;">`;
        html += groupPill('Other Staff');
        other.forEach(a => { html += personCard(a.p, inst.name); });
        html += `</div>`;
      }
    }

    html += `</div>`;
  });

  // Volunteers = active personnel with NO active HR position. (The legacy
  // "Unassigned" orphan bucket is gone — HR is the sole source of membership.)
  const allVolunteers = all.filter(p => !_personHasPosition.has(p.id)).sort(alpha);
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
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" onclick="saveInstitution()">Save</button>
    </div>`;
  document.getElementById('modal-overlay').classList.add('open');
}

async function saveInstitution() {
  const name = document.getElementById('if-name').value.trim();
  if (!name) { alert('Name is required.'); return; }
  // New institutions append to the end of the global parish-wide order
  // (the order is arranged via the HR panel's arrows).
  const nextOrder = (store.institutions || []).reduce((m, i) => Math.max(m, i.sort_order ?? 0), -1) + 1;
  const { data, error } = await sb.from('institutions').insert({
    name,
    icon: document.getElementById('if-icon')?.value || 'fa-building',
    sort_order: nextOrder,
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
  const currentIcon = inst?.icon || 'fa-building';
  const safeName = currentName.replace(/'/g, "\\'");
  document.getElementById('modal-content').innerHTML = `
    <div class="modal-title">Institution settings</div>
    <label>Name</label>
    <input id="if-rename" value="${currentName}" />
    ${_instIconPickerHtml(currentIcon)}
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
  const newName = document.getElementById('if-rename').value.trim();
  const icon    = document.getElementById('if-icon')?.value || 'fa-building';
  if (!newName) { alert('Name is required.'); return; }
  // Order is managed by the HR arrows, not here — leave sort_order untouched.
  const { error: instErr } = await sb.from('institutions').update({ name: newName, icon }).eq('id', id);
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

// Reorder the GLOBAL parish-wide institution order (institutions.sort_order) —
// the SAME column + renumber path HR uses. One source of truth: reordering here
// is reflected in HR and vice-versa. Admin/super-admin only.
async function reorderInstitutionDir(id, dir) {
  if (!isAdmin()) return;
  const ordered = [...(store.institutions || [])];
  const idx = ordered.findIndex(i => i.id === id);
  const swap = dir === 'up' ? idx - 1 : idx + 1;
  if (idx < 0 || swap < 0 || swap >= ordered.length) return;
  [ordered[idx], ordered[swap]] = [ordered[swap], ordered[idx]];
  await Promise.all(ordered.map((inst, i) =>
    inst.sort_order === i ? null : sb.from('institutions').update({ sort_order: i }).eq('id', inst.id)
  ).filter(Boolean));
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

// Person-level fields ONLY. Institution / Type / Employment are owned by HR
// (person_positions) and are no longer set here — the directory derives them.
function personnelForm(data) {
  return `<div class="modal-title">${data ? 'Edit person' : 'Add person'}</div>
  <label>Name</label><input id="pf-name" value="${data?.name || ''}" />
  <label>Date of Birth</label><input type="date" id="pf-dob" value="${data?.date_of_birth || ''}" />
  <label>Phone</label><input type="tel" id="pf-phone" value="${formatPhone(data?.phone || '')}" placeholder="e.g. (601) 555-0100" />
  <label>Email</label><input id="pf-email" value="${data?.email || ''}" />
  <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:.75rem;">
    <input type="checkbox" id="pf-clergy" ${data?.clergy ? 'checked' : ''} style="width:15px;height:15px;accent-color:var(--cardinal);" />
    Clergy <span style="font-size:11px;color:#9CA3AF;font-weight:400;">— marks this person as clergy for clergy-aware lists</span>
  </label>
  <div style="font-size:11.5px;color:#9CA3AF;margin-top:.75rem;">Institution &amp; role are assigned in the HR panel.</div>
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

async function savePersonnel(id) {
  const payload = {
    name:        document.getElementById('pf-name').value.trim(),
    phone:       normalizePhone(document.getElementById('pf-phone').value.trim()) || null,
    email:       document.getElementById('pf-email').value.trim() || null,
    clergy:      !!document.getElementById('pf-clergy')?.checked,
    date_of_birth: document.getElementById('pf-dob').value || null,
    active:      true,
    updated_at:  new Date().toISOString(),
  };
  if (!payload.name) { alert('Name is required.'); return; }

  // Check .error on BOTH paths — a swallowed rejection used to look like success
  // (modal closed, list reloaded). Surface + log on failure; close/reload only on success.
  if (id) {
    const { error } = await withWriteRetry(() => sb.from('personnel').update(payload).eq('id', id), { kind: 'update' });
    if (error) { reportWriteError('personnel update', error); return; }
    logActivity({ action: 'updated person in directory', entityType: 'personnel', entityName: payload.name, contextType: 'personnel' });
  } else {
    // `type` is a legacy (now dead) column that may still be NOT NULL — seed a
    // harmless default on insert only so new rows are valid. The directory never
    // reads it; institution/employment are HR-owned and left unset.
    const { error } = await withWriteRetry(() => sb.from('personnel').insert({ ...payload, type: 'staff' }), { kind: 'insert' });
    if (error) { reportWriteError('personnel insert', error); return; }
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
  openPersonnelModal, savePersonnel, deletePersonnel,
  openInstitutionModal, saveInstitution,
  openInstitutionSettingsModal, saveInstitutionSettings, deleteInstitution,
  reorderInstitutionDir,
});
