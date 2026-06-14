import { PANEL_TITLES } from '../utils.js';

let _loaderMap = {};

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

function switchPanel(name) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('panel-' + name)?.classList.add('active');
  document.querySelector(`.nav-item[data-panel="${name}"]`)?.classList.add('active');
  document.getElementById('topbar-title').textContent = PANEL_TITLES[name] || name;
  closeSidebar();
  _loaderMap[name]?.();
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

  Object.assign(window, { switchPanel, toggleSidebar });
}
