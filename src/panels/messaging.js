import { sb } from '../supabase.js';
import { store } from '../store.js';
import { createAvatar } from '../ui/avatar.js';
import { createContactPicker } from '../ui/contactPicker.js';

// ── State ──────────────────────────────────────────────────────────────────

let _currentUserId = null;
let _conversations  = [];
let _activeConvId   = null;
let _messages       = [];
let _msgChannel     = null;
let _globalChannel  = null;
let _userProfileMap = {}; // user_id → { name, personnelId }

// ── Public entry points ────────────────────────────────────────────────────

export async function loadMessaging(opts) {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;
  _currentUserId = user.id;

  if (opts?.conversationId) {
    _activeConvId = opts.conversationId;
  } else if (!opts?.preserveThread) {
    _activeConvId = null;
  }
  _messages = [];

  const el = document.getElementById('messaging-root');
  if (!el) return;
  el.innerHTML = `<div style="font-size:13px;color:#9CA3AF;padding:2rem;text-align:center;">Loading messages…</div>`;

  await _loadConversations();
  _render(el);
  _subscribeGlobal();
}

export function initChatBubble(userId) {
  _currentUserId = userId;
  const bubble = document.getElementById('chat-bubble');
  if (!bubble) return;

  let _dropOpen = false;

  function _openDrop() {
    let drop = document.getElementById('chat-drop');
    if (!drop) {
      drop = document.createElement('div');
      drop.id = 'chat-drop';
      drop.style.cssText = `
        position:fixed;z-index:1200;width:320px;max-height:400px;
        background:#fff;border:.5px solid #E2DDD6;border-radius:10px;
        box-shadow:0 8px 24px rgba(0,0,0,.12);display:flex;flex-direction:column;overflow:hidden;
      `;
      document.body.appendChild(drop);
    }
    const rect = bubble.getBoundingClientRect();
    drop.style.top  = (rect.bottom + 8) + 'px';
    drop.style.right = (window.innerWidth - rect.right) + 'px';
    drop.innerHTML = `<div style="padding:.75rem 1rem;font-size:12px;color:#9CA3AF;border-bottom:.5px solid #F0EDE8;">Loading…</div>`;
    drop.style.display = 'flex';
    _dropOpen = true;
    _renderDrop(drop);
  }

  function _closeDrop() {
    const drop = document.getElementById('chat-drop');
    if (drop) drop.style.display = 'none';
    _dropOpen = false;
  }

  bubble.addEventListener('click', e => {
    e.stopPropagation();
    _dropOpen ? _closeDrop() : _openDrop();
  });

  document.addEventListener('click', e => {
    if (_dropOpen && !e.target.closest('#chat-drop') && !e.target.closest('#chat-bubble')) {
      _closeDrop();
    }
  });

  window._openMessagingConv = (convId) => {
    _closeDrop();
    _activeConvId = convId;
    window.switchPanel('messaging', { title: 'Messages', preserveThread: true });
  };

  _loadInitialUnread();
}

async function _renderDrop(drop) {
  const { data: myParts } = await sb.from('conversation_participants')
    .select('conversation_id, last_read_at').eq('user_id', _currentUserId);

  if (!myParts?.length) {
    drop.innerHTML = _dropEmptyHtml();
    return;
  }

  const allConvIds = myParts.map(p => p.conversation_id);
  const { data: convMeta } = await sb.from('conversations')
    .select('id, deleted_at, is_group, name').in('id', allConvIds);
  const activeConvs = (convMeta || []).filter(c => !c.deleted_at);
  if (!activeConvs.length) {
    drop.innerHTML = _dropEmptyHtml();
    return;
  }

  const convIds = activeConvs.map(c => c.id);
  const convInfoMap = {};
  activeConvs.forEach(c => { convInfoMap[c.id] = c; });

  const [allPartsRes, msgsRes] = await Promise.all([
    sb.from('conversation_participants').select('conversation_id, user_id').in('conversation_id', convIds),
    sb.from('messages').select('*').in('conversation_id', convIds).order('created_at', { ascending: false }),
  ]);

  const allParts = allPartsRes.data || [];
  const allMsgs  = msgsRes.data  || [];

  const otherIds = [...new Set(allParts.filter(p => p.user_id !== _currentUserId).map(p => p.user_id))];
  const profMap  = {};
  if (otherIds.length) {
    const { data: profs } = await sb.from('user_profiles')
      .select('user_id, personnel_id, personnel(name)').in('user_id', otherIds);
    (profs || []).forEach(p => { profMap[p.user_id] = { name: p.personnel?.name || 'User', pid: p.personnel_id }; });
  }

  const lrMap = {};
  myParts.forEach(p => { lrMap[p.conversation_id] = p.last_read_at; });

  const msgsByConv = {};
  allMsgs.forEach(m => { if (!msgsByConv[m.conversation_id]) msgsByConv[m.conversation_id] = []; msgsByConv[m.conversation_id].push(m); });

  const partsByConv = {};
  allParts.forEach(p => { if (!partsByConv[p.conversation_id]) partsByConv[p.conversation_id] = []; partsByConv[p.conversation_id].push(p); });

  const convs = convIds.map(cid => {
    const info    = convInfoMap[cid];
    const msgs    = msgsByConv[cid] || [];
    const lastMsg = msgs[0] || null;
    const lr      = lrMap[cid];
    const unread  = msgs.filter(m => m.sender_id !== _currentUserId && (!lr || new Date(m.created_at) > new Date(lr))).length;
    let displayName, uid, pid, otherParticipants = [];
    if (info.is_group) {
      const others = (partsByConv[cid] || []).filter(p => p.user_id !== _currentUserId);
      otherParticipants = others.map(p => ({ userId: p.user_id, name: profMap[p.user_id]?.name || 'User' }));
      displayName = info.name || _truncate(otherParticipants.map(p => p.name).join(', '), 30);
      uid = null; pid = null;
    } else {
      const other = (partsByConv[cid] || []).find(p => p.user_id !== _currentUserId);
      uid = other?.user_id || '';
      pid = uid ? (profMap[uid]?.pid || null) : null;
      displayName = uid ? (profMap[uid]?.name || 'Unknown') : 'Unknown';
    }
    return { id: cid, isGroup: !!info.is_group, displayName, uid, pid, otherParticipants, lastMsg, unread, updatedAt: lastMsg?.created_at || '' };
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);

  const rows = convs.map(c => {
    const preview = c.lastMsg ? _truncate(c.lastMsg.body, 36) : 'No messages yet';
    const ts      = c.lastMsg ? _relTime(c.lastMsg.created_at) : '';
    const avatar  = c.isGroup
      ? _groupAvatarClusterHtml(c.otherParticipants, 3, 28, 10)
      : `<div class="cd-avatar" data-uid="${c.uid}" data-name="${_esc(c.displayName)}" data-pid="${c.pid || ''}" style="width:28px;height:28px;border-radius:50%;background:#E2DDD6;flex-shrink:0;"></div>`;
    return `
      <div class="chat-drop-row" data-conv-id="${c.id}" style="
        display:flex;align-items:center;gap:10px;padding:.65rem 1rem;cursor:pointer;
        border-bottom:.5px solid #F8F7F4;transition:background .1s;
      " onmouseover="this.style.background='#F8F7F4'" onmouseout="this.style.background=''"
         onclick="window._openMessagingConv('${c.id}')">
        ${avatar}
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;">
            <div style="font-size:13px;font-weight:${c.unread ? '600' : '500'};color:#1C2B3A;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(c.displayName)}</div>
            <div style="font-size:10.5px;color:#9CA3AF;flex-shrink:0;">${_esc(ts)}</div>
          </div>
          <div style="display:flex;align-items:center;gap:4px;">
            <div style="font-size:12px;color:#6B7280;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">${_esc(preview)}</div>
            ${c.unread ? `<div style="width:8px;height:8px;background:#1C2B3A;border-radius:50%;flex-shrink:0;"></div>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');

  drop.innerHTML = `
    <div style="padding:.6rem 1rem;border-bottom:.5px solid #E2DDD6;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;">
      <span style="font-size:13px;font-weight:600;color:#1C2B3A;">Messages</span>
      <button onclick="window._openMessagingConv(null);document.getElementById('chat-drop').style.display='none';" style="font-size:12px;color:#C9A84C;background:none;border:none;cursor:pointer;font-family:'Inter',sans-serif;font-weight:600;padding:0;">+ New</button>
    </div>
    <div style="overflow-y:auto;flex:1;">${rows || '<div style="padding:1.5rem 1rem;text-align:center;font-size:13px;color:#9CA3AF;font-style:italic;">No conversations yet.</div>'}</div>
    <div style="padding:.6rem 1rem;border-top:.5px solid #E2DDD6;text-align:center;flex-shrink:0;">
      <button onclick="window.switchPanel('messaging',{title:'Messages'});document.getElementById('chat-drop').style.display='none';" style="font-size:12.5px;color:#8B1A2F;background:none;border:none;cursor:pointer;font-family:'Inter',sans-serif;font-weight:500;">Show all messages →</button>
    </div>`;

  drop.querySelectorAll('.cd-avatar').forEach(slot => {
    const { uid, name, pid } = slot.dataset;
    createAvatar({ container: slot, userId: pid || uid, name: name || uid, size: 28 });
  });
  drop.querySelectorAll('.msg-group-av-slot').forEach(slot => {
    createAvatar({ container: slot, userId: slot.dataset.uid, name: slot.dataset.name || slot.dataset.uid, size: 28 });
  });
}

function _dropEmptyHtml() {
  return `
    <div style="padding:.6rem 1rem;border-bottom:.5px solid #F0EDE8;display:flex;justify-content:space-between;align-items:center;">
      <span style="font-size:13px;font-weight:600;color:#1C2B3A;">Messages</span>
      <button onclick="window._openMessagingConv(null)" style="font-size:12px;color:#8B1A2F;background:none;border:none;cursor:pointer;font-family:'Inter',sans-serif;padding:0;font-weight:500;">+ New</button>
    </div>
    <div style="padding:2rem 1rem;text-align:center;font-size:13px;color:#9CA3AF;font-style:italic;">No conversations yet.</div>
    <div style="padding:.6rem 1rem;border-top:.5px solid #F0EDE8;text-align:center;">
      <button onclick="window.switchPanel('messaging',{title:'Messages'});document.getElementById('chat-drop').style.display='none';" style="font-size:12.5px;color:#8B1A2F;background:none;border:none;cursor:pointer;font-family:'Inter',sans-serif;font-weight:500;">Show all messages →</button>
    </div>`;
}

// ── Data ───────────────────────────────────────────────────────────────────

async function _loadConversations() {
  if (!_currentUserId) return;

  const { data: myParts } = await sb.from('conversation_participants')
    .select('conversation_id, last_read_at, pinned')
    .eq('user_id', _currentUserId);

  if (!myParts?.length) { _conversations = []; return; }

  const convIds = myParts.map(p => p.conversation_id);

  const [allPartsRes, msgsRes, convsRes] = await Promise.all([
    sb.from('conversation_participants')
      .select('conversation_id, user_id')
      .in('conversation_id', convIds),
    sb.from('messages')
      .select('*')
      .in('conversation_id', convIds)
      .order('created_at', { ascending: false }),
    sb.from('conversations')
      .select('id, deleted_at, is_group, name')
      .in('id', convIds),
  ]);

  const allParts  = allPartsRes.data || [];
  const allMsgs   = msgsRes.data     || [];
  const convMeta  = convsRes.data    || [];

  const convInfoMap = {};
  convMeta.forEach(c => { convInfoMap[c.id] = c; });

  const myPinnedMap = {};
  myParts.forEach(p => { myPinnedMap[p.conversation_id] = !!p.pinned; });

  const otherUserIds = [...new Set(
    allParts.filter(p => p.user_id !== _currentUserId).map(p => p.user_id),
  )];

  if (otherUserIds.length) {
    const { data: profiles } = await sb.from('user_profiles')
      .select('user_id, personnel_id, personnel(id,name)')
      .in('user_id', otherUserIds);
    (profiles || []).forEach(p => {
      _userProfileMap[p.user_id] = { name: p.personnel?.name || 'User', personnelId: p.personnel_id };
    });
  }

  const lastReadMap = {};
  myParts.forEach(p => { lastReadMap[p.conversation_id] = p.last_read_at; });

  const msgsByConv = {};
  allMsgs.forEach(m => {
    if (!msgsByConv[m.conversation_id]) msgsByConv[m.conversation_id] = [];
    msgsByConv[m.conversation_id].push(m);
  });

  const partsByConv = {};
  allParts.forEach(p => {
    if (!partsByConv[p.conversation_id]) partsByConv[p.conversation_id] = [];
    partsByConv[p.conversation_id].push(p);
  });

  _conversations = convIds.map(cid => {
    const info    = convInfoMap[cid] || {};
    const msgs    = msgsByConv[cid]  || [];
    const lastMsg = msgs[0] || null;
    const lr      = lastReadMap[cid];
    const unreadCount = msgs.filter(m =>
      m.sender_id !== _currentUserId && (!lr || new Date(m.created_at) > new Date(lr)),
    ).length;

    const participants = (partsByConv[cid] || []).map(p => ({
      userId: p.user_id,
      name: _userProfileMap[p.user_id]?.name || 'User',
      personnelId: _userProfileMap[p.user_id]?.personnelId || null,
    }));

    let otherUserId = null, otherName = 'Unknown', otherPersonnelId = null, displayName;
    if (info.is_group) {
      const others = participants.filter(p => p.userId !== _currentUserId);
      displayName = info.name || _truncate(others.map(p => p.name).join(', '), 30);
    } else {
      const otherPart = (partsByConv[cid] || []).find(p => p.user_id !== _currentUserId);
      otherUserId = otherPart?.user_id || null;
      const otherProfile = otherUserId ? _userProfileMap[otherUserId] : null;
      otherName = otherProfile?.name || 'Unknown';
      otherPersonnelId = otherProfile?.personnelId || null;
      displayName = otherName;
    }

    return {
      id: cid,
      isGroup: !!info.is_group,
      name: info.name || null,
      displayName,
      participants,
      otherUserId,
      otherName,
      otherPersonnelId,
      lastMsg,
      unreadCount,
      updatedAt:  lastMsg?.created_at || '',
      deletedAt: info.deleted_at || null,
      pinned:    myPinnedMap[cid] || false,
    };
  }).sort((a, b) => {
    if (!a.deletedAt && !b.deletedAt) {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

async function _loadInitialUnread() {
  if (!_currentUserId) return;
  const { data: myParts } = await sb.from('conversation_participants')
    .select('conversation_id, last_read_at').eq('user_id', _currentUserId);
  if (!myParts?.length) { _setBadge(0); return; }
  const convIds = myParts.map(p => p.conversation_id);

  // Only count unread in non-deleted conversations
  const { data: convMeta } = await sb.from('conversations')
    .select('id, deleted_at').in('id', convIds);
  const activeIds = new Set((convMeta || []).filter(c => !c.deleted_at).map(c => c.id));

  const { data: msgs } = await sb.from('messages')
    .select('conversation_id, sender_id, created_at')
    .in('conversation_id', [...activeIds])
    .neq('sender_id', _currentUserId);
  const lrMap = {};
  myParts.forEach(p => { lrMap[p.conversation_id] = p.last_read_at; });
  let unread = 0;
  (msgs || []).forEach(m => {
    const lr = lrMap[m.conversation_id];
    if (!lr || new Date(m.created_at) > new Date(lr)) unread++;
  });
  _setBadge(unread);
}

// ── Render ─────────────────────────────────────────────────────────────────

function _render(el) {
  const mobile = window.innerWidth < 768;
  el.style.cssText = 'height:calc(100vh - 60px);display:flex;overflow:hidden;';

  if (mobile) {
    el.innerHTML = `<div id="msg-mobile-pane" style="flex:1;display:flex;flex-direction:column;overflow:hidden;"></div>`;
    const pane = document.getElementById('msg-mobile-pane');
    if (_activeConvId) {
      pane.innerHTML = _threadHtml(true);
      _hydrateThread();
    } else {
      pane.innerHTML = _convListHtml();
      _hydrateConvList();
    }
  } else {
    el.innerHTML = `
      <div id="msg-list-col" style="width:280px;flex-shrink:0;border-right:.5px solid #E2DDD6;display:flex;flex-direction:column;overflow:hidden;background:#fff;">
        ${_convListHtml()}
      </div>
      <div id="msg-thread-col" style="flex:1;display:flex;flex-direction:column;overflow:hidden;">
        ${_activeConvId ? _threadHtml(false) : _emptyThreadHtml()}
      </div>`;
    _hydrateConvList();
    if (_activeConvId) _hydrateThread();
  }
}

function _convListHtml() {
  const newBtn = `
    <div style="padding:.75rem 1rem;border-bottom:.5px solid #E2DDD6;flex-shrink:0;">
      <button id="msg-new-btn" style="
        width:100%;padding:.45rem .9rem;background:#C9A84C;color:#fff;border:none;
        border-radius:6px;font-size:13px;font-family:'Inter',sans-serif;
        cursor:pointer;font-weight:500;display:flex;align-items:center;justify-content:center;gap:6px;
      "><i class="fa-solid fa-pen-to-square" style="font-size:12px;"></i> New Message</button>
    </div>`;

  const active  = _conversations.filter(c => !c.deletedAt);
  const deleted = _conversations.filter(c => !!c.deletedAt)
    .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));

  const activeRows = active.map(c => _convRowHtml(c)).join('');

  const deletedRows = deleted.map(c => {
    const preview  = c.lastMsg ? _truncate(c.lastMsg.body, 32) : 'No messages';
    const delDate  = new Date(c.deletedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `
      <div class="msg-deleted-row" data-conv-id="${c.id}"
        style="display:flex;align-items:center;gap:8px;padding:.6rem 1rem;border-bottom:.5px solid #F8F7F4;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:12.5px;color:#9CA3AF;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(c.displayName)}</div>
          <div style="font-size:11.5px;color:#C0BAB2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(preview)}</div>
          <div style="font-size:10.5px;color:#C0BAB2;margin-top:1px;">Deleted ${_esc(delDate)}</div>
        </div>
        <button class="msg-restore-btn" data-conv-id="${c.id}" style="
          flex-shrink:0;font-size:11.5px;color:#8B1A2F;background:none;
          border:.5px solid #E2DDD6;border-radius:4px;padding:2px 8px;
          cursor:pointer;font-family:'Inter',sans-serif;white-space:nowrap;
        ">Restore</button>
      </div>`;
  }).join('');

  const deletedSection = deleted.length ? `
    <div style="flex-shrink:0;">
      <button id="msg-deleted-toggle" style="
        width:100%;text-align:left;padding:.5rem 1rem;background:none;border:none;
        border-top:.5px solid #F0EDE8;cursor:pointer;font-family:'Inter',sans-serif;
        font-size:11.5px;color:#9CA3AF;font-style:italic;display:flex;align-items:center;gap:6px;
      ">
        <span id="msg-deleted-arrow" style="font-size:10px;">▶</span>
        Deleted Messages (${deleted.length})
      </button>
      <div id="msg-deleted-list" style="display:none;background:#FAFAF8;">${deletedRows}</div>
    </div>` : '';

  if (!active.length && !deleted.length) {
    return newBtn + `<div style="padding:2rem 1rem;text-align:center;font-size:13px;color:#9CA3AF;font-style:italic;">No conversations yet.</div>`;
  }

  return newBtn + `
    <div id="msg-conv-items" style="overflow-y:auto;flex:1;display:flex;flex-direction:column;">
      <div>${activeRows || '<div style="padding:1.5rem 1rem;text-align:center;font-size:13px;color:#9CA3AF;font-style:italic;">No active conversations.</div>'}</div>
      ${deletedSection}
    </div>`;
}

function _convRowHtml(c) {
  const isActive = c.id === _activeConvId;
  const preview  = c.lastMsg ? _truncate(c.lastMsg.body, 34) : 'No messages yet';
  const ts       = c.lastMsg ? _relTime(c.lastMsg.created_at) : '';
  const hasBold  = c.unreadCount > 0;

  const others   = c.isGroup ? c.participants.filter(p => p.userId !== _currentUserId) : [];
  const avatarEl = c.isGroup
    ? _groupAvatarClusterHtml(others, 3, 28, 10)
    : `<div class="msg-avatar-slot" data-uid="${c.otherUserId || ''}" data-name="${_esc(c.otherName)}" style="flex-shrink:0;width:36px;height:36px;border-radius:50%;background:#E2DDD6;"></div>`;

  return `
    <div class="msg-conv-row" data-conv-id="${c.id}" style="
      position:relative;display:flex;align-items:center;gap:10px;padding:.75rem 1rem;cursor:pointer;
      background:${isActive ? '#F8F7F4' : '#fff'};border-bottom:.5px solid #F0EDE8;
    ">
      ${avatarEl}
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;margin-bottom:2px;">
          <div style="display:flex;align-items:center;gap:5px;min-width:0;">
            ${c.pinned ? `<i class="fa-solid fa-thumbtack" style="color:#C9A84C;font-size:10px;flex-shrink:0;transform:rotate(45deg);"></i>` : ''}
            ${c.isGroup ? `<i class="fa-solid fa-users" style="color:#9CA3AF;font-size:10px;flex-shrink:0;"></i>` : ''}
            <div style="font-size:13.5px;font-weight:${hasBold ? '600' : '500'};color:#1C2B3A;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(c.displayName)}</div>
          </div>
          <div style="font-size:11px;color:#9CA3AF;flex-shrink:0;">${_esc(ts)}</div>
        </div>
        <div style="display:flex;align-items:center;gap:4px;">
          <div style="font-size:12.5px;color:#6B7280;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">${_esc(preview)}</div>
          ${c.unreadCount ? `<div style="flex-shrink:0;width:18px;height:18px;background:#1C2B3A;border-radius:50%;display:flex;align-items:center;justify-content:center;"><span style="font-size:9px;color:#fff;font-weight:700;">${c.unreadCount > 9 ? '9+' : c.unreadCount}</span></div>` : ''}
        </div>
      </div>
      <div class="msg-row-actions" style="display:none;flex-shrink:0;align-items:center;gap:2px;">
        <button class="msg-pin-btn" data-conv-id="${c.id}" title="${c.pinned ? 'Unpin' : 'Pin conversation'}" style="
          background:none;border:none;cursor:pointer;
          color:${c.pinned ? '#C9A84C' : '#C0BAB2'};font-size:12px;padding:2px 4px;line-height:1;
        "><i class="fa-solid fa-thumbtack"></i></button>
        <button class="msg-delete-btn" data-conv-id="${c.id}" title="Delete conversation" style="
          background:none;border:none;cursor:pointer;
          color:#C0BAB2;font-size:13px;padding:2px 4px;line-height:1;
        ">✕</button>
      </div>
    </div>`;
}

async function _pinConversation(convId) {
  const conv = _conversations.find(c => c.id === convId);
  if (!conv) return;
  const newPinned = !conv.pinned;
  await sb.from('conversation_participants')
    .update({ pinned: newPinned })
    .eq('conversation_id', convId)
    .eq('user_id', _currentUserId);
  conv.pinned = newPinned;
  _conversations.sort((a, b) => {
    if (!a.deletedAt && !b.deletedAt) {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  });
  const listCol = document.getElementById('msg-list-col');
  if (listCol) { listCol.innerHTML = _convListHtml(); _hydrateConvList(); }
  else {
    const el = document.getElementById('messaging-root');
    if (el) _render(el);
  }
}

function _emptyThreadHtml() {
  return `
    <div style="flex:1;display:flex;align-items:center;justify-content:center;padding:2rem;text-align:center;">
      <div>
        <div style="font-size:40px;margin-bottom:1rem;">💬</div>
        <div style="font-family:'Cormorant Garamond',Georgia,serif;font-size:22px;font-weight:600;color:#C9A84C;margin-bottom:.5rem;">Messages</div>
        <div style="font-size:13px;color:#9CA3AF;">Select a conversation or start a new one.</div>
      </div>
    </div>`;
}

function _threadHtml(mobile) {
  const conv = _conversations.find(c => c.id === _activeConvId);
  const displayName = conv?.displayName || 'Conversation';
  const uid   = conv?.otherUserId || '';
  const pid   = conv?.otherPersonnelId || '';
  const isGroup = conv?.isGroup || false;

  const headerOthers = isGroup ? (conv?.participants || []).filter(p => p.userId !== _currentUserId) : [];
  const avatarEl = isGroup
    ? _groupAvatarClusterHtml(headerOthers, 4, 30, 10)
    : `<div id="msg-thread-avatar-slot" data-uid="${uid}" data-name="${_esc(displayName)}" data-pid="${pid}" style="width:32px;height:32px;border-radius:50%;background:#E2DDD6;flex-shrink:0;"></div>`;

  const groupBtn = isGroup
    ? `<button id="msg-participants-btn" title="View participants" style="
        margin-left:auto;background:none;border:none;cursor:pointer;
        color:#9CA3AF;font-size:15px;padding:4px 6px;line-height:1;
      "><i class="fa-solid fa-user-group"></i></button>`
    : '';

  return `
    <div style="display:flex;flex-direction:column;height:100%;">
      <div style="padding:.75rem 1rem;border-bottom:.5px solid #E2DDD6;display:flex;align-items:center;gap:10px;background:#fff;flex-shrink:0;">
        ${mobile ? `<button id="msg-back-btn" style="background:none;border:none;cursor:pointer;color:#8B1A2F;font-size:22px;padding:0;line-height:1;margin-right:2px;">‹</button>` : ''}
        ${avatarEl}
        <div style="font-size:14px;font-weight:600;color:#1C2B3A;">${_esc(displayName)}</div>
        ${groupBtn}
      </div>
      <div id="msg-messages" style="flex:1;overflow-y:auto;padding:1rem;display:flex;flex-direction:column;background:#FAFAF8;"></div>
      <div style="padding:.75rem 1rem;border-top:.5px solid #E2DDD6;background:#fff;flex-shrink:0;display:flex;gap:8px;align-items:flex-end;">
        <textarea id="msg-input" placeholder="Type a message…" rows="1" style="
          flex:1;resize:none;border:.5px solid #D1C9BE;border-radius:18px;
          padding:8px 14px;font-size:13px;font-family:'Inter',sans-serif;
          outline:none;background:#fff;max-height:120px;overflow-y:auto;line-height:1.4;
        "></textarea>
        <button id="msg-send-btn" style="
          flex-shrink:0;width:36px;height:36px;background:#8B1A2F;color:#fff;border:none;
          border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:13px;
        "><i class="fa-solid fa-paper-plane"></i></button>
      </div>
    </div>`;
}

function _renderMessages() {
  const el = document.getElementById('msg-messages');
  if (!el) return;

  const conv = _conversations.find(c => c.id === _activeConvId);
  const isGroup = conv?.isGroup || false;

  if (!_messages.length) {
    el.innerHTML = `<div style="text-align:center;font-size:13px;color:#9CA3AF;font-style:italic;padding:2rem 0;margin:auto;">No messages yet. Say hello!</div>`;
    return;
  }

  const items = _groupMessages(_messages);
  el.innerHTML = items.map(item => {
    if (item.type === 'date') {
      return `
        <div style="display:flex;align-items:center;gap:10px;margin:16px 0 12px;">
          <div style="flex:1;height:.5px;background:#E2DDD6;"></div>
          <div style="font-size:11px;color:#9CA3AF;font-weight:500;letter-spacing:.5px;white-space:nowrap;text-transform:uppercase;">${_esc(item.date)}</div>
          <div style="flex:1;height:.5px;background:#E2DDD6;"></div>
        </div>`;
    }
    const { msg, isFirst, isLast, isMine } = item;
    const uid  = msg.sender_id || '';
    const prof = uid === _currentUserId ? null : (_userProfileMap[uid] || { name: 'User', personnelId: null });
    const name = prof?.name || '';
    const pid  = prof?.personnelId || '';
    const avatarSlot = !isMine
      ? (isLast
          ? `<div class="msg-inline-avatar" data-uid="${uid}" data-name="${_esc(name)}" data-pid="${pid}" style="width:28px;height:28px;border-radius:50%;background:#E2DDD6;flex-shrink:0;align-self:flex-end;"></div>`
          : `<div style="width:28px;flex-shrink:0;"></div>`)
      : '';
    // In group chats, show sender name on first message in each bubble group
    const showSenderName = !isMine && isFirst && (isGroup || true);
    return `
      <div style="display:flex;align-items:flex-end;gap:6px;justify-content:${isMine ? 'flex-end' : 'flex-start'};margin-top:${isFirst ? '8px' : '2px'};">
        ${!isMine ? avatarSlot : ''}
        <div style="max-width:70%;display:flex;flex-direction:column;${isMine ? 'align-items:flex-end;' : 'align-items:flex-start;'}">
          ${showSenderName ? `<div style="font-size:11px;color:#9CA3AF;margin-bottom:2px;margin-left:4px;">${_esc(name)}</div>` : ''}
          <div style="
            background:${isMine ? '#1C2B3A' : '#F0F0F0'};
            color:${isMine ? '#fff' : '#1C2B3A'};
            border-radius:18px;
            ${isMine ? 'border-bottom-right-radius:5px;' : 'border-bottom-left-radius:5px;'}
            padding:10px 14px;font-size:13px;line-height:1.4;word-break:break-word;white-space:pre-wrap;
          ">${_esc(msg.body)}</div>
          ${isLast ? `<div style="font-size:10.5px;color:#9CA3AF;margin-top:3px;${isMine ? 'margin-right:3px;' : 'margin-left:3px;'}">${_relTime(msg.created_at)}</div>` : ''}
        </div>
      </div>`;
  }).join('');

  el.querySelectorAll('.msg-inline-avatar').forEach(slot => {
    const { uid, name } = slot.dataset;
    createAvatar({ container: slot, userId: uid, name: name || uid, size: 28 });
  });

  el.scrollTop = el.scrollHeight;
}

function _groupMessages(msgs) {
  const out = [];
  let lastDate   = null;
  let lastSender = null;
  let lastTime   = null;
  for (let i = 0; i < msgs.length; i++) {
    const m     = msgs[i];
    const d     = _dateLabel(m.created_at);
    const mTime = new Date(m.created_at).getTime();
    if (d !== lastDate) {
      out.push({ type: 'date', date: d });
      lastDate = d; lastSender = null; lastTime = null;
    }
    const gapMins  = lastTime ? (mTime - lastTime) / 60000 : Infinity;
    const isFirst  = m.sender_id !== lastSender || gapMins > 2;
    const next     = msgs[i + 1];
    const nextTime = next ? new Date(next.created_at).getTime() : null;
    const nextGap  = nextTime ? (nextTime - mTime) / 60000 : Infinity;
    const isLast   = !next || next.sender_id !== m.sender_id || _dateLabel(next.created_at) !== d || nextGap > 2;
    out.push({ type: 'msg', msg: m, isFirst, isLast, isMine: m.sender_id === _currentUserId });
    lastSender = isLast ? null : m.sender_id;
    lastTime   = isLast ? null : mTime;
  }
  return out;
}

function _hydrateConvList() {
  document.querySelectorAll('.msg-avatar-slot').forEach(slot => {
    const { uid, name } = slot.dataset;
    createAvatar({ container: slot, userId: uid, name: name || uid, size: 36 });
  });
  document.querySelectorAll('.msg-group-av-slot').forEach(slot => {
    createAvatar({ container: slot, userId: slot.dataset.uid, name: slot.dataset.name || slot.dataset.uid, size: 28 });
  });

  document.querySelectorAll('.msg-conv-row').forEach(row => {
    const actions = row.querySelector('.msg-row-actions');
    const pinBtn  = row.querySelector('.msg-pin-btn');
    const delBtn  = row.querySelector('.msg-delete-btn');
    row.addEventListener('mouseenter', () => {
      if (row.dataset.convId !== _activeConvId) row.style.background = '#F8F7F4';
      if (actions) actions.style.display = 'flex';
    });
    row.addEventListener('mouseleave', () => {
      if (row.dataset.convId !== _activeConvId) row.style.background = '#fff';
      if (actions) actions.style.display = 'none';
    });
    row.addEventListener('click', e => {
      if (e.target.closest('.msg-row-actions')) return;
      _openConversation(row.dataset.convId);
    });
    if (pinBtn) {
      pinBtn.addEventListener('click', e => {
        e.stopPropagation();
        _pinConversation(pinBtn.dataset.convId);
      });
    }
    if (delBtn) {
      delBtn.addEventListener('click', e => {
        e.stopPropagation();
        _deleteConversation(delBtn.dataset.convId);
      });
    }
  });

  document.querySelectorAll('.msg-restore-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      _restoreConversation(btn.dataset.convId);
    });
  });

  const toggle = document.getElementById('msg-deleted-toggle');
  const list   = document.getElementById('msg-deleted-list');
  const arrow  = document.getElementById('msg-deleted-arrow');
  if (toggle && list) {
    let open = false;
    toggle.addEventListener('click', () => {
      open = !open;
      list.style.display  = open ? 'block' : 'none';
      if (arrow) arrow.textContent = open ? '▼' : '▶';
    });
  }

  document.getElementById('msg-new-btn')?.addEventListener('click', _openNewMessageModal);
}

async function _deleteConversation(convId) {
  if (!confirm('Delete this conversation? It will be permanently removed after 14 days.')) return;
  await sb.from('conversations').update({ deleted_at: new Date().toISOString() }).eq('id', convId);
  const conv = _conversations.find(c => c.id === convId);
  if (conv) conv.deletedAt = new Date().toISOString();
  if (_activeConvId === convId) {
    _activeConvId = null;
    _messages = [];
    if (_msgChannel) { sb.removeChannel(_msgChannel); _msgChannel = null; }
  }
  const el = document.getElementById('messaging-root');
  if (el) _render(el);
}

async function _restoreConversation(convId) {
  await sb.from('conversations').update({ deleted_at: null }).eq('id', convId);
  const conv = _conversations.find(c => c.id === convId);
  if (conv) conv.deletedAt = null;
  const el = document.getElementById('messaging-root');
  if (el) _render(el);
}

function _hydrateThread() {
  const conv = _conversations.find(c => c.id === _activeConvId);

  const headerSlot = document.getElementById('msg-thread-avatar-slot');
  if (headerSlot) {
    const { uid, name, pid } = headerSlot.dataset;
    createAvatar({ container: headerSlot, userId: uid, name: name || uid, size: 32 });
  }
  // Group header cluster slots
  document.querySelectorAll('#msg-thread-col .msg-group-av-slot, #msg-mobile-pane .msg-group-av-slot').forEach(slot => {
    createAvatar({ container: slot, userId: slot.dataset.uid, name: slot.dataset.name || slot.dataset.uid, size: 30 });
  });

  _fetchAndRenderMessages();

  document.getElementById('msg-send-btn')?.addEventListener('click', _sendMessage);
  document.getElementById('msg-back-btn')?.addEventListener('click', () => {
    _activeConvId = null;
    _messages = [];
    if (_msgChannel) { sb.removeChannel(_msgChannel); _msgChannel = null; }
    const el = document.getElementById('messaging-root');
    if (el) _render(el);
  });

  if (conv?.isGroup) {
    document.getElementById('msg-participants-btn')?.addEventListener('click', () => {
      _openGroupParticipantsModal(conv);
    });
  }

  const input = document.getElementById('msg-input');
  if (input) {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _sendMessage(); }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });
    input.focus();
  }
}

// ── Open conversation ──────────────────────────────────────────────────────

async function _openConversation(convId) {
  if (_msgChannel) { sb.removeChannel(_msgChannel); _msgChannel = null; }
  _activeConvId = convId;
  _messages = [];

  await _markConversationRead(convId);

  const el = document.getElementById('messaging-root');
  if (el) _render(el);
}

async function _markConversationRead(convId) {
  await sb.from('conversation_participants')
    .update({ last_read_at: new Date().toISOString() })
    .eq('conversation_id', convId)
    .eq('user_id', _currentUserId);

  const conv = _conversations.find(c => c.id === convId);
  if (conv) conv.unreadCount = 0;
  _updateBadge();
}

async function _fetchAndRenderMessages() {
  if (!_activeConvId) return;

  // Mark as read whenever we display the thread (covers dropdown → panel navigation path)
  await _markConversationRead(_activeConvId);

  const { data } = await sb.from('messages')
    .select('*')
    .eq('conversation_id', _activeConvId)
    .order('created_at', { ascending: true });
  _messages = data || [];

  const unknown = [...new Set(_messages.map(m => m.sender_id).filter(id => id && id !== _currentUserId && !_userProfileMap[id]))];
  if (unknown.length) {
    const { data: profiles } = await sb.from('user_profiles')
      .select('user_id, personnel_id, personnel(name)')
      .in('user_id', unknown);
    (profiles || []).forEach(p => {
      _userProfileMap[p.user_id] = { name: p.personnel?.name || 'User', personnelId: p.personnel_id };
    });
  }

  _renderMessages();
  _subscribeToThread(_activeConvId);
}

function _subscribeToThread(convId) {
  if (_msgChannel) { sb.removeChannel(_msgChannel); _msgChannel = null; }
  _msgChannel = sb.channel('thread-' + convId)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'messages',
      filter: `conversation_id=eq.${convId}`,
    }, payload => {
      const msg = payload.new;
      if (_messages.find(m => m.id === msg.id)) return;
      _messages.push(msg);
      _renderMessages();
      if (msg.sender_id !== _currentUserId) {
        sb.from('conversation_participants')
          .update({ last_read_at: new Date().toISOString() })
          .eq('conversation_id', convId).eq('user_id', _currentUserId).then(() => {});
      }
    })
    .subscribe();
}

function _subscribeGlobal() {
  if (_globalChannel) { sb.removeChannel(_globalChannel); _globalChannel = null; }
  _globalChannel = sb.channel('global-dms-' + _currentUserId)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, payload => {
      const msg = payload.new;
      if (msg.sender_id === _currentUserId) return;
      const conv = _conversations.find(c => c.id === msg.conversation_id);
      if (!conv) return;
      if (conv.id === _activeConvId) return;
      conv.unreadCount = (conv.unreadCount || 0) + 1;
      conv.lastMsg = msg;
      conv.updatedAt = msg.created_at;
      _conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      _updateBadge();
      const listCol = document.getElementById('msg-list-col');
      if (listCol) {
        listCol.innerHTML = _convListHtml();
        _hydrateConvList();
      }
    })
    .subscribe();
}

// ── Send ───────────────────────────────────────────────────────────────────

async function _sendMessage() {
  const input = document.getElementById('msg-input');
  if (!input) return;
  const body = input.value.trim();
  if (!body || !_activeConvId) return;

  // Fix 3: if the active conversation is deleted, create a new one with same participants
  const activeConv = _conversations.find(c => c.id === _activeConvId);
  let targetConvId = _activeConvId;

  if (activeConv?.deletedAt) {
    const participants = activeConv.participants || [];
    const { data: newConv, error: ce } = await sb.from('conversations').insert({
      is_group: activeConv.isGroup || false,
      name: activeConv.name || null,
    }).select().single();
    if (ce) { console.error('[messaging] failed to recreate conversation:', ce); return; }
    await sb.from('conversation_participants').insert(
      participants.map(p => ({ conversation_id: newConv.id, user_id: p.userId }))
    );
    targetConvId = newConv.id;
    _activeConvId = newConv.id;
    await _loadConversations();
    const el = document.getElementById('messaging-root');
    if (el) _render(el);
  }

  input.value = '';
  input.style.height = 'auto';

  const { data: msg, error } = await sb.from('messages').insert({
    conversation_id: targetConvId,
    sender_id: _currentUserId,
    body,
  }).select().single();

  if (error) { console.error('[messaging] send failed:', error); return; }

  if (!_messages.find(m => m.id === msg.id)) {
    _messages.push(msg);
    _renderMessages();
  }

  const conv = _conversations.find(c => c.id === targetConvId);
  if (conv) {
    conv.lastMsg = msg;
    conv.updatedAt = msg.created_at;
    _conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

// ── New message modal ──────────────────────────────────────────────────────

function _openNewMessageModal() {
  let _picker = null;

  document.getElementById('modal-content').innerHTML = `
    <div class="modal-title">New Message</div>
    <div style="margin-bottom:.5rem;">
      <div style="font-size:11.5px;color:#6B7280;margin-bottom:6px;">Send to (select one or more):</div>
      <div id="msg-new-picker-wrap"></div>
    </div>
    <div style="margin-bottom:1rem;">
      <div style="font-size:11.5px;color:#6B7280;margin-bottom:4px;">Group name <span style="color:#C0BAB2;">(optional, for groups)</span></div>
      <input id="msg-new-group-name" placeholder="e.g. Planning Committee" style="
        width:100%;box-sizing:border-box;padding:.4rem .65rem;border:.5px solid #D1C9BE;
        border-radius:5px;font-size:13px;font-family:'Inter',sans-serif;outline:none;
      "/>
    </div>
    <div id="msg-new-status" style="font-size:12px;color:#8B1A2F;min-height:16px;margin-bottom:.5rem;"></div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button id="msg-new-start" class="btn-primary" disabled>Start Conversation</button>
    </div>`;
  document.getElementById('modal-overlay').classList.add('open');

  _picker = createContactPicker({
    container: document.getElementById('msg-new-picker-wrap'),
    placeholder: 'Search directory…',
    multiSelect: true,
    onSelect: persons => {
      const btn = document.getElementById('msg-new-start');
      if (btn) btn.disabled = !persons?.length;
    },
  });

  document.getElementById('msg-new-start')?.addEventListener('click', async () => {
    const persons = _picker?.getValue() || [];
    if (!persons.length) return;
    const statusEl = document.getElementById('msg-new-status');
    statusEl.textContent = 'Looking up accounts…';

    // Resolve each person to a user_id
    const resolved = await Promise.all(persons.map(async person => {
      if (!person?.id) return null;
      const { data: profile } = await sb.from('user_profiles')
        .select('user_id')
        .eq('personnel_id', person.id)
        .maybeSingle();
      if (!profile?.user_id) return { error: `${person.name || 'Someone'} does not have a ParishDesk account yet.` };
      if (profile.user_id === _currentUserId) return { error: 'You cannot message yourself.' };
      return { userId: profile.user_id, name: person.name, personnelId: person.id };
    }));

    const failed = resolved.find(r => !r || r.error);
    if (failed) { statusEl.textContent = failed?.error || 'Could not resolve all recipients.'; return; }

    const recipientIds = resolved.map(r => r.userId);
    const groupName = document.getElementById('msg-new-group-name')?.value.trim() || null;
    const isGroup = recipientIds.length > 1;

    statusEl.textContent = 'Opening conversation…';

    let convId;

    if (!isGroup) {
      // 1:1 — look for existing non-deleted, non-group conversation
      const recipientId = recipientIds[0];
      const { data: myParts }    = await sb.from('conversation_participants').select('conversation_id').eq('user_id', _currentUserId);
      const { data: theirParts } = await sb.from('conversation_participants').select('conversation_id').eq('user_id', recipientId);

      const allIds = [...new Set([...(myParts||[]), ...(theirParts||[])].map(p => p.conversation_id))];
      if (allIds.length) {
        const { data: convMeta } = await sb.from('conversations')
          .select('id, deleted_at, is_group').in('id', allIds);
        const activeDirectIds = new Set(
          (convMeta || []).filter(c => !c.deleted_at && !c.is_group).map(c => c.id)
        );
        const mySet    = new Set((myParts || []).filter(p => activeDirectIds.has(p.conversation_id)).map(p => p.conversation_id));
        const existing = (theirParts || []).find(p => mySet.has(p.conversation_id));
        if (existing) convId = existing.conversation_id;
      }

      if (!convId) {
        const { data: conv, error } = await sb.from('conversations').insert({ is_group: false }).select().single();
        if (error) { statusEl.textContent = 'Failed: ' + error.message; return; }
        convId = conv.id;
        await sb.from('conversation_participants').insert([
          { conversation_id: convId, user_id: _currentUserId },
          { conversation_id: convId, user_id: recipientId },
        ]);
        _userProfileMap[recipientId] = { name: resolved[0].name, personnelId: resolved[0].personnelId };
        _conversations.unshift({
          id: convId,
          isGroup: false,
          name: null,
          displayName: resolved[0].name,
          participants: [
            { userId: _currentUserId, name: _userProfileMap[_currentUserId]?.name || 'Me', personnelId: null },
            { userId: recipientId, name: resolved[0].name, personnelId: resolved[0].personnelId },
          ],
          otherUserId: recipientId,
          otherName: resolved[0].name,
          otherPersonnelId: resolved[0].personnelId,
          lastMsg: null, unreadCount: 0, updatedAt: '', deletedAt: null, pinned: false,
        });
      }
    } else {
      // Group conversation — always create new
      const { data: conv, error } = await sb.from('conversations').insert({
        is_group: true,
        name: groupName || null,
      }).select().single();
      if (error) { statusEl.textContent = 'Failed: ' + error.message; return; }
      convId = conv.id;
      const allParticipants = [_currentUserId, ...recipientIds];
      await sb.from('conversation_participants').insert(
        allParticipants.map(uid => ({ conversation_id: convId, user_id: uid }))
      );
      resolved.forEach(r => { _userProfileMap[r.userId] = { name: r.name, personnelId: r.personnelId }; });
      const others = resolved.map(r => r.name);
      const displayName = groupName || _truncate(others.join(', '), 30);
      const participants = [
        { userId: _currentUserId, name: _userProfileMap[_currentUserId]?.name || 'Me', personnelId: null },
        ...resolved.map(r => ({ userId: r.userId, name: r.name, personnelId: r.personnelId })),
      ];
      _conversations.unshift({
        id: convId,
        isGroup: true,
        name: groupName || null,
        displayName,
        participants,
        otherUserId: null,
        otherName: displayName,
        otherPersonnelId: null,
        lastMsg: null, unreadCount: 0, updatedAt: '', deletedAt: null, pinned: false,
      });
    }

    closeModal();
    _openConversation(convId);
  });
}

// ── Group participants modal ───────────────────────────────────────────────

function _openGroupParticipantsModal(conv) {
  const rows = (conv.participants || []).map(p => {
    const isMe = p.userId === _currentUserId;
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:.55rem 0;border-bottom:.5px solid #F0EDE8;">
        <div class="gp-avatar" data-uid="${p.userId}" data-name="${_esc(p.name)}"
          style="width:30px;height:30px;border-radius:50%;background:#E2DDD6;flex-shrink:0;"></div>
        <div style="flex:1;font-size:13px;color:#1C2B3A;">${_esc(p.name)}${isMe ? ' <span style="font-size:11px;color:#9CA3AF;">(you)</span>' : ''}</div>
      </div>`;
  }).join('');

  document.getElementById('modal-content').innerHTML = `
    <div class="modal-title">${_esc(conv.displayName)}</div>
    <div style="font-size:11.5px;color:#6B7280;margin-bottom:.75rem;">${conv.participants.length} participants</div>
    <div style="margin-bottom:1rem;">${rows}</div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Close</button>
      <button id="gp-leave-btn" style="
        background:none;border:.5px solid #8B1A2F;color:#8B1A2F;border-radius:6px;
        padding:.4rem .9rem;font-size:13px;font-family:'Inter',sans-serif;cursor:pointer;
      ">Leave group</button>
    </div>`;
  document.getElementById('modal-overlay').classList.add('open');

  document.querySelectorAll('.gp-avatar').forEach(slot => {
    createAvatar({ container: slot, userId: slot.dataset.uid, name: slot.dataset.name || slot.dataset.uid, size: 30 });
  });

  document.getElementById('gp-leave-btn')?.addEventListener('click', async () => {
    if (!confirm('Leave this group conversation? You will no longer receive messages from it.')) return;
    await sb.from('conversations').update({ deleted_at: new Date().toISOString() }).eq('id', conv.id);
    const c = _conversations.find(x => x.id === conv.id);
    if (c) c.deletedAt = new Date().toISOString();
    if (_activeConvId === conv.id) {
      _activeConvId = null;
      _messages = [];
      if (_msgChannel) { sb.removeChannel(_msgChannel); _msgChannel = null; }
    }
    closeModal();
    const el = document.getElementById('messaging-root');
    if (el) _render(el);
  });
}

// ── Badge ──────────────────────────────────────────────────────────────────

function _updateBadge() {
  const total = _conversations
    .filter(c => !c.deletedAt)
    .reduce((sum, c) => sum + (c.unreadCount || 0), 0);
  _setBadge(total);
}

function _setBadge(n) {
  const badge = document.getElementById('chat-badge');
  if (!badge) return;
  if (n > 0) {
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

// ── Group avatar cluster ───────────────────────────────────────────────────

// Returns an HTML string with overlapping avatar slots (rightmost on top).
// `others` = array of {userId, name}
function _groupAvatarClusterHtml(others, maxShown, size, offset) {
  const shown = others.slice(0, maxShown);
  const extra = others.length - shown.length;
  const containerWidth = size + Math.max(0, shown.length - 1 + (extra ? 1 : 0)) * offset;

  let html = `<div style="position:relative;width:${containerWidth}px;height:${size}px;flex-shrink:0;">`;
  shown.forEach((p, i) => {
    html += `<div class="msg-group-av-slot" data-uid="${p.userId || ''}" data-name="${_esc(p.name)}"
      style="position:absolute;left:${i * offset}px;z-index:${i + 1};
             width:${size}px;height:${size}px;border-radius:50%;
             box-sizing:border-box;border:2px solid #fff;overflow:hidden;background:#E2DDD6;"></div>`;
  });
  if (extra > 0) {
    const fs = Math.round(size * 0.36);
    html += `<div style="position:absolute;left:${shown.length * offset}px;z-index:0;
      width:${size}px;height:${size}px;border-radius:50%;background:#C4BDB3;
      box-sizing:border-box;border:2px solid #fff;
      display:flex;align-items:center;justify-content:center;
      font-size:${fs}px;color:#fff;font-weight:700;font-family:'Inter',sans-serif;">+${extra}</div>`;
  }
  html += '</div>';
  return html;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.substring(0, len) + '…' : str;
}

function _relTime(ts) {
  if (!ts) return '';
  const d    = new Date(ts);
  const diff = Date.now() - d;
  const min  = Math.floor(diff / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(diff / 3600000);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(diff / 86400000);
  if (day < 7) return `${day}d`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function _dateLabel(ts) {
  const d   = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === new Date(Date.now() - 86400000).toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}
