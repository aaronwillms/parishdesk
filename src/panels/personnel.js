import { sb } from '../supabase.js';
import { store } from '../store.js';
import { isAdmin, isSuperAdmin } from '../roles.js';
import { logActivity, isPersonClergy, personEntries, personDerivedType } from '../utils.js';

// Lay employment headings (values come from the HR resolver's employment_heading,
// strongest-commitment order). These are HR's underscore values, not the old
// hyphenated personnel.employment column.
const EMP_HEADINGS = [['full_time', 'Full-Time'], ['part_time', 'Part-Time'], ['contract', 'Contract']];
const EMP_LABEL = { full_time: 'Full-Time', part_time: 'Part-Time', contract: 'Contract' };

// Placement is now HR-derived (see utils: isPersonClergy / personEntries).
function isVolunteer(p)  { return personDerivedType(p.id) === 'volunteer'; }

const alpha = (a, b) => (a.name || '').localeCompare(b.name || '');

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
  const [{ data: instData, error: instErr }, { data: persData, error: persErr }, { data: placeData }, { data: dirData }] = await Promise.all([
    sb.from('institutions').select('*').order('sort_order').order('name'),
    sb.from('personnel').select('*').neq('active', false).order('name'),
    sb.from('person_placement').select('*'),
    sb.from('person_directory').select('*'),
  ]);
  if (instErr) console.error('[institutions]', instErr);
  if (persErr) console.error('[personnel]', persErr);
  store.institutions     = instData || [];
  store.personnel        = persData || [];
  store.personPlacement  = buildPlacement(placeData || []);
  store.personDirectory  = buildDirectory(dirData || []);
  renderPersonnel();
}

// person_placement rows → { [personId]: { isClergy, hasPosition, derivedType } }
function buildPlacement(rows) {
  const map = {};
  rows.forEach(r => { map[r.person_id] = { isClergy: !!r.is_clergy, hasPosition: !!r.has_position, derivedType: r.derived_type || 'volunteer' }; });
  return map;
}
// person_directory rows → { [personId]: [ entry, ... ] }
function buildDirectory(rows) {
  const map = {};
  rows.forEach(r => { (map[r.person_id] = map[r.person_id] || []).push(r); });
  return map;
}

// ── Render ─────────────────────────────────────────────────────────────────────

function contactChips(p) {
  let chips = '';
  if (p.phone) chips += `<a href="tel:${p.phone}" style="display:inline-flex;align-items:center;gap:3px;font-size:11.5px;color:#8FA8BF;text-decoration:none;">📞 ${p.phone}</a>`;
  if (p.email) chips += `<a href="mailto:${p.email}" style="display:inline-flex;align-items:center;gap:3px;font-size:11.5px;color:#8FA8BF;text-decoration:none;">✉️ ${p.email}</a>`;
  return chips ? `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:3px;">${chips}</div>` : '';
}

function personCard(p, title = '') {
  const controls = isAdmin() ? `
    <div style="display:flex;gap:6px;flex-shrink:0;">
      <button class="card-action" onclick="openPersonnelModal('${p.id}')">Edit</button>
      <button class="card-action" style="color:#C0392B;" onclick="deletePersonnel('${p.id}')">Delete</button>
    </div>` : '';
  const dobLine = p.date_of_birth
    ? `<div style="font-size:11.5px;color:#9CA3AF;margin-top:2px;">🎂 ${fmtDob(p.date_of_birth)}</div>`
    : '';
  return `<div class="evt-item" style="cursor:default;">
    <div style="flex:1;min-width:0;">
      <div style="font-weight:500;font-size:14px;color:var(--navy);">${p.name}</div>
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

  const byId = new Map(all.map(p => [p.id, p]));
  // Build the per-institution directory entries the viewer may see, split by the
  // PERSON-level clergy rollup (clergy wins at the person level → all of a
  // clergy person's entries file under Clergy, never Lay).
  const clergyByInst = {};   // instName -> [{ p, title }]
  const layByInst = {};      // instName -> { full_time:[], part_time:[], contract:[], __other:[] }
  all.forEach(p => {
    const clergy = isPersonClergy(p.id);
    personEntries(p.id).forEach(e => {
      const inst = e.institution_name || '—';
      if (clergy) {
        (clergyByInst[inst] = clergyByInst[inst] || []).push({ p, title: e.title || '' });
      } else {
        const buckets = (layByInst[inst] = layByInst[inst] || { full_time: [], part_time: [], contract: [], __other: [] });
        (buckets[e.employment_heading] || buckets.__other).push({ p, title: e.title || '' });
      }
    });
  });

  const instHeading = (name, icon, cog = '') => `<div style="display:flex;align-items:center;gap:.6rem;margin-bottom:.75rem;padding-bottom:.5rem;border-bottom:2px solid var(--navy);">
      <i class="fa-solid ${icon}" style="font-size:17px;color:#8B1A2F;flex-shrink:0;"></i>
      <span style="font-size:17px;font-weight:700;color:var(--navy);letter-spacing:-.01em;flex:1;">${name}</span>${cog}
    </div>`;
  const sortEntries = (arr) => arr.sort((a, b) => alpha(a.p, b.p));
  const instIconOf = (name) => (insts.find(i => i.name === name)?.icon) || 'fa-building';
  const cogOf = (name) => {
    if (!isSuperAdmin()) return '';
    const inst = insts.find(i => i.name === name); if (!inst) return '';
    const safeName = inst.name.replace(/'/g, "\\'");
    return `<button onclick="openInstitutionSettingsModal('${inst.id}','${safeName}')" title="Institution settings" style="background:none;border:none;cursor:pointer;font-size:15px;color:#9CA3AF;padding:2px 4px;line-height:1;flex-shrink:0;" onmouseover="this.style.color='var(--navy)'" onmouseout="this.style.color='#9CA3AF'">⚙</button>`;
  };

  let html = '';

  // ── CLERGY (top): institution + title(s), no employment grouping ──────────
  const clergyInsts = Object.keys(clergyByInst).sort();
  if (clergyInsts.length) {
    html += `<div class="card">`;
    html += instHeading('Clergy', 'fa-cross');
    clergyInsts.forEach((inst, i) => {
      html += `<div style="${i > 0 ? 'margin-top:.75rem;' : ''}">`;
      html += groupPill(inst);
      sortEntries(clergyByInst[inst]).forEach(({ p, title }) => { html += personCard(p, title); });
      html += `</div>`;
    });
    html += `</div>`;
  }

  // ── LAY STAFF: by institution → employment heading ────────────────────────
  // Institution order follows store.institutions, then any extras alphabetically.
  const layInstNames = Object.keys(layByInst);
  const orderedLay = [...insts.map(i => i.name).filter(n => layByInst[n]),
                      ...layInstNames.filter(n => !insts.some(i => i.name === n)).sort()];
  orderedLay.forEach(inst => {
    const buckets = layByInst[inst];
    html += `<div class="card">`;
    html += instHeading(inst, instIconOf(inst), cogOf(inst));
    let first = true;
    EMP_HEADINGS.forEach(([key, label]) => {
      const grp = buckets[key]; if (!grp.length) return;
      html += `<div style="${first ? '' : 'margin-top:.75rem;'}">`; first = false;
      html += groupPill(label);
      sortEntries(grp).forEach(({ p, title }) => { html += personCard(p, title); });
      html += `</div>`;
    });
    if (buckets.__other.length) {
      html += `<div style="${first ? '' : 'margin-top:.75rem;'}">`;
      html += groupPill('Other Staff');
      sortEntries(buckets.__other).forEach(({ p, title }) => { html += personCard(p, title); });
      html += `</div>`;
    }
    html += `</div>`;
  });

  // ── VOLUNTEERS / NON-POSITIONED (bottom): flat, no institution/employment ──
  const allVolunteers = all.filter(p => !isPersonClergy(p.id) && !personEntries(p.id).length).sort(alpha);
  if (allVolunteers.length) {
    html += `<div class="card">`;
    html += instHeading('Volunteers', 'fa-hands-helping');
    allVolunteers.forEach(p => { html += personCard(p); });
    html += `</div>`;
  }

  el.innerHTML = html || '<div style="font-size:13px;color:#6B7280;padding:.5rem 0;">No personnel yet.</div>';
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
  const { error } = await sb.from('institutions').insert({
    name,
    icon: document.getElementById('if-icon')?.value || 'fa-building',
    sort_order: parseInt(document.getElementById('if-sort').value) || 0,
  });
  if (error) { alert('Save failed: ' + error.message); return; }
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
  // Renaming the institution is enough — placement derives from HR (positions
  // reference institutions by FK), so the directory updates live. (oldName kept
  // for signature compatibility.)
  void oldName;
  const { error: instErr } = await sb.from('institutions').update({ name: newName, sort_order: sortOrder, icon }).eq('id', id);
  if (instErr) { alert('Save failed: ' + instErr.message); return; }
  closeModal();
  await loadPersonnel();
}

async function deleteInstitution(id, name) {
  if (!confirm(`Delete "${name}"? Its HR positions and their occupancies are removed too (FK cascade). This cannot be undone. Continue?`)) return;
  const { error } = await sb.from('institutions').delete().eq('id', id);
  if (error) { alert('Delete failed: ' + error.message); return; }
  closeModal();
  await loadPersonnel();
}

// ── Personnel modal ────────────────────────────────────────────────────────────

function personnelForm(data) {
  // Identity + contact only. Organizational placement (institution / type /
  // employment / clergy-or-lay) is HR-derived — set by assigning a POSITION in
  // Human Resources — and shown here read-only when editing.
  return `<div class="modal-title">${data ? 'Edit person' : 'Add person'}</div>
  <label>Name</label><input id="pf-name" value="${data?.name || ''}" />
  <label>Date of Birth</label><input type="date" id="pf-dob" value="${data?.date_of_birth || ''}" />
  <label>Phone</label><input id="pf-phone" value="${data?.phone || ''}" placeholder="e.g. (601) 555-0100" />
  <label>Email</label><input id="pf-email" value="${data?.email || ''}" />
  <label>Sort order</label><input type="number" id="pf-sort" value="${data?.sort_order ?? ''}" placeholder="0" style="width:80px;" />
  ${data ? derivedPlacementHtml(data) : ''}
  <div class="modal-actions">
    <button class="btn-secondary" onclick="closeModal()">Cancel</button>
    <button class="btn-primary" onclick="savePersonnel(${data ? `'${data.id}'` : null})">Save</button>
  </div>`;
}

// Read-only HR-derived placement, shown when editing an existing person.
function derivedPlacementHtml(p) {
  const type = personDerivedType(p.id);
  const clergy = isPersonClergy(p.id);
  const typeLabel = type === 'clergy' ? 'Clergy' : type === 'staff' ? 'Lay Staff' : 'Volunteer';
  const entries = personEntries(p.id);
  const rows = entries.length
    ? entries.map(e => `<div style="font-size:12.5px;color:#374151;padding:2px 0;">${e.institution_name || '—'} — ${e.title || '(no title)'}${(!clergy && e.employment_heading) ? ` · ${EMP_LABEL[e.employment_heading] || e.employment_heading}` : ''}</div>`).join('')
    : '<div style="font-size:12.5px;color:#9CA3AF;font-style:italic;">No HR position — appears under Volunteers.</div>';
  return `<div style="margin-top:1rem;padding-top:.75rem;border-top:.5px solid var(--stone);">
    <div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#9CA3AF;margin-bottom:.3rem;">Placement (from Human Resources)</div>
    <div style="font-size:12.5px;color:var(--navy);font-weight:600;margin-bottom:.25rem;">${typeLabel}</div>
    ${rows}
    <div style="font-size:11px;color:#9CA3AF;margin-top:.4rem;">Set placement by assigning this person a position in Human Resources.</div>
  </div>`;
}

function openPersonnelModal(id) {
  const data = id ? (store.personnel || []).find(p => p.id === id) : null;
  document.getElementById('modal-content').innerHTML = personnelForm(data);
  document.getElementById('modal-overlay').classList.add('open');
}

async function savePersonnel(id) {
  // Identity + contact only — organizational placement is HR-derived.
  const payload = {
    name:        document.getElementById('pf-name').value.trim(),
    phone:       document.getElementById('pf-phone').value.trim() || null,
    email:       document.getElementById('pf-email').value.trim() || null,
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
  openPersonnelModal, savePersonnel, deletePersonnel,
  openInstitutionModal, saveInstitution,
  openInstitutionSettingsModal, saveInstitutionSettings, deleteInstitution,
});
