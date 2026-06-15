import { PANEL_TITLES } from '../utils.js';

let _loaderMap = {};
let _currentPanel = null;

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
};

function switchPanel(name, opts) {
  _currentPanel = name;
  const navName = NAV_PANEL_MAP[name] || name;

  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  document.getElementById('panel-' + name)?.classList.add('active');
  document.querySelector(`.nav-item[data-panel="${navName}"]`)?.classList.add('active');

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

  Object.assign(window, { switchPanel, toggleSidebar });
}
