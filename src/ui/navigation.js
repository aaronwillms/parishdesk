import { PANEL_TITLES } from '../utils.js';
import { store } from '../store.js';
import { createAvatar } from './avatar.js';

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
  userProfile:      null, // no nav-item highlight
};

function switchPanel(name, opts) {
  _currentPanel = name;
  const navName = NAV_PANEL_MAP[name] !== undefined ? NAV_PANEL_MAP[name] : name;

  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

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
  nameEl.innerHTML = `<div style="font-size:12.5px;color:rgba(248,247,244,.8);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${displayName}</div>`;

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
    const nameEl = wrap?.querySelector('div > div');
    if (nameEl && displayName) nameEl.textContent = displayName;
  }
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
