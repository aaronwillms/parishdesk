import { sb } from '../supabase.js';
import { store } from '../store.js';
import { createAvatar } from './avatar.js';

const _subs    = {}; // discussion_id → realtime channel
const _pinSubs = {}; // discussion_id → pin realtime channel

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
    // Check if user is project creator or assignee
    const { data: proj } = await sb.from('projects')
      .select('created_by, assigned_to')
      .eq('id', contextId)
      .single();
    if (proj) {
      const pid = store.currentUserRoles?.personnelId || null;
      canPin = proj.created_by === currentUserId ||
               (Array.isArray(proj.assigned_to) && (proj.assigned_to.includes(currentUserId) || (pid && proj.assigned_to.includes(pid))));
    }
  }

  const { data: discussions } = await sb.from('discussions')
    .select('id, title, created_by, created_at, updated_at, pinned_message_id')
    .eq('context_type', contextType)
    .eq('context_id', contextId)
    .order('updated_at', { ascending: false });

  let list = discussions || [];

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
    if (!list.length) {
      return `<div style="padding:2rem 1rem;text-align:center;font-size:13px;color:#9CA3AF;font-style:italic;">No threads yet. Start one!</div>`;
    }
    return list.map(d => _threadRowHtml(d)).join('');
  }

  function _threadRowHtml(d) {
    const prof    = profileMap[d.created_by] || { name: 'Unknown', personnelId: null };
    const count   = replyMap[d.id]   || 0;
    const lastTs  = lastMsgMap[d.id] || d.updated_at;
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
            <div style="font-size:13px;font-weight:500;color:#1C2B3A;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(d.title)}</div>
            <div style="font-size:11px;color:#9CA3AF;flex-shrink:0;">${_relTime(lastTs)}</div>
          </div>
          <div style="font-size:12px;color:#9CA3AF;">
            ${_esc(prof.name)}${count ? ` · ${count} repl${count === 1 ? 'y' : 'ies'}` : ''}
          </div>
        </div>
        <button class="disc-delete-btn" data-disc-id="${d.id}" title="Delete thread" style="
          display:none;flex-shrink:0;background:none;border:none;cursor:pointer;
          color:#8B1A2F;font-size:13px;padding:2px 4px;line-height:1;
        "><i class="fa-solid fa-trash"></i></button>
      </div>`;
  }

  // ── Hydrate list ────────────────────────────────────────────────────────

  function _hydrateList() {
    container.querySelectorAll('.disc-creator-slot').forEach(slot => {
      const { uid, name, pid } = slot.dataset;
      createAvatar({ container: slot, userId: pid || uid, name: name || uid, size: 34 });
    });

    container.querySelectorAll('.disc-thread-row').forEach(row => {
      const delBtn = row.querySelector('.disc-delete-btn');
      row.addEventListener('mouseenter', () => {
        if (row.dataset.discId !== _activeDiscId) row.style.background = '#F8F7F4';
        if (delBtn) delBtn.style.display = 'block';
      });
      row.addEventListener('mouseleave', () => {
        if (row.dataset.discId !== _activeDiscId) row.style.background = '#FAFAF8';
        if (delBtn) delBtn.style.display = 'none';
      });
      row.addEventListener('click', e => {
        if (e.target.closest('.disc-delete-btn')) return;
        const id = row.dataset.discId;
        if (_activeDiscId && _activeDiscId !== id && _subs[_activeDiscId]) {
          sb.removeChannel(_subs[_activeDiscId]); delete _subs[_activeDiscId];
        }
        _activeDiscId = (_activeDiscId === id && !isMobile()) ? null : id;
        rerender();
        if (_activeDiscId && isMobile()) _loadThread(_activeDiscId, currentUserId, profileMap, onBack, list.find(d => d.id === _activeDiscId), true, canPin);
      });
      if (delBtn) {
        delBtn.addEventListener('click', e => {
          e.stopPropagation();
          _deleteThread(delBtn.dataset.discId);
        });
      }
    });

    document.getElementById('disc-new-btn')?.addEventListener('click', () => {
      _openNewThreadModal({ contextType, contextId, currentUserId, profileMap, onCreated: (disc) => {
        list.unshift(disc);
        _activeDiscId = disc.id;
        rerender();
      }});
    });
  }

  // ── Delete thread ───────────────────────────────────────────────────────

  async function _deleteThread(discId) {
    if (!confirm('Delete this thread and all its replies? This cannot be undone.')) return;
    await sb.from('discussion_messages').delete().eq('discussion_id', discId);
    await sb.from('discussions').delete().eq('id', discId);
    if (_subs[discId])    { sb.removeChannel(_subs[discId]);    delete _subs[discId]; }
    if (_pinSubs[discId]) { sb.removeChannel(_pinSubs[discId]); delete _pinSubs[discId]; }
    list = list.filter(d => d.id !== discId);
    delete replyMap[discId];
    delete lastMsgMap[discId];
    if (_activeDiscId === discId) _activeDiscId = null;
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

async function _loadThread(discId, currentUserId, profileMap, rerender, discOverride, showBack = false, canPin = false) {
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
    <div id="disc-pinned-bar-${discId}" style="flex-shrink:0;padding:0 1rem;background:#fff;"></div>
    <div id="disc-msgs-${discId}" style="flex:1;overflow-y:auto;padding:1rem;display:flex;flex-direction:column;gap:0;background:#fff;">
      <div style="font-size:12px;color:#9CA3AF;text-align:center;">Loading…</div>
    </div>
    <div style="padding:.75rem 1rem;border-top:.5px solid #E2DDD6;background:#fff;flex-shrink:0;display:flex;gap:8px;align-items:flex-end;">
      <textarea id="disc-reply-${discId}" placeholder="Write a reply…" rows="1" style="
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
    if (_pinSubs[discId]) { sb.removeChannel(_pinSubs[discId]); delete _pinSubs[discId]; }
    rerender?.();
  });

  const { data: rawMsgs } = await sb.from('discussion_messages')
    .select('*')
    .eq('discussion_id', discId)
    .order('created_at', { ascending: true });

  const msgs = rawMsgs || [];
  await _fillProfiles([...new Set(msgs.map(m => m.sender_id).filter(Boolean))], profileMap);

  const { data: discData } = await sb.from('discussions').select('pinned_message_id').eq('id', discId).single();
  let pinnedMsgId = discData?.pinned_message_id || null;

  const reRenderPin = (newId) => {
    pinnedMsgId = newId;
    _renderMsgs(discId, msgs, currentUserId, profileMap, pinnedMsgId, canPin);
    _renderDiscPinnedBar(discId, msgs, profileMap, pinnedMsgId, canPin, doPin);
    _wireInput(discId, msgs, currentUserId, profileMap, pinnedMsgId, canPin, doPin);
  };

  const doPin = async (newId) => {
    await sb.from('discussions').update({ pinned_message_id: newId }).eq('id', discId);
    reRenderPin(newId);
  };

  _renderMsgs(discId, msgs, currentUserId, profileMap, pinnedMsgId, canPin);
  _renderDiscPinnedBar(discId, msgs, profileMap, pinnedMsgId, canPin, doPin);
  _wireInput(discId, msgs, currentUserId, profileMap, pinnedMsgId, canPin, doPin);
  _subscribeThread(discId, msgs, currentUserId, profileMap, pinnedMsgId, canPin, doPin);
  _subscribePinUpdates(discId, msgs, profileMap, currentUserId, canPin, reRenderPin);
}

function _renderMsgs(discId, msgs, currentUserId, profileMap, pinnedMsgId, canPin) {
  const el = document.getElementById('disc-msgs-' + discId);
  if (!el) return;

  if (!msgs.length) {
    el.innerHTML = `<div style="flex:1;display:flex;align-items:center;justify-content:center;font-size:13px;color:#9CA3AF;font-style:italic;text-align:center;">No replies yet — be the first!</div>`;
    return;
  }

  el.innerHTML = msgs.map(m => {
    const isMine   = m.sender_id === currentUserId;
    const prof     = profileMap[m.sender_id] || { name: 'User', personnelId: null };
    const isPinned = m.id === pinnedMsgId;
    const pinBtn   = canPin ? `
      <button class="disc-pin-btn" data-msg-id="${m.id}" title="${isPinned ? 'Unpin' : 'Pin message'}" style="
        display:none;background:none;border:none;cursor:pointer;padding:2px 4px;
        color:${isPinned ? '#C9A84C' : '#999'};font-size:11px;line-height:1;flex-shrink:0;align-self:center;
      "><i class="fa-solid fa-thumbtack"></i></button>` : '';
    return `
      <div class="disc-msg-row" data-msg-id="${m.id}" style="
        display:flex;align-items:flex-end;gap:8px;margin-bottom:.6rem;
        justify-content:${isMine ? 'flex-end' : 'flex-start'};
      ">
        ${!isMine ? `<div class="disc-msg-avatar" data-uid="${m.sender_id || ''}" data-name="${_esc(prof.name)}" data-pid="${prof.personnelId || ''}"
          style="width:26px;height:26px;border-radius:50%;background:#E2DDD6;flex-shrink:0;margin-bottom:2px;"></div>` : ''}
        ${isMine ? pinBtn : ''}
        <div style="max-width:72%;display:flex;flex-direction:column;${isMine ? 'align-items:flex-end;' : 'align-items:flex-start;'}">
          <div style="font-size:11px;color:#9CA3AF;margin-bottom:2px;">
            ${isMine ? '' : `${_esc(prof.name)} · `}${_relTime(m.created_at)}
          </div>
          <div id="disc-bubble-${m.id}" style="
            background:${isMine ? '#1C2B3A' : '#F0F0F0'};
            color:${isMine ? '#fff' : '#1C2B3A'};
            border-radius:18px;
            ${isMine ? 'border-bottom-right-radius:4px;' : 'border-bottom-left-radius:4px;'}
            padding:9px 14px;font-size:13px;line-height:1.45;word-break:break-word;white-space:pre-wrap;
            ${isPinned ? 'outline:2px solid #C9A84C;outline-offset:1px;' : ''}
          ">${_esc(m.body)}</div>
        </div>
        ${!isMine ? pinBtn : ''}
      </div>`;
  }).join('');

  el.querySelectorAll('.disc-msg-avatar').forEach(slot => {
    const { uid, name, pid } = slot.dataset;
    createAvatar({ container: slot, userId: pid || uid, name: name || uid, size: 26 });
  });

  if (canPin) {
    el.querySelectorAll('.disc-msg-row').forEach(row => {
      const btn = row.querySelector('.disc-pin-btn');
      if (!btn) return;
      row.addEventListener('mouseenter', () => { btn.style.display = 'block'; });
      row.addEventListener('mouseleave', () => { btn.style.display = 'none'; });
    });
  }

  el.scrollTop = el.scrollHeight;
}

function _renderDiscPinnedBar(discId, msgs, profileMap, pinnedMsgId, canPin, onToggle) {
  const bar = document.getElementById('disc-pinned-bar-' + discId);
  if (!bar) return;
  if (!pinnedMsgId) { bar.innerHTML = ''; return; }

  const msg    = msgs.find(m => m.id === pinnedMsgId);
  const sender = msg ? (profileMap[msg.sender_id]?.name || 'User') : 'Unknown';
  const preview = msg ? _truncate(msg.body, 60) : '…';

  bar.innerHTML = `
    <div style="
      display:flex;align-items:center;gap:10px;
      border-left:3px solid #C9A84C;background:#F8F7F4;
      padding:8px 12px;border-radius:4px;margin:8px 0 0;
      box-shadow:0 1px 3px rgba(0,0,0,.06);
    ">
      <i class="fa-solid fa-thumbtack" style="color:#C9A84C;font-size:12px;flex-shrink:0;"></i>
      <div style="flex:1;min-width:0;">
        <div style="font-size:11px;color:#9CA3AF;margin-bottom:1px;">${_esc(sender)}</div>
        <div style="font-size:12.5px;color:#1C2B3A;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(preview)}</div>
      </div>
      <button id="disc-jump-pin-${discId}" style="background:none;border:none;cursor:pointer;font-size:12px;color:#8B1A2F;font-family:'Inter',sans-serif;white-space:nowrap;flex-shrink:0;">Jump</button>
      ${canPin ? `<button id="disc-unpin-${discId}" style="background:none;border:.5px solid #D1C9BE;border-radius:4px;cursor:pointer;font-size:11.5px;color:#6B7280;padding:2px 8px;font-family:'Inter',sans-serif;flex-shrink:0;">Unpin</button>` : ''}
    </div>`;

  document.getElementById(`disc-jump-pin-${discId}`)?.addEventListener('click', () => {
    const target = document.getElementById('disc-bubble-' + pinnedMsgId);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const orig = target.style.background;
    target.style.transition = 'background .2s';
    target.style.background = '#C9A84C44';
    setTimeout(() => { target.style.background = orig; }, 1000);
  });

  if (canPin) {
    document.getElementById(`disc-unpin-${discId}`)?.addEventListener('click', () => onToggle(null));
  }

  // Wire pin buttons now that bar is rendered
  document.getElementById('disc-msgs-' + discId)?.querySelectorAll('.disc-pin-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const newId = btn.dataset.msgId === pinnedMsgId ? null : btn.dataset.msgId;
      onToggle(newId);
    });
  });
}

function _wireInput(discId, msgs, currentUserId, profileMap, pinnedMsgId, canPin, doPin) {
  const input   = document.getElementById('disc-reply-' + discId);
  const sendBtn = document.getElementById('disc-send-' + discId);
  if (!input || !sendBtn) return;

  const doSend = async () => {
    const body = input.value.trim();
    if (!body) return;
    input.value = '';
    input.style.height = 'auto';
    const { data: newMsg, error } = await sb.from('discussion_messages')
      .insert({ discussion_id: discId, sender_id: currentUserId, body })
      .select().single();
    if (error) { console.error('[discussionThread] send failed:', error); return; }
    if (!msgs.find(m => m.id === newMsg.id)) msgs.push(newMsg);
    await sb.from('discussions').update({ updated_at: new Date().toISOString() }).eq('id', discId);
    _renderMsgs(discId, msgs, currentUserId, profileMap, pinnedMsgId, canPin);
    _renderDiscPinnedBar(discId, msgs, profileMap, pinnedMsgId, canPin, doPin);
    _wireInput(discId, msgs, currentUserId, profileMap, pinnedMsgId, canPin, doPin);
  };

  sendBtn.addEventListener('click', doSend);
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });
  input.focus();
}

function _subscribeThread(discId, msgs, currentUserId, profileMap, pinnedMsgId, canPin, doPin) {
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
      _renderMsgs(discId, msgs, currentUserId, profileMap, pinnedMsgId, canPin);
      _renderDiscPinnedBar(discId, msgs, profileMap, pinnedMsgId, canPin, doPin);
      _wireInput(discId, msgs, currentUserId, profileMap, pinnedMsgId, canPin, doPin);
    })
    .subscribe();
}

function _subscribePinUpdates(discId, msgs, profileMap, currentUserId, canPin, doPin) {
  if (_pinSubs[discId]) sb.removeChannel(_pinSubs[discId]);
  _pinSubs[discId] = sb.channel('disc-pin-' + discId)
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'discussions',
      filter: `id=eq.${discId}`,
    }, payload => {
      const newPinId = payload.new.pinned_message_id || null;
      doPin && doPin(newPinId);
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
