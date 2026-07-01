import { sb } from './supabase.js';
import { store } from './store.js';
import { deriveParishStaffPersonnelIds } from './ui/parishStaff.js';
import { getLinks } from './sacramental/recordLinks.js';

let currentUserId = null;
let realtimeChannel = null;
let panelOpen = false;

// Project icon cache: projectId → icon class string
const _projIconCache = {};

export function setNotificationUser(userId) {
  currentUserId = userId;
}

// ── Core data ──────────────────────────────────────────────────────────────

export async function createNotification(message, type = 'info', module = null, record_id = null) {
  console.log('[notifications] createNotification — userId:', currentUserId, '| message:', message);
  if (!currentUserId) {
    console.warn('[notifications] createNotification skipped — no currentUserId set');
    return;
  }
  const { error } = await sb.from('notifications').insert({
    user_id: currentUserId,
    message,
    type,
    module,
    record_id,
  });
  if (error) console.error('[notifications] insert failed:', error);
  else console.log('[notifications] insert succeeded');
}

// Send a notification to a list of user IDs, skipping the triggering user.
// visibilityCheck: optional async (userId) => bool — skip users that return false.
export async function notifyUsers(userIds, triggeringUserId, message, type = 'info', module = null, record_id = null, visibilityCheck = null) {
  const targets = [...new Set(userIds)].filter(id => id && id !== triggeringUserId);
  if (!targets.length) return;
  const checked = visibilityCheck
    ? (await Promise.all(targets.map(async id => ({ id, ok: await visibilityCheck(id) })))).filter(r => r.ok).map(r => r.id)
    : targets;
  if (!checked.length) return;
  const rows = checked.map(user_id => ({ user_id, message, type, module, record_id }));
  const { error } = await sb.from('notifications').insert(rows);
  if (error) console.error('[notifications] notifyUsers insert failed:', error);
}

// ── Door-complete, parish-matched recipient resolver (notifications routing core) ─
// Inverts roles.js' canAccessSacrament/canAccessPanel into a recipient SET so the
// people notified are EXACTLY those who can open the originating panel ("agrees with
// the predicate by construction" — under-notify is the failure we guard against). It
// mirrors all three access doors plus the always-on tier:
//   • super_admin              — always (canAccessSacrament short-circuits on it; a plain
//                                ADMIN is NOT auto-granted a sacrament, so admins are
//                                included only when they hold one of the doors below).
//   • sacramental_roles        — user_id-keyed; parish-matched.
//   • program_coordinators     — personnel_id inside coordinator_ids[]; parish-matched;
//                                resolved to accounts via user_profiles (no account → skip).
//   • panel_grants             — user_id-keyed; parish-matched (canAccessSacrament ORs it).
//   • advocates (annulments)   — annulment_cases.advocate_id (personnel) on ANY case →
//                                canAccessPanel('annulments') grants on advocateCaseIds>0.
// `keys` is the access-key SET for the panel. First Communion holds TWO keys —
// 'first_communion' in sacramental_roles vs 'firstcomm' in program_coordinators — and the
// panel ORs both (firstcomm.js:29), so both are queried. Parish match follows
// _setMatchesParish: a door row matches record-parish P iff parish_id IS NULL (group-
// shared cura) OR (P != null AND parish_id === P).
export async function resolvePanelRecipients(keys, parishId = null, { advocates = false } = {}) {
  const matchesParish = (pid) => pid == null || (parishId != null && pid === parishId);
  const [sacRes, gntRes, coordRes, superRes] = await Promise.all([
    sb.from('sacramental_roles').select('user_id, parish_id').in('sacrament', keys),
    sb.from('panel_grants').select('user_id, parish_id').in('panel', keys),
    sb.from('program_coordinators').select('coordinator_ids, parish_id').in('program', keys),
    sb.from('user_roles').select('user_id').eq('role', 'super_admin'),
  ]);
  const userIds = new Set();
  (superRes.data || []).forEach(r => r.user_id && userIds.add(r.user_id));
  (sacRes.data || []).filter(r => matchesParish(r.parish_id)).forEach(r => r.user_id && userIds.add(r.user_id));
  (gntRes.data || []).filter(r => matchesParish(r.parish_id)).forEach(r => r.user_id && userIds.add(r.user_id));
  // Coordinators + advocates are personnel-keyed; collect, then resolve to accounts.
  const personnel = new Set();
  (coordRes.data || []).filter(r => matchesParish(r.parish_id))
    .forEach(r => (r.coordinator_ids || []).forEach(pid => pid && personnel.add(pid)));
  if (advocates) {
    const { data: adv } = await sb.from('annulment_cases').select('advocate_id').not('advocate_id', 'is', null);
    (adv || []).forEach(r => r.advocate_id && personnel.add(r.advocate_id));
  }
  if (personnel.size) {
    const { data: profs } = await sb.from('user_profiles').select('user_id').in('personnel_id', [...personnel]);
    (profs || []).forEach(p => p.user_id && userIds.add(p.user_id));
  }
  return [...userIds];
}

// Panel access-key set per sacrament key (First Communion is dual-key; see above).
const _SAC_KEYS = {
  baptism:         ['baptism'],
  first_communion: ['first_communion', 'firstcomm'],
  firstcomm:       ['first_communion', 'firstcomm'],
  confirmation:    ['confirmation'],
  ocia:            ['ocia'],
  marriage:        ['marriage'],
  annulments:      ['annulments'],
};
// record_links / case-group vocabulary ('ocia'|'marriage'|'annulment', singular) →
// {access keys, table for the linked record's parish, advocates?}. Only these three
// panels are linkable (recordLinks.js); baptism/firstcomm/confirmation pass originType
// null and fan out to the origin panel only.
const _LINK_PANEL = {
  ocia:      { keys: ['ocia'],       table: 'sacramental_ocia', advocates: false },
  marriage:  { keys: ['marriage'],   table: 'couples',          advocates: false },
  annulment: { keys: ['annulments'], table: 'annulment_cases',  advocates: true  },
};

// Fetch all user IDs who can access a sacramental panel (door-complete; mirrors
// canAccessSacrament). Back-compat shim over resolvePanelRecipients — keeps the existing
// "New X added" create-notification call-sites working while making them door-complete.
export async function getUserIdsForSacrament(sacrament, parishId = (store.parishSettings?.id || null)) {
  return resolvePanelRecipients(_SAC_KEYS[sacrament] || [sacrament], parishId, { advocates: sacrament === 'annulments' });
}

// Fire a linked sacramental EVENT (notifications triggers 1/2 + linked fanout 1-2b +
// dedup 1-2c). Resolves the origin panel's recipients, then for every LINKED record
// (record_links cross-panel + annulment case-group siblings, via getLinks) resolves that
// record's panel recipients keyed on the LINKED record's own parish, UNIONs all sets, and
// emits ONE notifyUsers call — its Set-dedup + actor-exclusion guarantee one row per user,
// one text. The message reflects the ORIGINATING event; module/record_id point at the
// ORIGIN record (a link-only recipient lands on a panel they can't navigate — accepted).
// originType is the record_links vocabulary ('ocia'|'marriage'|'annulment') for linkable
// panels, or null to skip link traversal (baptism/firstcomm/confirmation).
export async function notifySacramentEvent({ keys, parishId = null, advocates = false, originType = null, originId = null, actorUserId = null, message, type = 'info', module = null, record_id = null }) {
  try {
    const sets = [await resolvePanelRecipients(keys, parishId, { advocates })];
    if (originType && originId) {
      const links = await getLinks(originType, originId);
      for (const ln of links) {
        const reg = _LINK_PANEL[ln.type];
        if (!reg) continue;
        const { data: lr } = await sb.from(reg.table).select('parish_id').eq('id', ln.id).maybeSingle();
        sets.push(await resolvePanelRecipients(reg.keys, lr?.parish_id ?? null, { advocates: reg.advocates }));
      }
    }
    await notifyUsers(sets.flat(), actorUserId, message, type, module, record_id);
  } catch (e) {
    console.error('[notifications] notifySacramentEvent failed:', e);
  }
}

// Fetch all user IDs who are members of a specific team (via personnel link).
export async function getUserIdsForTeam(teamId) {
  // Parish Staff (the protected team) is DERIVED from HR — its recipients are the
  // current HR-derived staff, not a stored team_members list (which is unused there).
  const { data: team } = await sb.from('teams').select('is_protected').eq('id', teamId).maybeSingle();
  let personnelIds;
  if (team?.is_protected) {
    personnelIds = await deriveParishStaffPersonnelIds();
  } else {
    const { data: members } = await sb.from('team_members').select('personnel_id').eq('team_id', teamId);
    personnelIds = (members || []).map(m => m.personnel_id).filter(Boolean);
  }
  if (!personnelIds.length) return [];
  const { data: profiles } = await sb.from('user_profiles').select('user_id').in('personnel_id', personnelIds);
  return (profiles || []).map(p => p.user_id).filter(Boolean);
}

// Fetch all authenticated user IDs.
export async function getAllUserIds() {
  const { data } = await sb.from('user_profiles').select('user_id');
  return (data || []).map(p => p.user_id).filter(Boolean);
}

// Resolve a personnel_id to the user_id of that person.
export async function getUserIdForPersonnel(personnelId) {
  if (!personnelId) return null;
  const { data } = await sb.from('user_profiles').select('user_id').eq('personnel_id', personnelId).maybeSingle();
  return data?.user_id || null;
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
  await _prefetchProjectIcons(store.notifications);
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

// Click a notification → deep-link to the record it references. Generic: switches to
// the originating panel (module name = panel key) and sets the master-detail shell
// hash (#/{module}/{record_id}). No-op for notifications without module + record_id.
function openNotification(id) {
  const n = (store.notifications || []).find(x => x.id === id);
  if (!n || !n.module || !n.record_id) return;
  closePanel();
  try {
    // Phase 2b-2: the standalone tasks/projects panels are retired. Re-point their deep-links:
    // a project → that project's surface; a task → the dashboard (its tasks home).
    if (n.module === 'projects') {
      window.showProjectDashboard?.(n.record_id);
    } else if (n.module === 'tasks') {
      window.switchPanel?.('dashboard');
    } else {
      window.switchPanel?.(n.module);
      location.hash = `#/${n.module}/${n.record_id}`;
    }
  } catch (e) { /* unknown module → no-op */ }
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

async function _prefetchProjectIcons(notifs) {
  const ids = [...new Set(
    (notifs || [])
      .filter(n => n.module === 'projects' && n.record_id)
      .map(n => n.record_id)
      .filter(id => !_projIconCache[id])
  )];
  if (!ids.length) return;
  const { data } = await sb.from('projects').select('id, icon').in('id', ids);
  (data || []).forEach(p => { _projIconCache[p.id] = p.icon || 'fa-clipboard'; });
}

function _notifLeadIcon(n) {
  if (n.module === 'projects' && n.record_id) {
    const icon = _projIconCache[n.record_id] || 'fa-clipboard';
    return `<i class="fa-solid ${icon}" style="font-size:15px;color:#8B1A2F;flex-shrink:0;"></i>`;
  }
  return typeIcon(n.type);
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
        <div class="notif-item${n.read ? '' : ' notif-unread'}" data-id="${n.id}"${(n.module && n.record_id) ? ` onclick="window._notifOpen('${n.id}')" style="cursor:pointer;"` : ''}>
          <div style="display:flex;align-items:flex-start;gap:8px;flex:1;">
            <div style="margin-top:1px;flex-shrink:0;">${_notifLeadIcon(n)}</div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;color:var(--navy);line-height:1.4;">${n.message}</div>
              <div style="font-size:11px;color:#9CA3AF;margin-top:3px;">${fmtNotifTime(n.created_at)}</div>
            </div>
          </div>
          <button onclick="event.stopPropagation();window._notifClear('${n.id}')" title="Dismiss" style="background:none;border:none;cursor:pointer;color:#D1D5DB;font-size:14px;padding:0;flex-shrink:0;line-height:1;margin-top:2px;" onmouseover="this.style.color='#6B7280'" onmouseout="this.style.color='#D1D5DB'">✕</button>
        </div>`).join('')}
    </div>`;
}

async function openPanel() {
  let panel = document.getElementById('notif-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'notif-panel';
    panel.className = 'notif-panel';
    document.body.appendChild(panel);
  }
  await _prefetchProjectIcons(store.notifications);
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
  console.log('[notifications] subscribing realtime for userId:', currentUserId);
  realtimeChannel = sb
    .channel('notifications-' + currentUserId)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'notifications',
      filter: `user_id=eq.${currentUserId}`,
    }, async payload => {
      store.notifications = [payload.new, ...(store.notifications || [])];
      updateBadge();
      await _prefetchProjectIcons([payload.new]);
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
  console.log('[notifications] initNotifications called — userId:', userId);
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
  window._notifOpen = openNotification;

  loadNotifications();
  subscribeNotifications();
}
