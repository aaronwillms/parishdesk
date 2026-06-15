import { sb } from './supabase.js';
import { store } from './store.js';

let currentUserId = null;
let realtimeChannel = null;
let panelOpen = false;

export function setNotificationUser(userId) {
  currentUserId = userId;
}

// ── Core data ──────────────────────────────────────────────────────────────

export async function createNotification(message, type = 'info', module = null, record_id = null) {
  if (!currentUserId) return;
  await sb.from('notifications').insert({
    user_id: currentUserId,
    message,
    type,
    module,
    record_id,
  });
}

export async function loadNotifications() {
  if (!currentUserId) return;
  const { data, error } = await sb
    .from('notifications')
    .select('*')
    .eq('user_id', currentUserId)
    .eq('cleared', false)
    .order('created_at', { ascending: false });
  if (error) { console.error('[notifications] load failed:', error); return; }
  store.notifications = data || [];
  updateBadge();
  if (panelOpen) renderPanel();
}

async function markAllRead() {
  if (!currentUserId) return;
  const unread = (store.notifications || []).filter(n => !n.read).map(n => n.id);
  if (!unread.length) return;
  await sb.from('notifications').update({ read: true }).in('id', unread);
  store.notifications.forEach(n => { n.read = true; });
  updateBadge();
  if (panelOpen) renderPanel();
}

async function clearNotification(id) {
  await sb.from('notifications').update({ cleared: true, read: true }).eq('id', id);
  store.notifications = (store.notifications || []).filter(n => n.id !== id);
  updateBadge();
  if (panelOpen) renderPanel();
}

async function clearAllNotifications() {
  if (!currentUserId) return;
  const ids = (store.notifications || []).map(n => n.id);
  if (!ids.length) return;
  await sb.from('notifications').update({ cleared: true, read: true }).in('id', ids);
  store.notifications = [];
  updateBadge();
  if (panelOpen) renderPanel();
}

// ── Badge ──────────────────────────────────────────────────────────────────

export function updateBadge() {
  const badge = document.getElementById('notif-badge');
  if (!badge) return;
  const unread = (store.notifications || []).filter(n => !n.read).length;
  if (unread > 0) {
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

// ── Panel ──────────────────────────────────────────────────────────────────

function fmtNotifTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function typeIcon(type) {
  if (type === 'success') return '<i class="ti ti-circle-check" style="color:#2D6A4F;font-size:15px;"></i>';
  if (type === 'warning') return '<i class="ti ti-alert-triangle" style="color:#D4AC0D;font-size:15px;"></i>';
  if (type === 'error')   return '<i class="ti ti-circle-x" style="color:#C0392B;font-size:15px;"></i>';
  return '<i class="ti ti-bell" style="color:#6B7280;font-size:15px;"></i>';
}

function renderPanel() {
  const panel = document.getElementById('notif-panel');
  if (!panel) return;
  const notifs = store.notifications || [];
  if (!notifs.length) {
    panel.innerHTML = `
      <div class="notif-header">
        <span style="font-weight:600;font-size:13px;">Notifications</span>
      </div>
      <div style="padding:2rem 1rem;text-align:center;font-size:13px;color:#9CA3AF;">No notifications</div>`;
    return;
  }
  const unread = notifs.filter(n => !n.read).length;
  panel.innerHTML = `
    <div class="notif-header">
      <span style="font-weight:600;font-size:13px;">Notifications${unread ? ` <span style="font-size:11px;font-weight:400;color:#6B7280;">(${unread} unread)</span>` : ''}</span>
      <div style="display:flex;gap:10px;">
        ${unread ? `<button onclick="window._notifMarkAllRead()" style="font-size:11px;color:var(--cardinal);background:none;border:none;cursor:pointer;font-family:'Inter',sans-serif;padding:0;">Mark all read</button>` : ''}
        <button onclick="window._notifClearAll()" style="font-size:11px;color:#6B7280;background:none;border:none;cursor:pointer;font-family:'Inter',sans-serif;padding:0;">Clear all</button>
      </div>
    </div>
    <div class="notif-list">
      ${notifs.map(n => `
        <div class="notif-item${n.read ? '' : ' notif-unread'}" data-id="${n.id}">
          <div style="display:flex;align-items:flex-start;gap:8px;flex:1;">
            <div style="margin-top:1px;flex-shrink:0;">${typeIcon(n.type)}</div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;color:var(--navy);line-height:1.4;">${n.message}</div>
              <div style="font-size:11px;color:#9CA3AF;margin-top:3px;">${fmtNotifTime(n.created_at)}</div>
            </div>
          </div>
          <button onclick="window._notifClear('${n.id}')" title="Dismiss" style="background:none;border:none;cursor:pointer;color:#D1D5DB;font-size:14px;padding:0;flex-shrink:0;line-height:1;margin-top:2px;" onmouseover="this.style.color='#6B7280'" onmouseout="this.style.color='#D1D5DB'">✕</button>
        </div>`).join('')}
    </div>`;
}

function openPanel() {
  let panel = document.getElementById('notif-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'notif-panel';
    panel.className = 'notif-panel';
    document.body.appendChild(panel);
  }
  renderPanel();
  // Position below bell
  const bell = document.getElementById('notif-bell');
  if (bell) {
    const rect = bell.getBoundingClientRect();
    panel.style.top = (rect.bottom + 8) + 'px';
    panel.style.right = (window.innerWidth - rect.right) + 'px';
  }
  panel.classList.add('open');
  panelOpen = true;
  markAllRead();
}

function closePanel() {
  const panel = document.getElementById('notif-panel');
  if (panel) panel.classList.remove('open');
  panelOpen = false;
}

// ── Realtime ───────────────────────────────────────────────────────────────

export function subscribeNotifications() {
  if (!currentUserId || realtimeChannel) return;
  realtimeChannel = sb
    .channel('notifications-' + currentUserId)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'notifications',
      filter: `user_id=eq.${currentUserId}`,
    }, payload => {
      store.notifications = [payload.new, ...(store.notifications || [])];
      updateBadge();
      if (panelOpen) renderPanel();
    })
    .subscribe();
}

export function unsubscribeNotifications() {
  if (realtimeChannel) {
    sb.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
}

// ── Init ───────────────────────────────────────────────────────────────────

export function initNotifications(userId) {
  currentUserId = userId;
  store.notifications = [];

  const bell = document.getElementById('notif-bell');
  if (bell) {
    bell.addEventListener('click', e => {
      e.stopPropagation();
      panelOpen ? closePanel() : openPanel();
    });
  }

  document.addEventListener('click', e => {
    if (panelOpen && !e.target.closest('#notif-panel') && !e.target.closest('#notif-bell')) {
      closePanel();
    }
  });

  window._notifClear = clearNotification;
  window._notifMarkAllRead = markAllRead;
  window._notifClearAll = clearAllNotifications;

  loadNotifications();
  subscribeNotifications();
}
