// ── Shared cohort manager (Manage Cohorts) ─────────────────────────────────
// ONE implementation for the three cohort panels (First Communion / Confirmation /
// OCIA), replacing the previously-forked per-panel buildCohortHtml/saveCohort/
// deleteCohort. Each panel registers a small config (its id-prefix, panel key, date
// label, noun, coordinator names, and the panel-specific modal hooks) and invokes
// openCohortManager(panel). The shared church pre-fill/lock (cohortChurchLocation)
// is unchanged.
//
// PHASE 2 adds: a "Person Responsible for Formation" dropdown (stored to
// sacramental_cohorts.preparer) on both the create AND edit forms, and full cohort
// EDIT (date / church / formation). Editing a cohort updates ONLY the cohort row —
// it changes the DEFAULTS inherited by FUTURE file assignments and never rewrites
// church/formation already saved on existing files.

import { sb, withWriteRetry, insertWithRetry, deleteWithRetry } from '../supabase.js';
import { store } from '../store.js';
import { cohortChurchLocation } from './churchLocation.js';
import { buildPreparerField, readPreparerValue } from './preparerField.js';
import { flashSavedThen } from '../ui/saveButton.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'];

const _v = (id) => { const e = document.getElementById(id); return e ? e.value.trim() : ''; };
const _row = (...cells) => `<div style="display:flex;gap:8px;flex-wrap:wrap;">${cells.map(c => `<div style="flex:1;min-width:120px;">${c}</div>`).join('')}</div>`;
const _input = (id, label, val = '', type = 'text') => `<label>${label}</label><input type="${type}" id="${id}" value="${esc(val)}" />`;
const _stateSelect = (id, label, val = '') => `<label>${label}</label><select id="${id}"><option value="">—</option>${US_STATES.map(s => `<option${s === val ? ' selected' : ''}>${s}</option>`).join('')}</select>`;
const _sectionHead = (t) => `<div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--cardinal);margin:1.4rem 0 .5rem;border-bottom:.5px solid var(--stone);padding-bottom:4px;">${t}</div>`;

function cohortLabel(dateStr) { if (!dateStr) return 'No date'; const d = new Date(dateStr + 'T00:00:00'); return isNaN(d) ? 'No date' : d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); }
function cohortChurchName(coh) {
  if (!coh) return '';
  if (coh.church_institution_id) { const i = (store.institutions || []).find(x => x.id === coh.church_institution_id); if (i) return i.name; }
  return coh.church_override || '';
}

// panel → config. cfg: { panel, idPrefix, dateLabel, stateLabel, noun, pluralNoun,
//   deleteNote, coordinatorNames(), getCohorts(), getRecords(), open(html), close(),
//   reloadCohorts(), refresh() }
const _reg = {};
export function registerCohortManager(cfg) { _reg[cfg.panel] = cfg; }
export function openCohortManager(panel) { const cfg = _reg[panel]; if (cfg) cfg.open(buildHtml(cfg)); }

// buildHtml(cfg, editCoh?) — editCoh null → "New Cohort" create form; a cohort object
// → "Edit Cohort" form pre-filled with that cohort. Both forms carry the same fields
// (date, church, city/state, formation person).
function buildHtml(cfg, editCoh = null) {
  const P = cfg.idPrefix;
  const cohorts = cfg.getCohorts() || [];
  const recs = cfg.getRecords() || [];
  const coordNames = cfg.coordinatorNames ? (cfg.coordinatorNames() || []) : [];
  const counts = {}; recs.forEach(p => { if (p.cohort_id) counts[p.cohort_id] = (counts[p.cohort_id] || 0) + 1; });
  const plural = (n) => (n === 1 ? cfg.noun : (cfg.pluralNoun || cfg.noun + 's'));
  const metaLine = (c) => [esc(cohortChurchName(c) || '—'), `${counts[c.id] || 0} ${plural(counts[c.id] || 0)}`, c.preparer ? esc(c.preparer) : null].filter(Boolean).join(' · ');
  const list = cohorts.length ? cohorts.map(c => `<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:.5px solid var(--stone);">
      <div style="flex:1;"><div style="font-size:14px;font-weight:600;color:var(--navy);">${cohortLabel(c.cohort_date)}</div><div style="font-size:12px;color:#6B7280;">${metaLine(c)}</div></div>
      <button onclick="cohortMgrEdit('${cfg.panel}','${c.id}')" class="btn-secondary" style="padding:.3rem .7rem;font-size:12px;">Edit</button>
      <button onclick="cohortMgrDelete('${cfg.panel}','${c.id}')" class="btn-delete" style="padding:.3rem .7rem;font-size:12px;">Delete</button>
    </div>`).join('') : `<div style="font-size:13px;color:#9CA3AF;font-style:italic;padding:.5rem 0;">No cohorts yet.</div>`;

  const editing = !!editCoh;
  const churchId = editCoh && editCoh.church_institution_id ? editCoh.church_institution_id : '';
  const isOther = editing && !churchId && !!editCoh.church_override;
  const instOpts = (store.institutions || []).map(i => `<option value="${i.id}"${i.id === churchId ? ' selected' : ''}>${esc(i.name)}</option>`).join('');
  const preparerHtml = buildPreparerField(`${P}-preparer`, editing ? (editCoh.preparer || '') : '', { coordinatorNames: coordNames, label: 'Person Responsible for Formation' });

  const form = `${_sectionHead(editing ? 'Edit Cohort' : 'New Cohort')}
    ${_input(`${P}-date`, cfg.dateLabel, editing ? (editCoh.cohort_date || '') : '', 'date')}
    <label>Church</label><select id="${P}-church" onchange="cohortMgrChurchChange('${P}',this.value)"><option value="">— Select —</option>${instOpts}<option value="__other"${isOther ? ' selected' : ''}>Other…</option></select>
    <div id="${P}-other-wrap" style="display:${isOther ? 'block' : 'none'};">${_input(`${P}-church-name`, 'Church name', isOther ? (editCoh.church_override || '') : '')}</div>
    ${_row(_input(`${P}-city`, 'City', editing ? (editCoh.church_city || '') : ''), _stateSelect(`${P}-state`, cfg.stateLabel || 'State', editing ? (editCoh.church_state || '') : ''))}
    ${preparerHtml}
    <div class="modal-actions">
      ${editing ? `<button class="btn-secondary" onclick="cohortMgrCancelEdit('${cfg.panel}')">Cancel</button><button class="btn-primary" onclick="cohortMgrUpdate('${cfg.panel}','${editCoh.id}')">Save Changes</button>`
                : `<button class="btn-secondary" onclick="cohortMgrClose('${cfg.panel}')">Close</button><button class="btn-primary" onclick="cohortMgrSave('${cfg.panel}')">+ Add Cohort</button>`}
    </div>`;

  return `<div class="modal-title">Manage Cohorts</div>
    ${list}
    ${form}`;
}

// Read the cohort form fields into a write payload (shared by save + update).
function _readCohortForm(P) {
  const churchSel = document.getElementById(`${P}-church`)?.value || '';
  return {
    cohort_date: _v(`${P}-date`),
    church_institution_id: churchSel && churchSel !== '__other' ? churchSel : null,
    church_override: churchSel === '__other' ? (_v(`${P}-church-name`) || null) : null,
    church_city: _v(`${P}-city`) || null,
    church_state: _v(`${P}-state`) || null,
    preparer: readPreparerValue(`${P}-preparer`),
  };
}

if (typeof window !== 'undefined') {
  window.openCohortManager = openCohortManager;   // configs call window.openCohortManager(panel)
  window.cohortMgrChurchChange = (prefix, v) => cohortChurchLocation(v, prefix);
  window.cohortMgrClose = (panel) => _reg[panel]?.close();
  window.cohortMgrCancelEdit = (panel) => { const cfg = _reg[panel]; if (cfg) cfg.open(buildHtml(cfg)); };

  window.cohortMgrSave = async (panel) => {
    const cfg = _reg[panel]; if (!cfg) return; const P = cfg.idPrefix;
    const fields = _readCohortForm(P);
    if (!fields.cohort_date) { alert(`${cfg.dateLabel} is required.`); return; }
    const { error } = await insertWithRetry('sacramental_cohorts', { panel, ...fields });
    if (error) { alert('Save failed: ' + error.message); return; }
    await cfg.reloadCohorts(); flashSavedThen(() => cfg.open(buildHtml(cfg)));
  };

  // EDIT: re-open the manager with the chosen cohort pre-filled. Post-render we apply
  // the listed-church city/state lock (the inline render shows values but can't run the
  // lock styling). Updating changes DEFAULTS for future assignments only.
  window.cohortMgrEdit = (panel, id) => {
    const cfg = _reg[panel]; if (!cfg) return;
    const coh = (cfg.getCohorts() || []).find(c => c.id === id); if (!coh) return;
    cfg.open(buildHtml(cfg, coh));
    if (coh.church_institution_id) cohortChurchLocation(coh.church_institution_id, cfg.idPrefix);
  };

  window.cohortMgrUpdate = async (panel, id) => {
    const cfg = _reg[panel]; if (!cfg) return; const P = cfg.idPrefix;
    const fields = _readCohortForm(P);
    if (!fields.cohort_date) { alert(`${cfg.dateLabel} is required.`); return; }
    // Update ONLY the cohort row — existing files keep their saved church/formation.
    const { error } = await withWriteRetry(() => sb.from('sacramental_cohorts').update(fields).eq('id', id), { kind: 'update' });
    if (error) { alert('Save failed: ' + error.message); return; }
    await cfg.reloadCohorts(); flashSavedThen(() => { cfg.open(buildHtml(cfg)); cfg.refresh(); });
  };

  window.cohortMgrDelete = async (panel, id) => {
    const cfg = _reg[panel]; if (!cfg) return;
    if (!confirm(`Delete this cohort? ${cfg.deleteNote || 'Records keep their data but lose the cohort link.'}`)) return;
    const { error } = await deleteWithRetry(() => sb.from('sacramental_cohorts').delete().eq('id', id));
    if (error) { alert('Delete failed: ' + error.message); return; }
    await cfg.reloadCohorts(); cfg.open(buildHtml(cfg)); cfg.refresh();
  };
}
