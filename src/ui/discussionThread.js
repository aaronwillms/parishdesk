import { sb } from '../supabase.js';
import { store } from '../store.js';
import { createAvatar } from './avatar.js';
import { createMentionPicker, renderLinkChips } from './mentionPicker.js';
import { containerRole, canManageRole } from './membership.js';

const _discMentionPickers = {};  // discId → picker

const GROUP_BUBBLE_COLORS = [
  '#E3F2FD', '#F3E5F5', '#E8F5E9', '#FFF3E0',
  '#FCE4EC', '#E0F7FA', '#FFF8E1', '#EDE7F6',
];
const GROUP_LABEL_COLORS = [
  '#1565C0', '#6A1B9A', '#2E7D32', '#E65100',
  '#880E4F', '#006064', '#F57F17', '#4527A0',
];

function _buildDiscColorMap(msgs, currentUserId) {
  const map = {};
  let idx = 0;
  for (const m of msgs) {
    const uid = m.sender_id;
    if (!uid || uid === currentUserId || map[uid] !== undefined) continue;
    map[uid] = idx % GROUP_BUBBLE_COLORS.length;
    idx++;
  }
  return map;
}

const _subs = {}; // discussion_id → realtime channel

// ── Public ─────────────────────────────────────────────────────────────────

export async function renderDiscussionThread({ container, contextType, contextId }) {
  if (!container) return;
  container.innerHTML = `<div style="font-size:13px;color:#9CA3AF;padding:2rem;text-align:center;">Loading discussions…</div>`;

  const { data: { user } } = await sb.auth.getUser();
  const currentUserId = user?.id;
  if (!currentUserId) { container.innerHTML = '<div style="padding:2rem;color:#9CA3AF;">Not signed in.</div>'; return; }

  const roles = store.currentUserRoles || {};

  // Determine pin permission: admins always can; for teams/projects check membership
  let canPin = roles.isAdmin || roles.isSuperAdmin;
  if (!canPin && contextType === 'team') {
    // Team members who are team admins can pin — for now allow any team member
    canPin = (roles.teamIds || []).includes(contextId);
  }
  if (!canPin && contextType === 'project') {
    // 2b-1: pin is an owner/admin capability, resolved via container_members.
    const pid = store.currentUserRoles?.personnelId || null;
    if (pid) canPin = canManageRole(await containerRole('project', contextId, pid));
  }

  const { data: discussions } = await sb.from('discussions')
    .select('id, title, created_by, created_at, updated_at, pinned, pinned_at, deleted_at')
    .eq('context_type', contextType)
    .eq('context_id', contextId)
    .order('updated_at', { ascending: false });

  const _allDiscs = discussions || [];
  let deletedList = _allDiscs.filter(d => !!d.deleted_at)
    .sort((a, b) => (b.deleted_at || '').localeCompare(a.deleted_at || ''));
  let list = _allDiscs.filter(d => !d.deleted_at).sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    if (a.pinned && b.pinned) return (b.pinned_at || '').localeCompare(a.pinned_at || '');
    return (b.updated_at || '').localeCompare(a.updated_at || '');
  });
  let _showDeleted = false;

  // Profile map for thread creators
  const profileMap = {};
  await _fillProfiles([...new Set(list.map(d => d.created_by).filter(Boolean))], profileMap);

  // Reply counts + last activity per thread
  const replyMap   = {}; // discussion_id → count
  const lastMsgMap = {}; // discussion_id → created_at
  if (list.length) {
    const { data: counts } = await sb.from('discussion_messages')
      .select('discussion_id, created_at')
      .in('discussion_id', list.map(d => d.id));
    (counts || []).forEach(r => {
      replyMap[r.discussion_id]   = (replyMap[r.discussion_id] || 0) + 1;
      if (!lastMsgMap[r.discussion_id] || r.created_at > lastMsgMap[r.discussion_id])
        lastMsgMap[r.discussion_id] = r.created_at;
    });
  }

  let _activeDiscId = null;
  const isMobile = () => window.innerWidth < 640;

  // ── Render ──────────────────────────────────────────────────────────────

  function rerender() {
    if (isMobile() && _activeDiscId) {
      _renderMobileThread();
    } else if (isMobile()) {
      _renderMobileList();
    } else {
      _renderDesktop();
    }
  }

  // ── Desktop: two-column ─────────────────────────────────────────────────

  function _renderDesktop() {
    container.innerHTML = `
      <div style="display:flex;height:100%;min-height:480px;border:.5px solid #E2DDD6;border-radius:10px;overflow:hidden;background:#fff;">
        <!-- Left column: thread list -->
        <div style="width:280px;min-width:220px;max-width:280px;border-right:.5px solid #E2DDD6;display:flex;flex-direction:column;background:#FAFAF8;">
          <div style="padding:.75rem 1rem;border-bottom:.5px solid #E2DDD6;flex-shrink:0;">
            <button id="disc-new-btn" style="
              width:100%;padding:.45rem .9rem;background:#C9A84C;color:#fff;border:none;
              border-radius:6px;font-size:13px;font-family:'Inter',sans-serif;
              cursor:pointer;font-weight:500;display:flex;align-items:center;justify-content:center;gap:6px;
            "><i class="fa-solid fa-plus" style="font-size:12px;"></i> New Thread</button>
          </div>
          <div id="disc-list" style="overflow-y:auto;flex:1;">${_listHtml()}</div>
        </div>
        <!-- Right column: active thread -->
        <div id="disc-thread-pane" style="flex:1;display:flex;flex-direction:column;min-width:0;">
          ${_activeDiscId ? '' : _emptyPane()}
        </div>
      </div>`;

    _hydrateList();
    if (_activeDiscId) _loadThread(_activeDiscId, currentUserId, profileMap, onBack, null, false, canPin);
  }

  function onBack() { _activeDiscId = null; rerender(); }

  // ── Mobile: list view ───────────────────────────────────────────────────

  function _renderMobileList() {
    container.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%;min-height:400px;border:.5px solid #E2DDD6;border-radius:10px;overflow:hidden;background:#FAFAF8;">
        <div style="padding:.75rem 1rem;border-bottom:.5px solid #E2DDD6;flex-shrink:0;">
          <button id="disc-new-btn" style="
            width:100%;padding:.45rem .9rem;background:#C9A84C;color:#fff;border:none;
            border-radius:6px;font-size:13px;font-family:'Inter',sans-serif;
            cursor:pointer;font-weight:500;display:flex;align-items:center;justify-content:center;gap:6px;
          "><i class="fa-solid fa-plus" style="font-size:12px;"></i> New Thread</button>
        </div>
        <div id="disc-list" style="overflow-y:auto;flex:1;">${_listHtml()}</div>
      </div>`;
    _hydrateList();
  }

  // ── Mobile: thread view ─────────────────────────────────────────────────

  function _renderMobileThread() {
    const disc = list.find(d => d.id === _activeDiscId);
    container.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%;min-height:400px;border:.5px solid #E2DDD6;border-radius:10px;overflow:hidden;background:#fff;">
        <div id="disc-thread-pane" style="flex:1;display:flex;flex-direction:column;min-width:0;"></div>
      </div>`;
    _loadThread(_activeDiscId, currentUserId, profileMap, onBack, disc, true);
  }

  // ── Thread list HTML ────────────────────────────────────────────────────

  function _listHtml() {
    const activeHtml = list.length
      ? list.map(d => _threadRowHtml(d)).join('')
      : `<div style="padding:2rem 1rem;text-align:center;font-size:13px;color:#9CA3AF;font-style:italic;">No threads yet. Start one!</div>`;

    if (!deletedList.length) return activeHtml;

    const deletedHtml = _showDeleted
      ? deletedList.map(d => _deletedRowHtml(d)).join('')
      : '';

    return activeHtml + `
      <div id="disc-deleted-toggle" style="
        display:flex;align-items:center;justify-content:space-between;
        padding:.5rem 1rem;cursor:pointer;user-select:none;
        border-top:.5px solid #E2DDD6;
      ">
        <span style="font-size:11.5px;color:#9CA3AF;font-style:italic;font-weight:500;">
          Deleted Threads (${deletedList.length})
        </span>
        <i class="fa-solid fa-chevron-${_showDeleted ? 'up' : 'down'}" style="font-size:10px;color:#C0BAB2;"></i>
      </div>
      <div id="disc-deleted-list">${deletedHtml}</div>
    `;
  }

  function _deletedRowHtml(d) {
    return `
      <div class="disc-deleted-row" style="
        display:flex;align-items:center;justify-content:space-between;gap:10px;
        padding:.6rem 1rem;border-bottom:.5px solid #F0EDE8;background:#FAFAF8;
      ">
        <div style="min-width:0;flex:1;">
          <div style="font-size:13px;color:#9CA3AF;font-style:italic;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(d.title)}</div>
          <div style="font-size:11px;color:#C0BAB2;margin-top:2px;">Deleted ${_relTime(d.deleted_at)}</div>
        </div>
        <button class="disc-restore-btn" data-disc-id="${d.id}" style="
          flex-shrink:0;font-size:12px;color:#6B7280;background:none;
          border:.5px solid #D1C9BE;border-radius:5px;padding:.25rem .6rem;
          font-family:'Inter',sans-serif;cursor:pointer;white-space:nowrap;
        " onmouseover="this.style.borderColor='#1C2B3A';this.style.color='#1C2B3A';"
           onmouseout="this.style.borderColor='#D1C9BE';this.style.color='#6B7280';">Restore</button>
      </div>`;
  }

  function _threadRowHtml(d) {
    const prof     = profileMap[d.created_by] || { name: 'Unknown', personnelId: null };
    const count    = replyMap[d.id]   || 0;
    const lastTs   = lastMsgMap[d.id] || d.updated_at;
    const isActive = d.id === _activeDiscId;
    return `
      <div class="disc-thread-row" data-disc-id="${d.id}" style="
        position:relative;display:flex;align-items:center;gap:10px;padding:.75rem 1rem;
        cursor:pointer;border-bottom:.5px solid #F0EDE8;
        background:${isActive ? '#F8F7F4' : '#FAFAF8'};
      ">
        <div class="disc-creator-slot" data-uid="${d.created_by || ''}" data-name="${_esc(prof.name)}" data-pid="${prof.personnelId || ''}"
          style="flex-shrink:0;width:34px;height:34px;border-radius:50%;background:#E2DDD6;"></div>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;margin-bottom:2px;">
            <div style="display:flex;align-items:center;gap:5px;min-width:0;">
              ${d.pinned ? `<i class="fa-solid fa-thumbtack" style="color:#C9A84C;font-size:10px;flex-shrink:0;transform:rotate(45deg);"></i>` : ''}
              <div style="font-size:13px;font-weight:500;color:#1C2B3A;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(d.title)}</div>
            </div>
            <div style="font-size:11px;color:#9CA3AF;flex-shrink:0;">${_relTime(lastTs)}</div>
          </div>
          <div style="font-size:12px;color:#9CA3AF;">
            ${_esc(prof.name)}${count ? ` · ${count} repl${count === 1 ? 'y' : 'ies'}` : ''}
          </div>
        </div>
        <div class="disc-row-actions" style="display:none;flex-shrink:0;align-items:center;gap:2px;">
          ${canPin ? `<button class="disc-pin-btn" data-disc-id="${d.id}" title="${d.pinned ? 'Unpin thread' : 'Pin thread'}" style="
            background:none;border:none;cursor:pointer;
            color:${d.pinned ? '#C9A84C' : '#C0BAB2'};font-size:11px;padding:2px 4px;line-height:1;
          "><i class="fa-solid fa-thumbtack"></i></button>` : ''}
          <button class="disc-delete-btn" data-disc-id="${d.id}" title="Delete thread" style="
            background:none;border:none;cursor:pointer;
            color:#C0BAB2;font-size:13px;padding:2px 4px;line-height:1;
          ">✕</button>
        </div>
      </div>`;
  }

  // ── Hydrate list ────────────────────────────────────────────────────────

  function _hydrateList() {
    container.querySelectorAll('.disc-creator-slot').forEach(slot => {
      const { uid, name } = slot.dataset;
      createAvatar({ container: slot, userId: uid, name: name || uid, size: 34 });
    });

    container.querySelectorAll('.disc-thread-row').forEach(row => {
      const actions = row.querySelector('.disc-row-actions');
      const pinBtn  = row.querySelector('.disc-pin-btn');
      const delBtn  = row.querySelector('.disc-delete-btn');
      row.addEventListener('mouseenter', () => {
        if (row.dataset.discId !== _activeDiscId) row.style.background = '#F8F7F4';
        if (actions) actions.style.display = 'flex';
      });
      row.addEventListener('mouseleave', () => {
        if (row.dataset.discId !== _activeDiscId) row.style.background = '#FAFAF8';
        if (actions) actions.style.display = 'none';
      });
      row.addEventListener('click', e => {
        if (e.target.closest('.disc-row-actions')) return;
        const id = row.dataset.discId;
        if (_activeDiscId && _activeDiscId !== id && _subs[_activeDiscId]) {
          sb.removeChannel(_subs[_activeDiscId]); delete _subs[_activeDiscId];
        }
        _activeDiscId = (_activeDiscId === id && !isMobile()) ? null : id;
        rerender();
        if (_activeDiscId && isMobile()) _loadThread(_activeDiscId, currentUserId, profileMap, onBack, list.find(d => d.id === _activeDiscId), true);
      });
      if (pinBtn) {
        pinBtn.addEventListener('click', e => {
          e.stopPropagation();
          _toggleDiscPin(pinBtn.dataset.discId);
        });
      }
      if (delBtn) {
        delBtn.addEventListener('click', e => {
          e.stopPropagation();
          _deleteThread(delBtn.dataset.discId);
        });
      }
    });

    document.getElementById('disc-deleted-toggle')?.addEventListener('click', () => {
      _showDeleted = !_showDeleted;
      const listEl = document.getElementById('disc-deleted-list');
      const icon   = document.querySelector('#disc-deleted-toggle i');
      if (listEl) listEl.innerHTML = _showDeleted ? deletedList.map(d => _deletedRowHtml(d)).join('') : '';
      if (icon)   { icon.className = `fa-solid fa-chevron-${_showDeleted ? 'up' : 'down'}`; icon.style.fontSize = '10px'; icon.style.color = '#C0BAB2'; }
      if (_showDeleted) _hydrateDeletedList();
    });

    document.getElementById('disc-new-btn')?.addEventListener('click', () => {
      _openNewThreadModal({ contextType, contextId, currentUserId, profileMap, onCreated: (disc) => {
        list.unshift(disc);
        _activeDiscId = disc.id;
        rerender();
      }});
    });
  }

  // ── Hydrate deleted list ────────────────────────────────────────────────

  function _hydrateDeletedList() {
    container.querySelectorAll('.disc-restore-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        _restoreThread(btn.dataset.discId);
      });
    });
  }

  // ── Pin thread ──────────────────────────────────────────────────────────

  async function _toggleDiscPin(discId) {
    const disc = list.find(d => d.id === discId);
    if (!disc) return;
    const newPinned = !disc.pinned;
    const now = new Date().toISOString();
    await sb.from('discussions').update({
      pinned: newPinned,
      pinned_at: newPinned ? now : null,
    }).eq('id', discId);
    disc.pinned    = newPinned;
    disc.pinned_at = newPinned ? now : null;
    list.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      if (a.pinned && b.pinned) return (b.pinned_at || '').localeCompare(a.pinned_at || '');
      return (b.updated_at || '').localeCompare(a.updated_at || '');
    });
    rerender();
  }

  // ── Delete thread (soft) ────────────────────────────────────────────────

  async function _deleteThread(discId) {
    if (!confirm('Move this thread to trash? It can be restored within 14 days.')) return;
    const now = new Date().toISOString();
    await sb.from('discussions').update({ deleted_at: now }).eq('id', discId);
    if (_subs[discId]) { sb.removeChannel(_subs[discId]); delete _subs[discId]; }
    const disc = list.find(d => d.id === discId);
    if (disc) {
      disc.deleted_at = now;
      deletedList.unshift(disc);
      list = list.filter(d => d.id !== discId);
    }
    if (_activeDiscId === discId) _activeDiscId = null;
    rerender();
  }

  // ── Restore thread ──────────────────────────────────────────────────────

  async function _restoreThread(discId) {
    await sb.from('discussions').update({ deleted_at: null }).eq('id', discId);
    const disc = deletedList.find(d => d.id === discId);
    if (disc) {
      disc.deleted_at = null;
      deletedList = deletedList.filter(d => d.id !== discId);
      list.unshift(disc);
      list.sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        if (a.pinned && b.pinned) return (b.pinned_at || '').localeCompare(a.pinned_at || '');
        return (b.updated_at || '').localeCompare(a.updated_at || '');
      });
    }
    rerender();
  }

  // ── Empty pane ──────────────────────────────────────────────────────────

  function _emptyPane() {
    return `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:2rem;text-align:center;">
        <i class="fa-regular fa-comments" style="font-size:2rem;color:#D1C9BE;margin-bottom:.75rem;"></i>
        <div style="font-size:13.5px;color:#9CA3AF;">Select a thread to read it,<br>or start a new one.</div>
      </div>`;
  }

  rerender();
}

// ── Fill profile map ────────────────────────────────────────────────────────

async function _fillProfiles(ids, profileMap) {
  const unknown = ids.filter(id => id && !profileMap[id]);
  if (!unknown.length) return;
  const { data: profs } = await sb.from('user_profiles')
    .select('user_id, personnel_id, personnel(name)')
    .in('user_id', unknown);
  (profs || []).forEach(p => { profileMap[p.user_id] = { name: p.personnel?.name || 'User', personnelId: p.personnel_id }; });
}

// ── Thread pane (shared between desktop right column and mobile) ────────────

async function _loadThread(discId, currentUserId, profileMap, rerender, discOverride, showBack = false) {
  const pane = document.getElementById('disc-thread-pane');
  if (!pane) return;

  const discRow = document.querySelector(`.disc-thread-row[data-disc-id="${discId}"]`);
  const titleEl = discRow?.querySelector('div > div:first-child');
  const title   = discOverride?.title || titleEl?.textContent || 'Thread';

  pane.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;padding:.75rem 1rem;border-bottom:.5px solid #E2DDD6;flex-shrink:0;background:#fff;">
      ${showBack ? `<button id="disc-back-btn" style="background:none;border:none;cursor:pointer;color:#1C2B3A;font-size:16px;padding:0 4px 0 0;line-height:1;"><i class="fa-solid fa-arrow-left"></i></button>` : ''}
      <div style="flex:1;font-size:14px;font-weight:600;color:#1C2B3A;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(title)}</div>
    </div>
    <div id="disc-msgs-${discId}" style="flex:1;overflow-y:auto;padding:1rem;display:flex;flex-direction:column;gap:0;background:#fff;">
      <div style="font-size:12px;color:#9CA3AF;text-align:center;">Loading…</div>
    </div>
    <div id="disc-link-tray-${discId}" style="display:none;flex-wrap:wrap;gap:6px;padding:.5rem 1rem 0;background:#fff;flex-shrink:0;"></div>
    <div style="padding:.75rem 1rem;border-top:.5px solid #E2DDD6;background:#fff;flex-shrink:0;display:flex;gap:8px;align-items:flex-end;">
      <textarea id="disc-reply-${discId}" placeholder="Write a reply…  (# to link a case or file)" rows="1" style="
        flex:1;resize:none;border:.5px solid #D1C9BE;border-radius:18px;
        padding:8px 14px;font-size:13px;font-family:'Inter',sans-serif;
        outline:none;background:#fff;max-height:120px;overflow-y:auto;line-height:1.4;
      "></textarea>
      <button id="disc-send-${discId}" style="
        flex-shrink:0;width:34px;height:34px;background:#8B1A2F;color:#fff;border:none;
        border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:13px;
      "><i class="fa-solid fa-paper-plane"></i></button>
    </div>`;

  document.getElementById('disc-back-btn')?.addEventListener('click', () => {
    if (_subs[discId]) { sb.removeChannel(_subs[discId]); delete _subs[discId]; }
    rerender?.();
  });

  const { data: rawMsgs } = await sb.from('discussion_messages')
    .select('*')
    .eq('discussion_id', discId)
    .order('created_at', { ascending: true });

  const msgs = rawMsgs || [];
  await _fillProfiles([...new Set(msgs.map(m => m.sender_id).filter(Boolean))], profileMap);

  _renderMsgs(discId, msgs, currentUserId, profileMap);
  _wireInput(discId, msgs, currentUserId, profileMap);
  _subscribeThread(discId, msgs, currentUserId, profileMap);
}

function _dayLabel(ts) {
  const d   = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === new Date(Date.now() - 86400000).toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function _groupMsgs(msgs, currentUserId) {
  const out = [];
  let lastSender = null;
  let lastTime   = null;
  let lastDate   = null;
  for (let i = 0; i < msgs.length; i++) {
    const m     = msgs[i];
    const mTime = new Date(m.created_at).getTime();
    const d     = _dayLabel(m.created_at);
    if (d !== lastDate) {
      out.push({ type: 'date', date: d });
      lastDate = d; lastSender = null; lastTime = null;
    }
    const gap   = lastTime ? (mTime - lastTime) / 60000 : Infinity;
    const isFirst = m.sender_id !== lastSender || gap > 2;
    const next    = msgs[i + 1];
    const nextTime = next ? new Date(next.created_at).getTime() : null;
    const nextGap  = nextTime ? (nextTime - mTime) / 60000 : Infinity;
    const isLast   = !next || next.sender_id !== m.sender_id || nextGap > 2;
    out.push({ type: 'msg', msg: m, isFirst, isLast, isMine: m.sender_id === currentUserId });
    lastSender = isLast ? null : m.sender_id;
    lastTime   = isLast ? null : mTime;
  }
  return out;
}

function _renderMsgs(discId, msgs, currentUserId, profileMap) {
  const el = document.getElementById('disc-msgs-' + discId);
  if (!el) return;

  if (!msgs.length) {
    el.innerHTML = `<div style="flex:1;display:flex;align-items:center;justify-content:center;font-size:13px;color:#9CA3AF;font-style:italic;text-align:center;">No replies yet — be the first!</div>`;
    return;
  }

  const colorMap = _buildDiscColorMap(msgs, currentUserId);
  const grouped = _groupMsgs(msgs, currentUserId);
  el.innerHTML = grouped.map(item => {
    if (item.type === 'date') {
      return `
        <div style="display:flex;align-items:center;gap:10px;margin:16px 0 12px;">
          <div style="flex:1;height:.5px;background:#E2DDD6;"></div>
          <div style="font-size:11px;color:#9CA3AF;font-weight:500;letter-spacing:.5px;white-space:nowrap;text-transform:uppercase;">${_esc(item.date)}</div>
          <div style="flex:1;height:.5px;background:#E2DDD6;"></div>
        </div>`;
    }
    const { msg: m, isFirst, isLast, isMine } = item;
    const prof = profileMap[m.sender_id] || { name: 'User', personnelId: null };
    const name = prof.name || '';
    const uid  = m.sender_id || '';
    const colorIdx   = (!isMine && colorMap[uid] !== undefined) ? colorMap[uid] : null;
    const bubbleBg   = isMine ? '#1C2B3A' : (colorIdx !== null ? GROUP_BUBBLE_COLORS[colorIdx] : '#F0F0F0');
    const bubbleColor = isMine ? '#fff' : '#1C2B3A';
    const labelColor  = colorIdx !== null ? GROUP_LABEL_COLORS[colorIdx] : '#9CA3AF';
    const avatarSlot = !isMine
      ? (isLast
          ? `<div class="disc-msg-avatar" data-uid="${uid}" data-name="${_esc(name)}" style="width:28px;height:28px;border-radius:50%;background:#E2DDD6;flex-shrink:0;align-self:flex-end;"></div>`
          : `<div style="width:28px;flex-shrink:0;"></div>`)
      : '';
    return `
      <div style="display:flex;align-items:flex-end;gap:8px;margin-top:${isFirst ? '8px' : '2px'};justify-content:${isMine ? 'flex-end' : 'flex-start'};">
        ${!isMine ? avatarSlot : ''}
        <div style="max-width:72%;display:flex;flex-direction:column;${isMine ? 'align-items:flex-end;' : 'align-items:flex-start;'}">
          ${!isMine && isFirst ? `<div style="font-size:11px;color:${labelColor};margin-bottom:2px;margin-left:4px;font-weight:600;">${_esc(name)}</div>` : ''}
          <div class="msg-bubble ${isMine ? 'outgoing' : 'incoming'}" style="
            background:${bubbleBg};
            color:${bubbleColor};
            border-radius:18px;
            ${isMine ? 'border-bottom-right-radius:4px;' : 'border-bottom-left-radius:4px;'}
            padding:9px 14px;font-size:13px;line-height:1.45;word-break:break-word;white-space:pre-wrap;
          ">${_esc(m.body)}${renderLinkChips(m.metadata, { mine: isMine })}</div>
          ${isLast ? `<div style="font-size:10.5px;color:#9CA3AF;margin-top:3px;${isMine ? 'margin-right:3px;' : 'margin-left:3px;'}">${_relTime(m.created_at)}</div>` : ''}
        </div>
      </div>`;
  }).join('');

  el.querySelectorAll('.disc-msg-avatar').forEach(slot => {
    const { uid, name } = slot.dataset;
    createAvatar({ container: slot, userId: uid, name: name || uid, size: 28 });
  });

  el.scrollTop = el.scrollHeight;
}

function _wireInput(discId, msgs, currentUserId, profileMap) {
  const input   = document.getElementById('disc-reply-' + discId);
  const sendBtn = document.getElementById('disc-send-' + discId);
  if (!input || !sendBtn) return;

  const doSend = async () => {
    const body = input.value.trim();
    const _links = _discMentionPickers[discId]?.getLinks() || [];
    if (!body && !_links.length) return;
    input.value = '';
    input.style.height = 'auto';
    _discMentionPickers[discId]?.clear();
    const { data: newMsg, error } = await sb.from('discussion_messages')
      .insert({ discussion_id: discId, sender_id: currentUserId, body, metadata: _links.length ? { links: _links } : null })
      .select().single();
    if (error) { console.error('[discussionThread] send failed:', error); return; }
    if (!msgs.find(m => m.id === newMsg.id)) msgs.push(newMsg);
    await sb.from('discussions').update({ updated_at: new Date().toISOString() }).eq('id', discId);
    _renderMsgs(discId, msgs, currentUserId, profileMap);
    _wireInput(discId, msgs, currentUserId, profileMap);
  };

  sendBtn.addEventListener('click', doSend);
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !_discMentionPickers[discId]?.isOpen()) { e.preventDefault(); doSend(); } });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });
  if (_discMentionPickers[discId]) { _discMentionPickers[discId].destroy(); }
  _discMentionPickers[discId] = createMentionPicker({ textarea: input, tray: document.getElementById('disc-link-tray-' + discId) });
  input.focus();
}

function _subscribeThread(discId, msgs, currentUserId, profileMap) {
  if (_subs[discId]) sb.removeChannel(_subs[discId]);
  _subs[discId] = sb.channel('disc-' + discId)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'discussion_messages',
      filter: `discussion_id=eq.${discId}`,
    }, async payload => {
      const msg = payload.new;
      if (msgs.find(m => m.id === msg.id)) return;
      await _fillProfiles([msg.sender_id].filter(Boolean), profileMap);
      msgs.push(msg);
      _renderMsgs(discId, msgs, currentUserId, profileMap);
      _wireInput(discId, msgs, currentUserId, profileMap);
    })
    .subscribe();
}

// ── New thread modal ───────────────────────────────────────────────────────

function _openNewThreadModal({ contextType, contextId, currentUserId, profileMap, onCreated }) {
  document.getElementById('modal-content').innerHTML = `
    <div class="modal-title">New Discussion Thread</div>
    <div style="margin-bottom:.75rem;">
      <div style="font-size:11.5px;color:#6B7280;margin-bottom:4px;">Thread title</div>
      <input id="disc-new-title" placeholder="e.g. Upcoming schedule changes" style="
        width:100%;box-sizing:border-box;padding:.4rem .65rem;
        border:.5px solid #D1C9BE;border-radius:5px;font-size:13px;
        font-family:'Inter',sans-serif;outline:none;
      " />
    </div>
    <div style="margin-bottom:1rem;">
      <div style="font-size:11.5px;color:#6B7280;margin-bottom:4px;">Opening message</div>
      <textarea id="disc-new-body" rows="4" placeholder="Write your opening message…" style="
        width:100%;box-sizing:border-box;padding:.4rem .65rem;
        border:.5px solid #D1C9BE;border-radius:5px;font-size:13px;
        font-family:'Inter',sans-serif;outline:none;resize:vertical;
      "></textarea>
    </div>
    <div id="disc-new-status" style="font-size:12px;color:#8B1A2F;min-height:16px;margin-bottom:.5rem;"></div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button id="disc-new-create" class="btn-primary">Create Thread</button>
    </div>`;
  document.getElementById('modal-overlay').classList.add('open');
  document.getElementById('disc-new-title')?.focus();

  document.getElementById('disc-new-create')?.addEventListener('click', async () => {
    const title    = document.getElementById('disc-new-title')?.value.trim();
    const body     = document.getElementById('disc-new-body')?.value.trim();
    const statusEl = document.getElementById('disc-new-status');
    if (!title) { statusEl.textContent = 'Please enter a thread title.'; return; }
    if (!body)  { statusEl.textContent = 'Please write an opening message.'; return; }
    statusEl.textContent = 'Creating…';

    const { data: disc, error } = await sb.from('discussions').insert({
      context_type: contextType, context_id: contextId, title, created_by: currentUserId,
    }).select().single();
    if (error) { statusEl.textContent = 'Failed: ' + error.message; return; }

    await sb.from('discussion_messages').insert({ discussion_id: disc.id, sender_id: currentUserId, body });
    profileMap[currentUserId] = profileMap[currentUserId] || { name: 'You', personnelId: null };

    closeModal();
    onCreated(disc);
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _relTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts);
  const min  = Math.floor(diff / 60000);
  if (min < 1)  return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(diff / 3600000);
  if (hr < 24)  return `${hr}h ago`;
  const day = Math.floor(diff / 86400000);
  if (day < 7)  return `${day}d ago`;
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
