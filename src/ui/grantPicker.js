// ── '%' grant controller (chat compose surface) ─────────────────────────────
// Mirrors mentionPicker's '#' affordance, but instead of attaching a label it
// CREATES a record_grants row (the access) and drops an inline CONTROLLER link
// into the message. The link is NOT the grant — access lives in the row, so
// deleting the message never removes access. Super-admin only.

import { sb } from '../supabase.js';
import { isSuperAdmin } from '../roles.js';
import { closeModal } from './modal.js';
import { showToast } from './toast.js';
import {
  searchGrantableRecords, grantableUsers, writeGrant, revokeGrant, setGrantNote, recordTypeLabel,
} from './grants.js';

function _esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Session set of grant ids revoked in this session — controller links flip to an
// inert "revoked" state. (The audit view is the source of truth across reloads;
// the controller is only a convenience surface.)
const _revoked = new Set();

// ── Picker factory ──────────────────────────────────────────────────────────
// createGrantPicker({ textarea, tray }) → { getGrants, clear, isOpen, destroy }
export function createGrantPicker({ textarea, tray }) {
  let grants = [];          // [{ grant_id, record_type, record_id, granted_to, label }]
  let results = [];
  let active = -1;
  let tokenStart = -1;
  let seq = 0;
  let _t = null;

  const dropdown = document.createElement('div');
  dropdown.className = 'grant-dropdown';
  dropdown.style.cssText = 'position:fixed;z-index:3000;display:none;background:#fff;border:.5px solid #E2DDD6;border-radius:10px;box-shadow:0 6px 24px rgba(28,43,58,.18);overflow:hidden;max-height:280px;overflow-y:auto;';
  document.body.appendChild(dropdown);

  function isOpen() { return dropdown.style.display !== 'none'; }
  function close() { dropdown.style.display = 'none'; results = []; active = -1; tokenStart = -1; }

  function position() {
    const r = textarea.getBoundingClientRect();
    dropdown.style.left = r.left + 'px';
    dropdown.style.width = r.width + 'px';
    dropdown.style.bottom = (window.innerHeight - r.top + 6) + 'px';
  }

  function renderDropdown(hint) {
    if (hint) {
      dropdown.innerHTML = `<div style="padding:.6rem .8rem;font-size:12px;color:#9CA3AF;font-style:italic;">${_esc(hint)}</div>`;
    } else if (!results.length) {
      dropdown.innerHTML = `<div style="padding:.6rem .8rem;font-size:12px;color:#9CA3AF;font-style:italic;">No grantable records</div>`;
    } else {
      dropdown.innerHTML = results.map((r, i) => `
        <div class="grant-opt" data-i="${i}" style="display:flex;align-items:center;gap:9px;padding:.5rem .8rem;cursor:pointer;${i === active ? 'background:#F3EFE8;' : ''}">
          <i class="fa-solid fa-key" style="width:16px;text-align:center;color:#8B1A2F;font-size:12px;flex-shrink:0;"></i>
          <span style="flex:1;min-width:0;font-size:13px;color:#1C2B3A;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(r.label)}</span>
        </div>`).join('');
      dropdown.querySelectorAll('.grant-opt').forEach(opt => {
        opt.addEventListener('mousedown', e => { e.preventDefault(); choose(results[+opt.dataset.i]); });
        opt.addEventListener('mouseenter', () => { active = +opt.dataset.i; paint(); });
      });
    }
    position();
    dropdown.style.display = 'block';
  }
  function paint() {
    dropdown.querySelectorAll('.grant-opt').forEach((opt, i) => { opt.style.background = i === active ? '#F3EFE8' : ''; });
  }

  // Detect a `%query` token ending at the caret (super-admin only).
  function detectToken() {
    if (!isSuperAdmin()) return null;
    const caret = textarea.selectionStart;
    const upto = textarea.value.slice(0, caret);
    const m = upto.match(/(^|\s)%([^%\n]{0,40})$/);
    if (!m) return null;
    return { start: caret - (m[2].length + 1), query: m[2], caret };
  }

  function onInput() {
    const tok = detectToken();
    if (!tok) { if (isOpen()) close(); return; }
    tokenStart = tok.start;
    const mySeq = ++seq;
    if (!tok.query) { renderDropdown('Type a name to grant access to their record…'); results = []; active = -1; return; }
    clearTimeout(_t);
    _t = setTimeout(async () => {
      const hits = await searchGrantableRecords(tok.query);
      if (mySeq !== seq) return;
      const t2 = detectToken();
      if (!t2) { close(); return; }
      tokenStart = t2.start;
      results = hits; active = hits.length ? 0 : -1;
      renderDropdown();
    }, 200);
  }
  function onKeydown(e) {
    if (!isOpen()) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (results.length) { active = (active + 1) % results.length; paint(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (results.length) { active = (active - 1 + results.length) % results.length; paint(); } }
    else if (e.key === 'Enter') { if (results.length && active >= 0) { e.preventDefault(); e.stopPropagation(); choose(results[active]); } }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  }

  // Selecting a record → strip the token, then open the grantee/note modal.
  function choose(r) {
    if (!r) return;
    const caret = textarea.selectionStart;
    if (tokenStart >= 0 && tokenStart <= caret) {
      textarea.value = textarea.value.slice(0, tokenStart) + textarea.value.slice(caret);
      textarea.setSelectionRange(tokenStart, tokenStart);
    }
    close();
    openGranteeModal(r);
  }

  async function openGranteeModal(rec) {
    const users = await grantableUsers();
    const opts = users.map(u => `<option value="${u.userId}">${_esc(u.name)}</option>`).join('');
    document.getElementById('modal-content').innerHTML = `
      <div class="modal-title">Grant access</div>
      <div style="font-size:13px;color:var(--navy);font-weight:600;margin-bottom:.6rem;">${_esc(rec.label)}</div>
      <label>Grant to</label>
      <select id="gp-user">${opts ? `<option value="" selected disabled>— Select a recipient —</option>${opts}` : '<option value="">No grantable users</option>'}</select>
      <label>Reason (optional)</label>
      <textarea id="gp-note" rows="2" placeholder="Why this person needs access"></textarea>
      <div style="font-size:11px;color:#9CA3AF;margin-top:.3rem;">A grant is user + file specific. The message link only controls it — deleting the message never removes access.</div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="closeModal()">Cancel</button>
        <button class="btn-primary" id="gp-confirm">Grant access</button>
      </div>`;
    document.getElementById('modal-overlay').classList.add('open');
    document.getElementById('gp-confirm')?.addEventListener('click', async () => {
      const grantedTo = document.getElementById('gp-user').value;
      if (!grantedTo) { alert('Select a user.'); return; }
      const note = document.getElementById('gp-note').value.trim() || null;
      const { data: { user } } = await sb.auth.getUser();
      const { data, error } = await writeGrant({
        recordType: rec.record_type, recordId: rec.record_id, grantedTo, grantedBy: user?.id, note,
      });
      if (error) { alert('Grant failed: ' + error.message); return; }
      grants.push({ grant_id: data.id, record_type: rec.record_type, record_id: rec.record_id, granted_to: grantedTo, label: rec.label });
      renderTray();
      window.flashSavedThen(() => { closeModal(); textarea.focus(); });
    });
  }

  function renderTray() {
    if (!tray) return;
    if (!grants.length) { tray.innerHTML = ''; tray.style.display = 'none'; return; }
    tray.style.display = 'flex';
    tray.innerHTML = grants.map((g, i) => `
      <span style="display:inline-flex;align-items:center;gap:6px;background:#5B4A8A;color:#fff;border-radius:14px;padding:3px 6px 3px 10px;font-size:12px;max-width:260px;">
        <i class="fa-solid fa-key" style="font-size:10px;opacity:.85;"></i>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(g.label)}</span>
        <button data-rm="${i}" title="Remove controller (keeps access)" style="background:none;border:none;color:#d6cdf0;cursor:pointer;font-size:12px;line-height:1;padding:0 2px;">✕</button>
      </span>`).join('');
    tray.querySelectorAll('button[data-rm]').forEach(b => {
      // Removing the chip only drops the controller link from THIS draft — the
      // record_grants row persists (manage/revoke via the audit view).
      b.addEventListener('click', () => { grants.splice(+b.dataset.rm, 1); renderTray(); });
    });
  }

  textarea.addEventListener('input', onInput);
  textarea.addEventListener('click', onInput);
  textarea.addEventListener('keydown', onKeydown, true);
  textarea.addEventListener('blur', () => setTimeout(() => { if (isOpen()) close(); }, 150));
  window.addEventListener('scroll', () => { if (isOpen()) position(); }, true);

  return {
    getGrants() { return grants.slice(); },
    clear() { grants = []; renderTray(); },
    isOpen,
    destroy() {
      textarea.removeEventListener('input', onInput);
      textarea.removeEventListener('click', onInput);
      textarea.removeEventListener('keydown', onKeydown, true);
      dropdown.remove();
    },
  };
}

// ── Controller-link rendering (in sent message bubbles) ─────────────────────
// Renders metadata.grants as inline controller links. Super-admin sees a revoke
// X (hover) and can click the body to edit the reason note.
export function renderGrantControllers(metadata, { mine = false } = {}) {
  const arr = metadata && Array.isArray(metadata.grants) ? metadata.grants : [];
  if (!arr.length) return '';
  const isSA = isSuperAdmin();
  return `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:6px;">` + arr.map(g => {
    const dead = _revoked.has(g.grant_id);
    const bg = dead ? '#9CA3AF' : (mine ? 'rgba(255,255,255,.18)' : '#5B4A8A');
    const deco = dead ? 'text-decoration:line-through;opacity:.8;' : '';
    // BODY click = OPEN the granted record (recipient AND granter). Super-admin keeps
    // a pencil (edit reason) + an X (revoke) on the right, both stopPropagation so
    // they never trigger the open. A revoked chip is inert.
    const controls = (isSA && !dead)
      ? `<span class="grant-edit" title="Edit reason" onclick="event.stopPropagation();window._editGrantNote('${g.grant_id}')" style="cursor:pointer;color:#E8DEF6;font-size:10px;padding:0 2px;"><i class="fa-solid fa-pencil"></i></span>`
        + `<span class="grant-revoke" title="Revoke access" onclick="event.stopPropagation();window._revokeGrantController('${g.grant_id}')" style="cursor:pointer;color:#F3DADA;font-size:11px;padding:0 2px;">✕</span>`
      : '';
    const bodyClick = dead ? '' : ` onclick="event.stopPropagation();window._openGrantedRecord('${_esc(g.record_type)}','${_esc(g.record_id)}')"`;
    return `<span class="grant-controller" data-grant-id="${g.grant_id}"${bodyClick} title="${dead ? '' : 'Open record'}"
      style="display:inline-flex;align-items:center;gap:6px;background:${bg};color:#fff;border-radius:13px;padding:3px 8px 3px 10px;font-size:11.5px;${deco}cursor:${dead ? 'default' : 'pointer'};max-width:240px;">
      <i class="fa-solid fa-key" style="font-size:10px;opacity:.9;"></i>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(g.label || recordTypeLabel(g.record_type))}${dead ? ' · revoked' : ''}</span>
      ${controls}
    </span>`;
  }).join('') + `</div>`;
}

// Open the granted record from the chip body — recipient AND granter. Maps the
// record_grants.record_type to the right opener. Sacramental/project reuse the '#'
// mention opener (which already has the access gate + lazy-load expand* stubs);
// discerner + homebound_recipient are NOT mention-link types and have no case in
// openLinkedRecord, so they're handled explicitly here. NEVER silent — any miss
// surfaces a toast so this class of wiring gap can't recur invisibly.
const _GRANT_MENTION_TYPE = {
  marriage: 'marriage', annulment: 'annulment', ocia: 'ocia',
  baptism: 'baptism', first_communion: 'firstcomm', confirmation: 'confirmation',
};
async function _openGrantedRecord(recordType, recordId) {
  try {
    const mention = _GRANT_MENTION_TYPE[recordType];
    if (mention) {
      if (typeof window._openLinkedRecord === 'function') return window._openLinkedRecord(mention, recordId);
      throw new Error('link opener unavailable');
    }
    if (recordType === 'discerner') {
      if (typeof window.expandDiscerner === 'function') return window.expandDiscerner(recordId);
      throw new Error('discernment opener unavailable');
    }
    if (recordType === 'homebound_recipient') {
      location.hash = `#/homebound/${recordId}`;          // hash first; the shell opens it on mount
      if (typeof window.switchPanel === 'function') return window.switchPanel('homebound');
      throw new Error('panel switch unavailable');
    }
    if (recordType === 'review' || recordType === 'disciplinary' || recordType === 'incident') {
      // HR record grant → the read-only grantee view. The '#/personnel/<id>' hash lets
      // the shell preselect this record; loadHr routes a grant-only viewer (no org-tree
      // access) to renderHrGranteeView (a flat, read-only list of ONLY granted records).
      location.hash = `#/personnel/${recordId}`;
      if (typeof window.switchPanel === 'function') return window.switchPanel('hr');
      throw new Error('panel switch unavailable');
    }
    showToast(`Can't open this record type (${recordType}).`, { type: 'error' });
  } catch (e) {
    console.error('[grant] open failed:', e);
    showToast("Couldn't open the granted record. Contact an administrator.", { type: 'error' });
  }
}

// Global dispatchers (controller links are rendered as HTML strings).
async function _revokeGrantController(grantId) {
  if (!isSuperAdmin()) return;
  if (!confirm('Revoke this access? The recipient will immediately lose access to the file.')) return;
  const { error } = await revokeGrant(grantId);
  if (error) { alert('Revoke failed: ' + error.message); return; }
  _revoked.add(grantId);
  document.querySelectorAll(`.grant-controller[data-grant-id="${grantId}"]`).forEach(el => {
    el.style.background = '#9CA3AF';
    const lbl = el.querySelector('span'); if (lbl && !/revoked/.test(lbl.textContent)) lbl.textContent += ' · revoked';
    el.style.textDecoration = 'line-through'; el.style.cursor = 'default'; el.onclick = null;
    el.querySelector('.grant-revoke')?.remove();
  });
}
async function _editGrantNote(grantId) {
  if (!isSuperAdmin()) return;
  const note = prompt('Reason for this grant (leave blank to clear):');
  if (note === null) return;
  const { error } = await setGrantNote(grantId, note.trim());
  if (error) { alert('Could not save note: ' + error.message); }
}

if (typeof window !== 'undefined') {
  window._revokeGrantController = _revokeGrantController;
  window._editGrantNote = _editGrantNote;
  window._openGrantedRecord = _openGrantedRecord;
}
