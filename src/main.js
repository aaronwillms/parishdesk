import './styles/main.css';
import { initAuth, setSignOutCallback } from './auth.js';
import { initLiturgical } from './liturgical.js';
import { loadCalendar, loadInit } from './panels/dashboard.js';
import { initNavigation, renderSidebarProfileWidget, setActiveTeamSubNavItem, applyNavVisibility, resetNavVisibility, applyParishName, renderMinistryNav } from './ui/navigation.js';
import { loadUserRoles } from './roles.js';
import { clearUserScope } from './ui/userScope.js';
import { loadMyGrants } from './ui/grants.js';
import { initModal } from './ui/modal.js';
import { loadUserProfile } from './panels/userProfile.js';
import { loadCoordData } from './ui/coordinator.js';
import { loadPersonnel } from './panels/personnel.js';
import { loadTeams, loadTeamsStore } from './panels/teams.js';
import { ensurePanel } from './panels/registry.js';
import { initNotifications } from './notifications.js';
import { loadMessaging, initChatBubble } from './panels/messaging.js';
import { sb, deleteWithRetry } from './supabase.js';
import { store } from './store.js';
import { installPhoneMask } from './utils/phone.js';
import './ui/saveButton.js';   // installs window.flashSaved / flashSavedThen + click tracker

async function loadParishSettings() {
  const { data, error } = await sb.from('parish_settings').select('*').limit(1).single();
  if (error || !data) {
    console.warn('[parishSettings] no parish_settings row found');
    return;
  }
  store.parishSettings = data;
  applyParishName(data.parish_name);
}

async function loadDiocesanOverrides() {
  // Local festal overrides for the liturgical header. Missing table (pre-migration)
  // degrades to no overrides — the romcal-computed day still renders.
  const { data, error } = await sb.from('diocesan_overrides').select('*');
  if (error) { store.diocesanOverrides = []; return; }
  store.diocesanOverrides = data || [];
}

async function startApp(user) {
  // Ensure-load stubs for the lazy sacramental cluster's cross-panel globals.
  // A chip rendered by one panel may call e.g. window.expandCase before the
  // annulments chunk has loaded; the stub loads the owning panel (whose
  // module-eval Object.assign replaces the stub with the real impl) then
  // delegates. After first load, direct calls hit the real function.
  const lazyExpand = (globalName, panelKey) => {
    const stub = (...args) => ensurePanel(panelKey).then(() =>
      (window[globalName] && window[globalName] !== stub) ? window[globalName](...args) : undefined);
    window[globalName] = stub;
  };
  lazyExpand('expandCouple', 'marriage');
  lazyExpand('expandCase', 'annulments');
  lazyExpand('expandOcia', 'ocia');
  lazyExpand('expandBaptism', 'baptism');
  lazyExpand('expandFirstComm', 'firstcomm');
  lazyExpand('expandConfirmation', 'confirmation');
  lazyExpand('expandDiscerner', 'discernment');

  window.openModal = async (type, defaultStatus) => {
    if (type === 'couple')  { const m = await ensurePanel('marriage'); m.openCoupleAdd(); return; }
    if (type === 'project') { const m = await ensurePanel('projects'); m.openNewProjectModal(); return; }
    if (type === 'case')    { await ensurePanel('annulments'); window.openCaseCreate?.(); return; }
  };

  window.showInstitutionDashboard = async (institutionId) => {
    const container = document.getElementById('institution-dashboard-root');
    if (!container) return;
    // Highlight the matching nav item
    document.querySelectorAll('.nav-institution-item').forEach(el => {
      el.classList.toggle('active', el.dataset.institutionId === institutionId);
    });
    window.switchPanel('institutionDashboard', { title: 'Ministry' });
    const m = await ensurePanel('institutionDashboard');
    m.renderInstitutionDashboard(container, institutionId);
  };

  window.showProjectDashboard = async (projectId) => {
    const container = document.getElementById('project-dashboard-root');
    if (!container) return;
    window.switchPanel('projectDashboard', { title: 'Projects' });
    const m = await ensurePanel('projectDashboard');
    m.renderProjectDashboard(container, projectId).then(() => {
      const h1 = container.querySelector('h1');
      if (h1) document.getElementById('topbar-title').textContent = h1.textContent.trim();
    });
  };

  window.showTeamDashboard = async (teamId) => {
    const container = document.getElementById('team-dashboard-root');
    if (!container) return;
    setActiveTeamSubNavItem(teamId);
    window.switchPanel('teamDashboard', { title: 'Teams' });
    const m = await ensurePanel('teamDashboard');
    m.renderTeamDashboard(container, teamId).then(() => {
      const h1 = container.querySelector('h1');
      if (h1) document.getElementById('topbar-title').textContent = h1.textContent.trim();
    });
  };

  initNavigation({
    marriage:      () => ensurePanel('marriage').then(m => { m.loadCouples(); loadCoordData('marriage'); }),
    annulments:    () => ensurePanel('annulments').then(m => m.loadCases()),
    discernment:   () => ensurePanel('discernment').then(m => m.loadDiscernment()),
    homebound:     () => ensurePanel('homebound').then(m => m.loadHomebound()),
    youthministry: () => ensurePanel('youthministry').then(m => m.loadYouthMinistry()),
    projects:      () => ensurePanel('projects').then(m => m.loadProjects()),
    personnel:     loadPersonnel,
    hr:            () => ensurePanel('hr').then(m => m.loadHr()),
    school:        () => ensurePanel('school').then(m => m.loadSchool()),
    baptism:       () => ensurePanel('baptism').then(m => { m.loadBaptism(); loadCoordData('baptism'); }),
    firstcomm:     () => ensurePanel('firstcomm').then(m => { m.loadFirstComm(); loadCoordData('firstcomm'); }),
    confirmation:  () => ensurePanel('confirmation').then(m => { m.loadConfirmation(); loadCoordData('confirmation'); }),
    ocia:          () => ensurePanel('ocia').then(m => { m.loadOcia(); loadCoordData('ocia'); }),
    teams:         () => { loadTeams(); setActiveTeamSubNavItem(null); },
    tasks:         () => ensurePanel('tasks').then(m => m.loadTasks()),
    teamDashboard:         () => {},   // handled by showTeamDashboard
    projectDashboard:      () => {},   // handled by showProjectDashboard
    institutionDashboard:  () => {},   // handled by showInstitutionDashboard
    userProfile:      loadUserProfile,
    admin:            () => ensurePanel('admin').then(m => m.loadAdmin()),
    messaging:        loadMessaging,
  });

  initModal();
  initLiturgical();
  installPhoneMask();   // live phone mask on every input[type="tel"], app-wide

  // Phase 1 — non-user-dependent data (parallel)
  try {
    await Promise.all([loadParishSettings(), loadDiocesanOverrides(), loadPersonnel(), loadTeamsStore()]);
  } catch (e) {
    console.error('[startApp] phase-1 init failed:', e);
  }

  // Phase 2 — user context (sequential, order matters)
  if (user?.id) {
    initNotifications(user.id);
    initChatBubble(user.id);
    // Hard-delete conversations and discussions soft-deleted more than 14 days ago
    const _cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    deleteWithRetry(() => sb.from('conversations').delete()
      .lt('deleted_at', _cutoff).not('deleted_at', 'is', null)).then(() => {});
    deleteWithRetry(() => sb.from('discussions').delete()
      .lt('deleted_at', _cutoff).not('deleted_at', 'is', null)).then(() => {});
    deleteWithRetry(() => sb.from('project_log').delete()
      .lt('deleted_at', _cutoff).not('deleted_at', 'is', null)).then(() => {});
    try { await loadUserProfile(); } catch (e) { console.error('[startApp] loadUserProfile failed:', e); }
    // Apply dark mode on load — mobile only
    if (store.currentUserProfile?.dark_mode && window.innerWidth < 768) {
      document.body.classList.add('dark-mode');
    }
    clearUserScope(); // ensure scope re-fetches with now-loaded profile
    try { await loadUserRoles(); } catch (e) { console.error('[startApp] loadUserRoles failed:', e); }
    // Prefetch this user's record_grants so '#' link chips to granted records
    // render unlocked from the first paint (see mentionPicker.canAccessLink).
    try { await loadMyGrants(true); } catch (e) { console.error('[startApp] loadMyGrants failed:', e); }
    renderSidebarProfileWidget(user);
    applyNavVisibility();
  }

  // Phase 3 — dashboard render (scope and roles are now in place)
  try {
    await loadInit();
  } catch (e) {
    console.error('[startApp] loadInit failed:', e);
  }

  // Load calendar after loadInit so currentUserId is set before the personal Google Calendar query
  loadCalendar();

  console.log('[startApp] switching to dashboard');
  window.switchPanel('dashboard');
}
// NOTE: the old additive syncParishStaff() was removed — "Parish Staff" is now
// DERIVED from HR at read time (ui/parishStaff.js), never stored in team_members.

// When a new service worker takes control after a deploy (skipWaiting +
// clientsClaim), reload ONCE to pick up the fresh bundle. Gated on a controller
// already existing, so the very first SW install never triggers a surprise
// reload — only genuine updates do. Closes the stale-bundle window.
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing || !hadController) return;
    refreshing = true;
    window.location.reload();
  });
}

(async () => {
  setSignOutCallback(() => {
    resetNavVisibility();
    store.currentUserProfile = null;
    store.currentUserRoles = null;
    store.allProjects = [];
    store.allTasks = [];
    store._projectScopeReady = undefined;
    store._taskScopeReady = undefined;
    clearUserScope();
  });
  // Surface OAuth callback result from query params
  const _params = new URLSearchParams(window.location.search);
  if (_params.has('google_connected')) {
    console.log('[oauth] Google Calendar connected successfully');
  } else if (_params.has('google_error')) {
    const reason = _params.get('google_error');
    const detail = _params.get('detail') ?? '';
    console.error('[oauth] Google Calendar connection failed — reason:', reason, detail ? `| detail: ${detail}` : '');
  }

  initAuth(startApp);
})();
