import { sb } from '../supabase.js';
import { createAvatar } from './avatar.js';

const _subs = {}; // discussion_id → realtime channel

// ── Public ─────────────────────────────────────────────────────────────────

export async function renderDiscussionThread({ container, contextType, contextId }) {
  if (!container) return;
  container.innerHTML = `<div style="font-size:13px;color:#9CA3AF;padding:2rem;text-align:center;">Loading discussions…</div>`;

  const { data: { user } } = await sb.auth.getUser();
  const currentUserId = user?.id;
  if (!currentUserId) { container.innerHTML = '<div style="padding:2rem;color:#9CA3AF;">Not signed in.</div>'; return; }

  const { data: discussions } = await sb.from('discussions')
    .select('id, title, created_by, created_at, updated_at')
    .eq('context_type', contextType)
    .eq('context_id', contextId)
    .order('updated_at', { ascending: false });

  const list = discussions || [];

  // Profile map for creators
  const profileMap = {};
  const creatorIds = [...new Set(list.map(d => d.created_by).filter(Boolean))];
  if (creatorIds.length) {
    const { data: profs } = await sb.from('user_profiles')
      .select('user_id, personnel_id, personnel(name)')
      .in('user_id', creatorIds);
    (profs || []).forEach(p => { profileMap[p.user_id] = { name: p.personnel?.name || 'User', personnelId: p.personnel_id }; });
  }

  let _expandedId = null;

  function rerender() {
    const count = list.length;
    container.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;">
        <div style="font-size:13px;font-weight:600;color:#1C2B3A;">${count} Thread${count !== 1 ? 's' : ''}</div>
        <button id="disc-new-btn" style="
          padding:.35rem .85rem;background:#C9A84C;color:#fff;border:none;
          border-radius:5px;font-size:12.5px;font-family:'Inter',sans-serif;cursor:pointer;font-weight:500;
        ">+ New Thread</button>
      </div>
      ${count === 0
        ? `<div style="text-align:center;padding:3rem 1rem;color:#9CA3AF;font-size:13px;font-style:italic;">No discussions yet. Start one!</div>`
        : list.map(d => _discRowHtml(d, profileMap, _expandedId === d.id)).join('')}`;

    // Hydrate creator avatars
    container.querySelectorAll('.disc-creator-slot').forEach(slot => {
      const { uid, name, pid } = slot.dataset;
      createAvatar({ container: slot, userId: pid || uid, name: name || uid, size: 28 });
    });

    document.getElementById('disc-new-btn')?.addEventListener('click', () => {
      _openNewThreadModal({ contextType, contextId, currentUserId, list, profileMap, onCreated: rerender });
    });

    container.querySelectorAll('.disc-row-header').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.discId;
        if (_expandedId === id) {
          // Close: unsubscribe
          if (_subs[id]) { sb.removeChannel(_subs[id]); delete _subs[id]; }
          _expandedId = null;
        } else {
          if (_expandedId && _subs[_expandedId]) { sb.removeChannel(_subs[_expandedId]); delete _subs[_expandedId]; }
          _expandedId = id;
        }
        rerender();
        if (_expandedId) _loadThread(_expandedId, currentUserId, profileMap);
      });
    });
  }

  rerender();
}

// ── Thread loading ─────────────────────────────────────────────────────────

async function _loadThread(discId, currentUserId, profileMap) {
  const el = document.getElementById('disc-thread-' + discId);
  if (!el) return;
  el.innerHTML = `<div style="font-size:12px;color:#9CA3AF;padding:.5rem 0;">Loading…</div>`;

  const { data: rawMsgs } = await sb.from('discussion_messages')
    .select('*')
    .eq('discussion_id', discId)
    .order('created_at', { ascending: true });

  const msgs = rawMsgs || [];

  // Fill in any unknown senders
  const unknown = [...new Set(msgs.map(m => m.sender_id).filter(id => id && !profileMap[id]))];
  if (unknown.length) {
    const { data: profs } = await sb.from('user_profiles')
      .select('user_id, personnel_id, personnel(name)').in('user_id', unknown);
    (profs || []).forEach(p => { profileMap[p.user_id] = { name: p.personnel?.name || 'User', personnelId: p.personnel_id }; });
  }

  function renderMsgs() {
    const msgsHtml = msgs.length === 0
      ? `<div style="font-size:12.5px;color:#9CA3AF;font-style:italic;padding:.5rem 0 .75rem;">No replies yet — be the first!</div>`
      : msgs.map(m => {
          const isMine = m.sender_id === currentUserId;
          const prof   = profileMap[m.sender_id] || { name: 'User', personnelId: null };
          return `
            <div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:.75rem;justify-content:${isMine ? 'flex-end' : 'flex-start'};">
              ${!isMine ? `<div class="disc-msg-avatar" data-uid="${m.sender_id || ''}" data-name="${_esc(prof.name)}" data-pid="${prof.personnelId || ''}" style="width:24px;height:24px;border-radius:50%;background:#E2DDD6;flex-shrink:0;margin-top:2px;"></div>` : ''}
              <div style="max-width:75%;display:flex;flex-direction:column;${isMine ? 'align-items:flex-end;' : 'align-items:flex-start;'}">
                <div style="font-size:11px;color:#9CA3AF;margin-bottom:2px;">
                  ${isMine ? '' : `${_esc(prof.name)} · `}${_relTime(m.created_at)}
                </div>
                <div style="
                  background:${isMine ? '#1C2B3A' : '#F0F0F0'};
                  color:${isMine ? '#fff' : '#1C2B3A'};
                  border-radius:18px;
                  ${isMine ? 'border-bottom-right-radius:5px;' : 'border-bottom-left-radius:5px;'}
                  padding:10px 14px;font-size:13px;line-height:1.4;word-break:break-word;white-space:pre-wrap;
                ">${_esc(m.body)}</div>
              </div>
            </div>`;
        }).join('');

    el.innerHTML = `
      <div id="disc-msgs-${discId}" style="max-height:400px;overflow-y:auto;padding:.5rem 0;">
        ${msgsHtml}
      </div>
      <div style="display:flex;gap:8px;align-items:flex-end;margin-top:.5rem;">
        <textarea id="disc-reply-${discId}" placeholder="Write a reply…" rows="1" style="
          flex:1;resize:none;border:.5px solid #D1C9BE;border-radius:18px;
          padding:8px 12px;font-size:13px;font-family:'Inter',sans-serif;
          outline:none;background:#fff;max-height:100px;overflow-y:auto;line-height:1.4;
        "></textarea>
        <button id="disc-send-${discId}" style="
          flex-shrink:0;width:32px;height:32px;background:#8B1A2F;color:#fff;border:none;
          border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:13px;
        "><i class="fa-solid fa-paper-plane"></i></button>
      </div>`;

    el.querySelectorAll('.disc-msg-avatar').forEach(slot => {
      const { uid, name, pid } = slot.dataset;
      createAvatar({ container: slot, userId: pid || uid, name: name || uid, size: 24 });
    });

    const msgsEl = document.getElementById('disc-msgs-' + discId);
    if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;

    const input   = document.getElementById('disc-reply-' + discId);
    const sendBtn = document.getElementById('disc-send-' + discId);

    const doSend = async () => {
      const body = input?.value?.trim();
      if (!body) return;
      input.value = '';
      input.style.height = 'auto';
      const { data: newMsg, error } = await sb.from('discussion_messages').insert({
        discussion_id: discId, sender_id: currentUserId, body,
      }).select().single();
      if (error) { console.error('[discussionThread] send failed:', error); return; }
      if (!msgs.find(m => m.id === newMsg.id)) msgs.push(newMsg);
      await sb.from('discussions').update({ updated_at: new Date().toISOString() }).eq('id', discId);
      renderMsgs();
    };

    sendBtn?.addEventListener('click', doSend);
    input?.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } });
    input?.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 100) + 'px';
    });
  }

  renderMsgs();

  // Realtime
  if (_subs[discId]) sb.removeChannel(_subs[discId]);
  _subs[discId] = sb.channel('disc-' + discId)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'discussion_messages',
      filter: `discussion_id=eq.${discId}`,
    }, payload => {
      const msg = payload.new;
      if (msgs.find(m => m.id === msg.id)) return;
      msgs.push(msg);
      renderMsgs();
    })
    .subscribe();
}

// ── New thread modal ───────────────────────────────────────────────────────

function _openNewThreadModal({ contextType, contextId, currentUserId, list, profileMap, onCreated }) {
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

    await sb.from('discussion_messages').insert({
      discussion_id: disc.id, sender_id: currentUserId, body,
    });

    list.unshift(disc);
    closeModal();
    onCreated();
  });
}

// ── HTML helpers ───────────────────────────────────────────────────────────

function _discRowHtml(d, profileMap, isExpanded) {
  const prof = profileMap[d.created_by] || { name: 'Unknown', personnelId: null };
  return `
    <div style="border:.5px solid #E2DDD6;border-radius:8px;margin-bottom:.6rem;overflow:hidden;">
      <div class="disc-row-header" data-disc-id="${d.id}" style="
        display:flex;align-items:center;gap:10px;padding:.75rem 1rem;cursor:pointer;
        background:${isExpanded ? '#F8F7F4' : '#fff'};
      ">
        <div class="disc-creator-slot" data-uid="${d.created_by || ''}" data-name="${_esc(prof.name)}" data-pid="${prof.personnelId || ''}"
          style="width:28px;height:28px;border-radius:50%;background:#E2DDD6;flex-shrink:0;"></div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:13.5px;font-weight:500;color:#1C2B3A;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(d.title)}</div>
          <div style="font-size:11.5px;color:#9CA3AF;margin-top:1px;">${_esc(prof.name)} · ${_relTime(d.updated_at)}</div>
        </div>
        <span style="color:#C9A84C;font-size:14px;flex-shrink:0;">${isExpanded ? '▾' : '›'}</span>
      </div>
      ${isExpanded ? `<div id="disc-thread-${d.id}" style="border-top:.5px solid #F0EDE8;padding:.75rem 1rem;background:#FAFAF8;"></div>` : ''}
    </div>`;
}

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
