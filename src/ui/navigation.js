import { PANEL_TITLES } from '../utils.js';
import { store } from '../store.js';
import { createAvatar } from './avatar.js';
import { canAccessPanel, isSuperAdmin, isAdmin } from '../roles.js';

let _loaderMap = {};
let _currentPanel = null;
let _sidebarAvatarInstance = null;

function closeSidebar() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebar-backdrop')?.classList.remove('open');
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  const isOpen = sidebar?.classList.contains('open');
  if (isOpen) {
    closeSidebar();
  } else {
    sidebar?.classList.add('open');
    backdrop?.classList.add('open');
  }
}

// panelName may be 'teamDashboard' — the associated nav item is 'teams'
const NAV_PANEL_MAP = {
  teamDashboard:    'teams',
  projectDashboard: 'projects',
  userProfile:      null,
  admin:            'admin',
  messaging:        null,
};

function switchPanel(name, opts) {
  _currentPanel = name;
  const navName = NAV_PANEL_MAP[name] !== undefined ? NAV_PANEL_MAP[name] : name;

  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.nav-institution-item').forEach(n => n.classList.remove('active'));

  document.getElementById('panel-' + name)?.classList.add('active');
  if (navName) {
    document.querySelector(`.nav-item[data-panel="${navName}"]`)?.classList.add('active');
  }

  const title = opts?.title || PANEL_TITLES[name] || name;
  document.getElementById('topbar-title').textContent = title;

  closeSidebar();
  _updateSubNav(name);

  if (_loaderMap[name]) {
    _loaderMap[name](opts);
  }
}

function _updateSubNav(panelName) {
  const subNav = document.getElementById('teams-subnav');
  if (!subNav) return;
  const isInTeams = panelName === 'teams' || panelName === 'teamDashboard';
  subNav.style.display = isInTeams ? 'block' : 'none';
}

export function setActiveTeamSubNavItem(teamId) {
  document.querySelectorAll('.nav-subnav-item').forEach(el => {
    const active = el.dataset.teamId === teamId;
    el.classList.toggle('active', active);
    el.style.color = active ? '#F5F1EB' : '#8FA8BF';
    el.style.background = active ? 'rgba(255,255,255,.1)' : '';
  });
}

// ── Sidebar profile widget ─────────────────────────────────────────────────

export function renderSidebarProfileWidget(user) {
  const wrap = document.getElementById('sidebar-profile-widget');
  if (!wrap || !user) return;

  const profile = store.currentUserProfile;
  const linkedName = profile?.personnel?.name || null;
  const displayName = linkedName || user.email;
  const avatarUrl = profile?.avatar_url || null;

  wrap.innerHTML = '';
  wrap.style.cssText = `
    display:flex;align-items:center;gap:10px;
    padding:.6rem .75rem;border-radius:6px;cursor:pointer;
    transition:background .13s;margin-bottom:6px;
  `;
  wrap.onmouseover = () => { wrap.style.background = 'rgba(255,255,255,.07)'; };
  wrap.onmouseout  = () => { wrap.style.background = ''; };
  wrap.onclick = () => switchPanel('userProfile', { title: 'My Profile' });

  const avatarWrap = document.createElement('div');
  avatarWrap.style.cssText = 'flex-shrink:0;';
  _sidebarAvatarInstance = createAvatar({
    container: avatarWrap,
    userId: user.id,
    name: displayName,
    size: 32,
  });

  const nameEl = document.createElement('div');
  nameEl.style.cssText = 'flex:1;min-width:0;';
  const nameText = document.createElement('div');
  nameText.id = 'sidebar-profile-name';
  nameText.style.cssText = 'font-size:12.5px;color:#F8F7F4;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  nameText.textContent = displayName;
  nameEl.appendChild(nameText);

  wrap.appendChild(avatarWrap);
  wrap.appendChild(nameEl);
}

export function updateSidebarProfileWidget(profile) {
  if (_sidebarAvatarInstance) {
    const displayName = profile?.personnel?.name || store.currentUserProfile?.personnel?.name || null;
    _sidebarAvatarInstance.update({
      avatarUrl: profile?.avatar_url || null,
      name: displayName,
    });
    // Update display name text
    const wrap = document.getElementById('sidebar-profile-widget');
    const nameText = document.getElementById('sidebar-profile-name');
    if (nameText && displayName) nameText.textContent = displayName;
  }
}

// ── Nav visibility ─────────────────────────────────────────────────────────

export function resetNavVisibility() {
  document.querySelectorAll('.nav-item[data-panel], .nav-sec').forEach(el => {
    el.style.display = '';
  });
  // Re-hide the top-bar invite launcher on logout (not a .nav-item, so it isn't
  // covered by the reset above) — applyNavVisibility re-shows it for inviters.
  const inviteLauncher = document.getElementById('invite-launcher');
  if (inviteLauncher) inviteLauncher.style.display = 'none';
}

export function renderMinistryNav() {
  const container = document.getElementById('ministry-nav');
  if (!container) return;

  const institutions = store.institutions || [];
  const principalId  = store.parishSettings?.principal_institution_id;
  const primaryName  = store.parishSettings?.primary_institution;
  const teamPersonnelIds = store.currentUserRoles?.teamPersonnelIds;
  const userIsAdmin  = isAdmin();

  // Non-primary institutions sorted alphabetically. The principal is excluded by the
  // stable FK (principal_institution_id), falling back to the legacy name-match when
  // the FK is null (pre-backfill / safety net).
  const visible = institutions
    .filter(i => principalId ? i.id !== principalId : i.name !== primaryName)
    .filter(i => {
      if (userIsAdmin) return true;
      if (!teamPersonnelIds) return false;
      // Show if any HR occupant of this institution shares a team with the user.
      // Membership is the HR-derived person→institution map (positions.institution_id),
      // not the retired personnel.institution name-link.
      const members = store.personnelByInstitutionId?.get(i.id);
      return !!members && teamPersonnelIds.some(pid => members.has(pid));
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  container.innerHTML = visible.map(inst => {
    const icon = inst.icon || 'fa-building';
    return `<div class="nav-item nav-institution-item" data-institution-id="${inst.id}"
      onclick="window.showInstitutionDashboard('${inst.id}')"
      style="display:flex;align-items:center;gap:8px;">
      <i class="fa-solid ${icon}" style="font-size:13px;width:16px;text-align:center;flex-shrink:0;"></i>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${inst.name}</span>
    </div>`;
  }).join('');
}

export function applyNavVisibility() {
  const show = (panel, visible) => {
    const el = document.querySelector(`.nav-item[data-panel="${panel}"]`);
    if (el) el.style.display = visible ? '' : 'none';
  };
  const showSec = (label, visible) => {
    document.querySelectorAll('.nav-sec').forEach(el => {
      if (el.textContent.trim() === label) el.style.display = visible ? '' : 'none';
    });
  };

  const SACRAMENTAL_PANELS = ['baptism', 'firstcomm', 'confirmation', 'ocia', 'marriage'];
  SACRAMENTAL_PANELS.forEach(p => show(p, canAccessPanel(p)));
  showSec('Sacramental', SACRAMENTAL_PANELS.some(p => canAccessPanel(p)));

  const PASTORAL_PANELS = ['annulments', 'discernment', 'homebound'];
  PASTORAL_PANELS.forEach(p => show(p, canAccessPanel(p)));
  showSec('Pastoral Care', PASTORAL_PANELS.some(p => canAccessPanel(p)));

  show('school', canAccessPanel('school'));   // cura: superadmin-issued grant, not the admin role
  show('hr', canAccessPanel('hr'));   // Layer 0: HR visible IFF a node on any org tree (or super-admin)
  show('teams', canAccessPanel('teams'));
  const teamsSubNav = document.getElementById('teams-subnav');
  if (teamsSubNav && !canAccessPanel('teams')) teamsSubNav.style.display = 'none';

  show('admin', isSuperAdmin());

  // Top-bar invite launcher (fa-user-plus, left of the bell): visible to inviters.
  // isAdmin() is true for admin AND super_admin; the panel itself further gates the
  // grant matrix to super-admin only (see ui/invitePanel.js).
  const inviteLauncher = document.getElementById('invite-launcher');
  if (inviteLauncher) inviteLauncher.style.display = isAdmin() ? 'inline-flex' : 'none';

  renderMinistryNav();

  // Personnel panel buttons
  const addPersonBtn = document.getElementById('btn-add-person');
  if (addPersonBtn) addPersonBtn.style.display = isAdmin() ? '' : 'none';
  const addInstBtn = document.getElementById('btn-add-institution');
  if (addInstBtn) addInstBtn.style.display = isSuperAdmin() ? '' : 'none';

  // New Team button: admin+ only. (New Project is open to any user as of Phase 2a — the
  // creator becomes the project owner via container_members; button stays visible for all.)
  const newTeamBtn = document.getElementById('btn-new-team');
  if (newTeamBtn) newTeamBtn.style.display = isAdmin() ? '' : 'none';
}

// Sets the GROUP/parish label in the sidebar (.app-sub) and login screen (.auth-sub).
// These are GROUP-level surfaces ("what am I in"): callers pass the parish GROUP's
// display_name when set, else the current parish FULL name (parish_settings.parish_name).
// The SHORT name (display_name) is reserved for TABS (HR institution tabs, future
// sacramental switchers/pills); the directory header/dropdowns keep per-parish names.
// The " · Natchez" city suffix was removed in 3b (it hardcoded one parish's city).
export function applyParishName(name) {
  if (!name) return;
  const sub = document.querySelector('.app-sub');
  if (sub) sub.textContent = name;
  const authSub = document.querySelector('.auth-sub');
  if (authSub) authSub.textContent = name;
}

export function initNavigation(loaderMap) {
  _loaderMap = loaderMap;

  document.querySelectorAll('.nav-item[data-panel]').forEach(el => {
    el.addEventListener('click', () => switchPanel(el.dataset.panel));
  });

  document.querySelectorAll('.school-tab[data-tab]').forEach(el => {
    el.addEventListener('click', () => {
      document.querySelectorAll('.school-sub').forEach(s => s.classList.remove('active'));
      document.querySelectorAll('.school-tab').forEach(t => t.classList.remove('active'));
      document.getElementById('school-' + el.dataset.tab)?.classList.add('active');
      el.classList.add('active');
    });
  });

  document.getElementById('sidebar-backdrop')?.addEventListener('click', closeSidebar);

  // Initialise sub-nav visibility
  const subNav = document.getElementById('teams-subnav');
  if (subNav) subNav.style.display = 'none';

  // React to profile updates from the profile panel
  document.addEventListener('userProfileUpdated', e => {
    store.currentUserProfile = e.detail;
    updateSidebarProfileWidget(e.detail);
  });

  Object.assign(window, { switchPanel, toggleSidebar });
}
