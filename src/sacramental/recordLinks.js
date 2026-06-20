// ── Cross-panel record linking (mechanism B) ────────────────────────────────
// DIRECT, bidirectional pairs across OCIA / Marriage / Annulment, stored in the
// `record_links` table (one normalized row per pair, queryable from either side).
// NOT transitive. Same-type cross-panel pairs are forbidden (no OCIA↔OCIA, no
// Marriage↔Marriage); annulment↔annulment is a separate mechanism (case_group_id +
// familyLink) and never uses this table.
//
// BRIDGE RULE: when a file links to an annulment that belongs to a case-group, the
// file surfaces the WHOLE group (every case in it), not just the one linked case.
//
// Resolution is DB-driven (links + display rows + bridge are all fetched), so a linked
// record renders correctly even if its panel was never opened this session. Each panel
// registers a small adapter (display cols + chips + search + open hook); rules + the
// shared row rendering live here, reused by all three viewers.

import { sb, withWriteRetry } from '../supabase.js';
import { logActivity } from '../utils.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ── Panel registry ──────────────────────────────────────────────────────────
// adapter: { label, canManage(), openCall(id)→JS, searchTable, searchCols,
//   searchFilter(safe)→or-string, searchTitle(row), displayCols, recordTitle(row),
//   chipsHtml(row) }  — recordTitle/chipsHtml operate on a fetched DB row.
const _panels = {};
export function registerLinkPanel(type, adapter) { _panels[type] = adapter; }
const _p = (t) => _panels[t];

// Adapters register when their config module evaluates; lazy-load a config on demand so
// a foreign type resolves even before that panel was visited. (Cycle-safe: runs at
// runtime, long after recordLinks itself has finished evaluating.)
const _CONFIG = { ocia: './ociaConfig.js', marriage: './marriageConfig.js', annulment: './annulmentConfig.js' };
async function _ensure(type) {
  if (_p(type) || !_CONFIG[type]) return;
  try { await import(_CONFIG[type]); } catch (e) { console.error('[recordLinks] adapter load failed:', type, e); }
}

// Cross-panel targets per source type (same-type excluded; annulment↔annulment is A).
const CROSS = { ocia: ['marriage', 'annulment'], marriage: ['ocia', 'annulment'], annulment: ['ocia', 'marriage'] };
export function crossTypesFor(type) { return CROSS[type] || []; }

const _key = (t, id) => `${t}:${id}`;
// Normalize endpoint order by "type:id" so a pair is stored once, found from either side.
function _norm(tA, idA, tB, idB) {
  return _key(tA, idA) <= _key(tB, idB)
    ? { type_a: tA, id_a: idA, type_b: tB, id_b: idB }
    : { type_a: tB, id_a: idB, type_b: tA, id_b: idA };
}

// ── Core: link / unlink / list ───────────────────────────────────────────────
export async function linkRecords(tA, idA, tB, idB) {
  if (!tA || !tB || !idA || !idB) return false;
  if (tA === tB) { alert(`Cannot link two ${tA} records.`); return false; }   // same-type forbidden
  const n = _norm(tA, idA, tB, idB);
  // The pair unique index makes re-insert idempotent, so a transport retry is safe;
  // a 23505 means the pair already exists → treat as success (no-op).
  const { error } = await withWriteRetry(() => sb.from('record_links').insert(n), { kind: 'update' });
  if (error && error.code !== '23505') { alert('Link failed: ' + error.message); return false; }
  logActivity({ action: 'linked records', entityType: 'record_link', entityName: `${tA} ↔ ${tB}`, contextType: 'link' });
  return true;
}
export async function unlinkRecords(tA, idA, tB, idB) {
  const n = _norm(tA, idA, tB, idB);
  const { error } = await withWriteRetry(() => sb.from('record_links').delete().match(n), { kind: 'update' });
  if (error) { alert('Unlink failed: ' + error.message); return false; }
  logActivity({ action: 'unlinked records', entityType: 'record_link', entityName: `${tA} ↔ ${tB}`, contextType: 'link' });
  return true;
}
// All endpoints linked to (type,id). Direct links carry bridged:false; annulment
// case-group siblings of a linked annulment are appended with bridged:true. DB-driven
// (bridge resolved via annulment_cases) so it doesn't depend on the annulment panel
// being loaded in memory.
export async function getLinks(type, id) {
  if (!id) return [];
  const { data, error } = await sb.from('record_links').select('type_a,id_a,type_b,id_b')
    .or(`and(type_a.eq.${type},id_a.eq.${id}),and(type_b.eq.${type},id_b.eq.${id})`);
  if (error || !data) return [];
  const out = [], seen = new Set();
  const add = (t, i, bridged) => { const k = _key(t, i); if (k === _key(type, id) || seen.has(k)) return; seen.add(k); out.push({ type: t, id: i, bridged }); };
  const directAnnIds = [];
  for (const r of data) {
    const o = (r.type_a === type && r.id_a === id) ? { type: r.type_b, id: r.id_b } : { type: r.type_a, id: r.id_a };
    add(o.type, o.id, false);
    if (o.type === 'annulment') directAnnIds.push(o.id);
  }
  if (directAnnIds.length) {                          // bridge rule
    const { data: anns } = await sb.from('annulment_cases').select('id, case_group_id').in('id', directAnnIds);
    const groups = [...new Set((anns || []).map(a => a.case_group_id).filter(Boolean))];
    if (groups.length) {
      const { data: sibs } = await sb.from('annulment_cases').select('id').in('case_group_id', groups);
      (sibs || []).forEach(s => add('annulment', s.id, true));
    }
  }
  return out;
}

// ── Shared linked-row renderer (used by cross-panel AND annulment case-group) ─
// [navy circle + arrow] Title [Status][Type chips] — chips IMMEDIATELY right of the
// title; whole row clickable → opens the linked record; optional Unlink at the end.
export function linkRowHtml({ openCall, title, chipsHtml, unlinkCall, typeLabel }) {
  return `<div onclick="${openCall}" style="display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer;">
      <span style="flex-shrink:0;width:24px;height:24px;border-radius:50%;background:var(--navy);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:11px;"><i class="fa-solid fa-arrow-right"></i></span>
      <span style="color:var(--navy);font-size:13px;">${title}${typeLabel ? ` <span style="font-size:11px;color:#9CA3AF;">· ${esc(typeLabel)}</span>` : ''}</span>
      <span style="display:inline-flex;gap:4px;align-items:center;">${chipsHtml || ''}</span>
      ${unlinkCall ? `<button onclick="event.stopPropagation();${unlinkCall}" title="Unlink" style="margin-left:auto;background:none;border:none;cursor:pointer;color:#C0392B;font-size:12px;flex-shrink:0;">Unlink</button>` : ''}
    </div>`;
}

// ── Read-viewer "Linked Records" section (list + picker, async-populated) ──────
export function linkSectionHtml(selfType, selfId) {
  const a = _p(selfType); const manage = !a?.canManage || a.canManage();
  const labels = crossTypesFor(selfType).map(t => _p(t)?.label || (t[0].toUpperCase() + t.slice(1))).join(' / ');
  if (typeof window !== 'undefined') setTimeout(() => window._rlPopulate(selfType, selfId), 0);
  const picker = manage ? `<div style="position:relative;margin-top:8px;">
      <input type="text" id="rl-search-${selfType}-${selfId}" placeholder="Link a record (search ${esc(labels)} by name)…" autocomplete="off"
        oninput="window._rlSearch('${selfType}','${selfId}')"
        style="width:100%;box-sizing:border-box;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;" />
      <div id="rl-results-${selfType}-${selfId}" class="anl-link-results" style="display:none;"></div>
    </div>` : '';
  return `<div id="rl-wrap-${selfType}-${selfId}"><div style="font-size:13px;color:#9CA3AF;font-style:italic;">Loading…</div></div>${picker}`;
}

async function _searchType(type, q) {
  await _ensure(type);
  const ad = _p(type); if (!ad?.searchTable) return [];
  const safe = q.replace(/[%_,()'"*]/g, ' ');
  const { data } = await sb.from(ad.searchTable).select(ad.searchCols).or(ad.searchFilter(safe)).limit(8);
  return (data || []).map(r => ({ id: r.id, title: ad.searchTitle(r), type, label: ad.label }));
}

if (typeof window !== 'undefined') {
  window._rlPopulate = async (selfType, selfId) => {
    const wrap = document.getElementById(`rl-wrap-${selfType}-${selfId}`); if (!wrap) return;
    const a = _p(selfType); const manage = !a?.canManage || a.canManage();
    const ends = await getLinks(selfType, selfId);
    if (!ends.length) { wrap.innerHTML = `<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No linked records.</div>`; return; }
    // Batch-fetch each linked record's display row by type (so chips render without the
    // other panel being loaded), ensuring its adapter is registered first.
    const byType = {}; ends.forEach(e => { (byType[e.type] ||= []).push(e.id); });
    const rowByKey = {};
    for (const t of Object.keys(byType)) {
      await _ensure(t); const ad = _p(t); if (!ad?.displayCols) continue;
      const { data } = await sb.from(ad.searchTable).select(ad.displayCols).in('id', byType[t]);
      (data || []).forEach(r => { rowByKey[_key(t, r.id)] = r; });
    }
    const html = ends.map(e => {
      const ad = _p(e.type); const row = rowByKey[_key(e.type, e.id)]; if (!ad || !row) return '';
      return linkRowHtml({
        openCall: ad.openCall(e.id),
        title: esc(ad.recordTitle(row)),
        typeLabel: ad.label,
        chipsHtml: ad.chipsHtml(row),
        unlinkCall: (manage && !e.bridged) ? `window._rlUnlink('${selfType}','${selfId}','${e.type}','${e.id}')` : '',
      });
    }).join('');
    wrap.innerHTML = html || `<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No linked records.</div>`;
  };
  window._rlSearch = async (selfType, selfId) => {
    const q = document.getElementById(`rl-search-${selfType}-${selfId}`)?.value || '';
    const box = document.getElementById(`rl-results-${selfType}-${selfId}`); if (!box) return;
    if (q.trim().length < 2) { box.style.display = 'none'; return; }
    const lists = await Promise.all(crossTypesFor(selfType).map(t => _searchType(t, q)));
    const rows = lists.flat().slice(0, 12);
    box.innerHTML = rows.length
      ? rows.map(r => `<div class="anl-link-opt" onmousedown="event.preventDefault();window._rlPick('${selfType}','${selfId}','${r.type}','${r.id}')">${esc(r.title)} <span style="color:#9CA3AF;font-size:11px;">· ${esc(r.label)}</span></div>`).join('')
      : `<div style="padding:.5rem .7rem;font-size:12px;color:#9CA3AF;">No matches</div>`;
    box.style.display = 'block';
  };
  window._rlPick = async (selfType, selfId, t, id) => {
    const box = document.getElementById(`rl-results-${selfType}-${selfId}`); if (box) box.style.display = 'none';
    const inp = document.getElementById(`rl-search-${selfType}-${selfId}`); if (inp) inp.value = '';
    if (await linkRecords(selfType, selfId, t, id)) window._rlPopulate(selfType, selfId);
  };
  window._rlUnlink = async (selfType, selfId, t, id) => {
    if (await unlinkRecords(selfType, selfId, t, id)) window._rlPopulate(selfType, selfId);
  };
}
