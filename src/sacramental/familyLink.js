// ── Shared family-member linking ────────────────────────────────────────────
// ONE reusable mechanism for grouping sacramental files into a family via the
// existing `family_group_id` column. Used today by First Communion and
// Confirmation; structured so any other file-keyed panel can register and reuse it.
//
// A panel registers an adapter (table + a few accessors); all the link/join/merge/
// unlink RULES live here, never duplicated per panel. Linking selects another FILE
// in the SAME panel/table (family_group_id does not span tables). Membership is
// MUTUAL — both files share one family_group_id and derive the same roster.
//
// Link rule (resolveFamilyLink): neither grouped → mint a new id for both; exactly
// one grouped → the other joins it; both in different groups → confirm, then merge;
// same group → no-op. Unlink clears a member; if that leaves one member, the group
// is retired (the last member is cleared too). All writes go through the existing
// retry-wrapped path; every link/unlink is logActivity'd.

import { sb, withWriteRetry, serializeWrite } from '../supabase.js';
import { logActivity } from '../utils.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const uuid = () => (crypto?.randomUUID?.() || ('fg-' + Date.now() + '-' + Math.random().toString(36).slice(2)));

// ── Panel registry ──────────────────────────────────────────────────────────
// adapter: { table, nameOf(row), getAll(), refresh(), canManage(), noun }
const _adapters = {};
export function registerFamilyPanel(key, adapter) { _adapters[key] = adapter; }
function _a(key) { return _adapters[key]; }

const SELECT_COLS = 'id, name, first_name, last_name, family_group_id';
async function _fetchOne(table, id) {
  const { data } = await sb.from(table).select(SELECT_COLS).eq('id', id).maybeSingle();
  return data || null;
}
async function _fetchGroup(table, gid) {
  if (!gid) return [];
  const { data } = await sb.from(table).select(SELECT_COLS).eq('family_group_id', gid);
  return data || [];
}

// ── Pure rule ───────────────────────────────────────────────────────────────
export function resolveFamilyLink(gidA, gidB) {
  if (gidA && gidB) return gidA === gidB ? { action: 'noop', gid: gidA } : { action: 'conflict' };
  if (gidA) return { action: 'adopt', gid: gidA };
  if (gidB) return { action: 'adopt', gid: gidB };
  return { action: 'mint' };
}

// Members of a group from an in-memory record list (excluding one id).
export function familyMembers(records, gid, excludeId) {
  if (!gid) return [];
  return (records || []).filter(r => r.family_group_id === gid && r.id !== excludeId);
}

async function _applyUpdates(table, pairs) {
  for (const [id, gid] of pairs) {
    const { error } = await serializeWrite(`${table}:${id}`, () =>
      withWriteRetry(() => sb.from(table).update({ family_group_id: gid }).eq('id', id), { kind: 'update' }));
    if (error) { alert('Family update failed: ' + error.message); return false; }
  }
  return true;
}

// ── Link two existing files (immediate; used by the viewer + post-insert add) ──
// Reads both rows fresh from the DB so it is correct even right after an insert
// (before the in-memory list reloads). Returns true when something changed.
export async function familyLink(key, idA, idB) {
  const a = _a(key); if (!a || !idA || !idB || idA === idB) return false;
  const [X, Y] = await Promise.all([_fetchOne(a.table, idA), _fetchOne(a.table, idB)]);
  if (!X || !Y) return false;
  const res = resolveFamilyLink(X.family_group_id, Y.family_group_id);
  if (res.action === 'noop') return false;

  let gid, updates;
  if (res.action === 'mint') { gid = uuid(); updates = [[X.id, gid], [Y.id, gid]]; }
  else if (res.action === 'adopt') { gid = res.gid; const joiner = X.family_group_id ? Y : X; updates = [[joiner.id, gid]]; }
  else { // conflict — confirm before merging two existing groups, naming both
    const [mA, mB] = await Promise.all([_fetchGroup(a.table, X.family_group_id), _fetchGroup(a.table, Y.family_group_id)]);
    const ok = window.confirm(
      `These two files are already in different family groups. Merge them into one?\n\n` +
      `• ${mA.map(a.nameOf).join(', ')}\n• ${mB.map(a.nameOf).join(', ')}`);
    if (!ok) return false;
    gid = X.family_group_id;
    updates = mB.map(r => [r.id, gid]);   // move all of Y's group into X's
  }
  if (!await _applyUpdates(a.table, updates)) return false;
  logActivity({ action: 'linked family member', entityType: key, entityName: `${a.nameOf(X)} ↔ ${a.nameOf(Y)}`, contextType: 'family', contextId: gid });
  return true;
}

// ── Unlink a member; retire the group if it drops to a single member ──────────
export async function familyUnlink(key, id) {
  const a = _a(key); if (!a) return false;
  const rec = await _fetchOne(a.table, id);
  if (!rec || !rec.family_group_id) return false;
  if (!window.confirm(`Remove ${a.nameOf(rec)} from this family group?`)) return false;
  const group = await _fetchGroup(a.table, rec.family_group_id);
  const others = group.filter(r => r.id !== id);
  const clears = [[id, null]];
  if (others.length === 1) clears.push([others[0].id, null]);   // last one standing → retire group
  if (!await _applyUpdates(a.table, clears)) return false;
  logActivity({ action: 'unlinked family member', entityType: key, entityName: a.nameOf(rec), contextType: 'family', contextId: rec.family_group_id });
  return true;
}

// Shared search (same table, name match), excluding self.
export async function familySearchOptions(key, q, excludeId) {
  const a = _a(key); if (!a || (q || '').trim().length < 2) return [];
  const safe = q.replace(/[%_,()'"*]/g, ' ');
  const { data } = await sb.from(a.table).select(SELECT_COLS)
    .or(`name.ilike.%${safe}%,last_name.ilike.%${safe}%,first_name.ilike.%${safe}%`).limit(8);
  return (data || []).filter(r => r.id !== excludeId);
}

// ── Read-view "Family" section (roster + unlink + link picker) ────────────────
export function familySectionHtml(key, rec) {
  const a = _a(key); if (!a) return '';
  const manage = !a.canManage || a.canManage();
  const members = familyMembers(a.getAll(), rec.family_group_id, rec.id);
  const roster = members.length
    ? members.map(m => `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px;color:var(--navy);">
        <i class="fa-solid fa-children" style="color:#9CA3AF;font-size:12px;"></i>
        <span style="flex:1;">${esc(a.nameOf(m))}</span>
        ${manage ? `<button onclick="window.famUnlink('${key}','${m.id}')" style="background:none;border:none;cursor:pointer;color:#C0392B;font-size:12px;">Unlink</button>` : ''}
      </div>`).join('')
    : `<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No linked family members.</div>`;
  const picker = manage ? `<div style="position:relative;margin-top:8px;">
      <input type="text" id="fam-search-${key}" placeholder="Link family member (search by name)…" autocomplete="off"
        oninput="window.famSearch('${key}','${rec.id}')"
        style="width:100%;box-sizing:border-box;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;" />
      <div id="fam-results-${key}" class="anl-link-results" style="display:none;"></div>
    </div>` : '';
  return roster + picker;
}

// ── Add-dialog picker (pending target, applied on insert) ─────────────────────
// The new file has no id yet, so the pick is held here and applied via familyLink
// right after insert (reusing the same rule). Keyed per panel.
const _pendingAdd = {};
export function clearPendingAdd(key) { _pendingAdd[key] = null; }
export function getPendingAdd(key) { return _pendingAdd[key] || null; }
export function familyAddPickerHtml(key) {
  return `<div style="position:relative;">
      <input type="text" id="fam-add-search-${key}" placeholder="Link family member (search by name)…" autocomplete="off"
        oninput="window.famAddSearch('${key}')"
        style="width:100%;box-sizing:border-box;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;" />
      <div id="fam-add-results-${key}" class="anl-link-results" style="display:none;"></div>
    </div>
    <div id="fam-add-chip-${key}" style="margin-top:6px;"></div>`;
}
function _renderAddChip(key) {
  const el = document.getElementById(`fam-add-chip-${key}`); if (!el) return;
  const t = _pendingAdd[key];
  el.innerHTML = t ? `<span style="display:inline-flex;align-items:center;gap:8px;background:#1C2B3A;color:#fff;border-radius:14px;padding:3px 8px 3px 12px;font-size:12px;">
      <i class="fa-solid fa-children" style="font-size:11px;"></i><span>${esc(t.name)}</span>
      <button onclick="window.famAddClear('${key}')" style="background:none;border:none;color:#cdd6df;cursor:pointer;font-size:12px;padding:0;">×</button></span>` : '';
}

// ── Shared option-list renderer for both pickers ──────────────────────────────
function _renderOptions(boxId, rows, onPickAttr) {
  const box = document.getElementById(boxId); if (!box) return;
  box.innerHTML = rows.length
    ? rows.map(r => {
        const nm = _adapterNameFromRow(r);
        return `<div class="anl-link-opt" onmousedown="event.preventDefault();${onPickAttr(r)}">${esc(nm)}${r.family_group_id ? ' · in a family' : ''}</div>`;
      }).join('')
    : `<div style="padding:.5rem .7rem;font-size:12px;color:#9CA3AF;">No matches</div>`;
  box.style.display = 'block';
}
// rows from familySearchOptions carry first/last/name; format here independent of panel.
function _adapterNameFromRow(r) {
  return (r.first_name || r.last_name) ? `${r.first_name || ''} ${r.last_name || ''}`.trim() : (r.name || '—');
}

if (typeof window !== 'undefined') {
  // Viewer picker: live search → link immediately → refresh detail.
  window.famSearch = async (key, selfId) => {
    const rows = await familySearchOptions(key, document.getElementById(`fam-search-${key}`)?.value || '', selfId);
    _renderOptions(`fam-results-${key}`, rows, (r) => `window.famPick('${key}','${selfId}','${r.id}')`);
  };
  window.famPick = async (key, selfId, targetId) => {
    const a = _a(key); const box = document.getElementById(`fam-results-${key}`); if (box) box.style.display = 'none';
    const changed = await familyLink(key, selfId, targetId);
    if (changed && a) await a.refresh();
  };
  window.famUnlink = async (key, id) => {
    const a = _a(key);
    if (await familyUnlink(key, id) && a) await a.refresh();
  };
  // Add-dialog picker: store pending target, applied on insert.
  window.famAddSearch = async (key) => {
    const rows = await familySearchOptions(key, document.getElementById(`fam-add-search-${key}`)?.value || '', null);
    _renderOptions(`fam-add-results-${key}`, rows, (r) => `window.famAddPick('${key}','${r.id}','${esc(_adapterNameFromRow(r)).replace(/'/g, "\\'")}')`);
  };
  window.famAddPick = (key, id, name) => {
    _pendingAdd[key] = { id, name };
    const box = document.getElementById(`fam-add-results-${key}`); if (box) box.style.display = 'none';
    const inp = document.getElementById(`fam-add-search-${key}`); if (inp) inp.value = '';
    _renderAddChip(key);
  };
  window.famAddClear = (key) => { _pendingAdd[key] = null; _renderAddChip(key); };
}
