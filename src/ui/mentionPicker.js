import { sb } from '../supabase.js';
import { isSuperAdmin, isAdmin, canAccessSacrament, canAccessPanel } from '../roles.js';
import { getUserScope, isVisible } from './userScope.js';
import { showToast } from './toast.js';

// ── Record-type registry ─────────────────────────────────────────────────────
// chip `type` → how to search it, label it, icon it, gate it, and open it.
// `open` is resolved at click time via window.* (panels expose these globally).
const TYPES = {
  marriage:     { table: 'couples',                 sacrament: 'marriage',        typeLabel: 'Marriage',         icon: 'fa-heart',
                  cols: ['groom', 'bride'],          label: r => `${r.groom || '?'} & ${r.bride || '?'}` },
  annulment:    { table: 'annulment_cases',         sacrament: 'annulments',      typeLabel: 'Annulment',        icon: 'fa-scale-balanced',
                  cols: ['petitioner', 'respondent'], label: r => r.respondent ? `${r.petitioner} v. ${r.respondent}` : (r.petitioner || '?') },
  ocia:         { table: 'sacramental_ocia',         sacrament: 'ocia',            typeLabel: 'OCIA',             icon: 'fa-dove',
                  cols: ['name'],                    label: r => r.name || '?' },
  baptism:      { table: 'sacramental_baptism',      sacrament: 'baptism',         typeLabel: 'Baptism',          icon: 'fa-water',
                  cols: ['name'],                    label: r => r.name || '?' },
  firstcomm:    { table: 'sacramental_firstcomm',    sacrament: 'first_communion', typeLabel: 'First Communion',  icon: 'fa-bread-slice',
                  cols: ['name'],                    label: r => r.name || '?' },
  confirmation: { table: 'sacramental_confirmation', sacrament: 'confirmation',    typeLabel: 'Confirmation',     icon: 'fa-hands-praying',
                  cols: ['name'],                    label: r => r.name || '?' },
  project:      { table: 'projects',                 project: true,                typeLabel: 'Project',          icon: 'fa-folder',
                  cols: ['title'],                   label: r => r.title || '?',  selectCols: 'id,title,created_by,team_id,assigned_to' },
};

export const MENTION_ICONS = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [k, v.icon]));

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Can the current user open a linked record of this type? (used by both the
// search filter and the chip-click gate)
export function canAccessLink(type) {
  const cfg = TYPES[type];
  if (!cfg) return true;
  if (cfg.project) return canAccessPanel('projects');
  return canAccessSacrament(cfg.sacrament);
}

// Which record types may the current user search?
function _allowedTypes() {
  return Object.keys(TYPES).filter(canAccessLink);
}

// Run the permission-filtered search across allowed types; return ≤6 ranked hits.
async function _search(query) {
  const q = query.trim();
  if (!q) return [];
  // sanitise for PostgREST ilike/or filters (drop commas, quotes, % _)
  const safe = q.replace(/[%_,()"'*]/g, ' ').trim();
  if (!safe) return [];

  const types = _allowedTypes();
  const scope = await getUserScope();

  const runs = types.map(async type => {
    const cfg = TYPES[type];
    const orExpr = cfg.cols.map(c => `${c}.ilike.%${safe}%`).join(',');
    let qb = sb.from(cfg.table).select(cfg.selectCols || '*').or(orExpr).limit(8);
    const { data, error } = await qb;
    if (error) { console.warn('[mention] search', type, error.message); return []; }
    let rows = data || [];
    if (cfg.project) rows = rows.filter(r => isVisible(r, scope));   // scope projects
    return rows.map(r => ({ type, id: r.id, label: cfg.label(r), typeLabel: cfg.typeLabel, icon: cfg.icon }));
  });

  const merged = (await Promise.all(runs)).flat();
  const lc = safe.toLowerCase();
  merged.sort((a, b) => {
    const as = a.label.toLowerCase().startsWith(lc) ? 0 : 1;
    const bs = b.label.toLowerCase().startsWith(lc) ? 0 : 1;
    return as - bs || a.label.localeCompare(b.label);
  });
  return merged.slice(0, 6);
}

// ── Picker factory ───────────────────────────────────────────────────────────
// createMentionPicker({ textarea, tray }) → { getLinks, clear, destroy, isOpen }
export function createMentionPicker({ textarea, tray }) {
  let links = [];           // [{ type, id, label }]
  let results = [];         // current dropdown hits
  let active = -1;          // highlighted index
  let tokenStart = -1;      // index of the '#' in textarea.value
  let seq = 0;              // debounce/race guard

  const dropdown = document.createElement('div');
  dropdown.className = 'mention-dropdown';
  dropdown.style.cssText = 'position:fixed;z-index:3000;display:none;background:#fff;border:.5px solid #E2DDD6;border-radius:10px;box-shadow:0 6px 24px rgba(28,43,58,.18);overflow:hidden;max-height:280px;overflow-y:auto;';
  document.body.appendChild(dropdown);

  function isOpen() { return dropdown.style.display !== 'none'; }

  function close() { dropdown.style.display = 'none'; results = []; active = -1; tokenStart = -1; }

  function position() {
    const r = textarea.getBoundingClientRect();
    dropdown.style.left = r.left + 'px';
    dropdown.style.width = r.width + 'px';
    dropdown.style.bottom = (window.innerHeight - r.top + 6) + 'px';  // open upward (composer is near bottom)
  }

  function renderDropdown(hint) {
    if (hint) {
      dropdown.innerHTML = `<div style="padding:.6rem .8rem;font-size:12px;color:#9CA3AF;font-style:italic;">${_esc(hint)}</div>`;
    } else if (!results.length) {
      dropdown.innerHTML = `<div style="padding:.6rem .8rem;font-size:12px;color:#9CA3AF;font-style:italic;">No matches</div>`;
    } else {
      dropdown.innerHTML = results.map((r, i) => `
        <div class="mention-opt${i === active ? ' active' : ''}" data-i="${i}" style="display:flex;align-items:center;gap:9px;padding:.5rem .8rem;cursor:pointer;${i === active ? 'background:#F3EFE8;' : ''}">
          <i class="fa-solid ${r.icon}" style="width:16px;text-align:center;color:#8B1A2F;font-size:13px;flex-shrink:0;"></i>
          <span style="flex:1;min-width:0;font-size:13px;color:#1C2B3A;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(r.label)}</span>
          <span style="font-size:10.5px;color:#9CA3AF;flex-shrink:0;">${_esc(r.typeLabel)}</span>
        </div>`).join('');
      dropdown.querySelectorAll('.mention-opt').forEach(opt => {
        opt.addEventListener('mousedown', e => { e.preventDefault(); select(results[+opt.dataset.i]); });
        opt.addEventListener('mouseenter', () => { active = +opt.dataset.i; paintActive(); });
      });
    }
    position();
    dropdown.style.display = 'block';
  }

  function paintActive() {
    dropdown.querySelectorAll('.mention-opt').forEach((opt, i) => {
      opt.style.background = i === active ? '#F3EFE8' : '';
      opt.classList.toggle('active', i === active);
    });
  }

  // Detect a `#query` token ending at the caret.
  function detectToken() {
    const caret = textarea.selectionStart;
    const upto = textarea.value.slice(0, caret);
    const m = upto.match(/(^|\s)#([^#\n]{0,40})$/);
    if (!m) return null;
    return { start: caret - (m[2].length + 1), query: m[2], caret };
  }

  let _t = null;
  function onInput() {
    const tok = detectToken();
    if (!tok) { if (isOpen()) close(); return; }
    tokenStart = tok.start;
    const mySeq = ++seq;
    if (!tok.query) { renderDropdown('Type to search cases & files…'); results = []; active = -1; return; }
    clearTimeout(_t);
    _t = setTimeout(async () => {
      const hits = await _search(tok.query);
      if (mySeq !== seq) return;                 // stale
      // ensure the token is still active
      const t2 = detectToken();
      if (!t2) { close(); return; }
      tokenStart = t2.start;
      results = hits;
      active = hits.length ? 0 : -1;
      renderDropdown();
    }, 180);
  }

  function onKeydown(e) {
    if (!isOpen()) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (results.length) { active = (active + 1) % results.length; paintActive(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (results.length) { active = (active - 1 + results.length) % results.length; paintActive(); } }
    else if (e.key === 'Enter') {
      if (results.length && active >= 0) { e.preventDefault(); e.stopPropagation(); select(results[active]); }
    } else if (e.key === 'Escape') { e.preventDefault(); close(); }
  }

  function select(r) {
    if (!r) return;
    // strip the "#query" token from the textarea
    const caret = textarea.selectionStart;
    if (tokenStart >= 0 && tokenStart <= caret) {
      textarea.value = textarea.value.slice(0, tokenStart) + textarea.value.slice(caret);
      const pos = tokenStart;
      textarea.setSelectionRange(pos, pos);
    }
    if (!links.find(l => l.type === r.type && l.id === r.id)) {
      links.push({ type: r.type, id: r.id, label: r.label });
      renderTray();
    }
    close();
    textarea.focus();
    textarea.dispatchEvent(new Event('input'));  // re-trigger auto-grow on host
  }

  function renderTray() {
    if (!tray) return;
    if (!links.length) { tray.innerHTML = ''; tray.style.display = 'none'; return; }
    tray.style.display = 'flex';
    tray.innerHTML = links.map((l, i) => `
      <span class="mention-chip" data-type="${_esc(l.type)}" data-id="${_esc(l.id)}" style="display:inline-flex;align-items:center;gap:6px;background:#1C2B3A;color:#fff;border-radius:14px;padding:3px 6px 3px 10px;font-size:12px;max-width:220px;">
        <i class="fa-solid ${TYPES[l.type]?.icon || 'fa-link'}" style="font-size:11px;opacity:.85;"></i>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(l.label)}</span>
        <button data-rm="${i}" title="Remove" style="background:none;border:none;color:#cdd6df;cursor:pointer;font-size:12px;line-height:1;padding:0 2px;">✕</button>
      </span>`).join('');
    tray.querySelectorAll('button[data-rm]').forEach(b => {
      b.addEventListener('click', () => { links.splice(+b.dataset.rm, 1); renderTray(); });
    });
  }

  textarea.addEventListener('input', onInput);
  textarea.addEventListener('click', onInput);
  textarea.addEventListener('keyup', e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) onInput(); });
  textarea.addEventListener('keydown', onKeydown, true);  // capture so we beat the host Enter→send
  textarea.addEventListener('blur', () => setTimeout(() => { if (isOpen()) close(); }, 150));
  window.addEventListener('scroll', () => { if (isOpen()) position(); }, true);

  return {
    getLinks() { return links.slice(); },
    clear() { links = []; renderTray(); },
    isOpen,
    destroy() {
      textarea.removeEventListener('input', onInput);
      textarea.removeEventListener('click', onInput);
      textarea.removeEventListener('keydown', onKeydown, true);
      dropdown.remove();
    },
  };
}

// ── Render helpers (message bubbles / discussion replies) ────────────────────

// Returns HTML for the link chips shown under a message body. `mine` flips chip
// colour so it reads on a navy (own) bubble.
export function renderLinkChips(metadata, { mine = false } = {}) {
  const arr = metadata && Array.isArray(metadata.links) ? metadata.links : [];
  if (!arr.length) return '';
  return `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:6px;">` + arr.map(l => {
    const allowed = canAccessLink(l.type);
    // Allowed: navy chip (or translucent on own navy bubble) with the record icon.
    // Denied: muted grey chip with a lock icon — still shows for everyone.
    const bg = allowed ? (mine ? 'rgba(255,255,255,.15)' : '#1C2B3A') : '#6B7280';
    const icon = allowed ? (MENTION_ICONS[l.type] || 'fa-link') : 'fa-lock';
    const title = allowed ? '' : ' title="You don\'t have access to this record"';
    return `
    <span class="mention-link-chip${allowed ? '' : ' denied'}"${title} onclick="event.stopPropagation();window._openLinkedRecord('${_esc(l.type)}','${_esc(l.id)}')"
      style="display:inline-flex;align-items:center;gap:6px;background:${bg};color:#fff;border-radius:13px;padding:3px 10px;font-size:11.5px;cursor:pointer;max-width:220px;">
      <i class="fa-solid ${icon}" style="font-size:10px;opacity:.9;"></i>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(l.label)}</span>
    </span>`;
  }).join('') + `</div>`;
}

// Global dispatcher: open a linked record in its panel — gated by access.
export function openLinkedRecord(type, id) {
  if (!canAccessLink(type)) {
    showToast("You don't have access to this record. Contact an administrator if you need access.", { type: 'error' });
    return;
  }
  switch (type) {
    case 'marriage':     return window.expandCouple?.(id);
    case 'annulment':    return window.expandCase?.(id);
    case 'ocia':         return window.expandOcia?.(id);
    case 'baptism':      return window.expandSacramental?.('baptism', id);
    case 'firstcomm':    return window.expandSacramental?.('firstcomm', id);
    case 'confirmation': return window.expandSacramental?.('confirmation', id);
    case 'project':      return window.showProjectDashboard?.(id);
    default: console.warn('[mention] unknown link type', type);
  }
}

if (typeof window !== 'undefined') window._openLinkedRecord = openLinkedRecord;
