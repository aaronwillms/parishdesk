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
import './ui/scheduleCalendar.js';   // registers window.openScheduleModal (sacramental Schedule button)
import { loadPersonnel } from './panels/personnel.js';
import { loadTeams, loadTeamsStore } from './panels/teams.js';
import { ensurePanel } from './panels/registry.js';
import { initNotifications } from './notifications.js';
import { initInviteLauncher } from './ui/invitePanel.js';
import { loadMessaging, initChatBubble } from './panels/messaging.js';
import { sb, deleteWithRetry } from './supabase.js';
import { store } from './store.js';
import { installPhoneMask } from './utils/phone.js';
import { initSWUpdate } from './ui/swUpdate.js';
import './ui/saveButton.js';   // installs window.flashSaved / flashSavedThen + click tracker

async function loadParishSettings(user) {
  // Phase 1b Step 2 — RESOLVED-parish load: resolve the user's parish via the Step 1
  // column (user_profiles.parish_id) and load THAT parish_settings row. Single-tenant-
  // safe: while parish_settings has one row, the resolved id IS that row, so this returns
  // the same object as the legacy singleton load. Falls back to the singleton load
  // whenever resolution yields nothing (no user, no profile row, null parish_id, or the
  // resolved row is missing) so behavior is byte-identical and nothing breaks.
  let data = null, error = null;

  let parishId = null;
  if (user?.id) {
    const { data: prof } = await sb.from('user_profiles')
      .select('parish_id').eq('user_id', user.id).maybeSingle();
    parishId = prof?.parish_id || null;
  }
  if (parishId) {
    ({ data, error } = await sb.from('parish_settings').select('*').eq('id', parishId).maybeSingle());
  }
  // Fail-closed (Step 3b): NO singleton `.limit(1)` fallback. With two parishes a singleton
  // load would silently load the WRONG parish for an unresolved user (the app mirror of the
  // hardened current_parish_id()). So we load ONLY the user's resolved parish; if it's
  // unresolved (no profile parish_id, or the row is missing), we leave parishSettings unset —
  // a locked/unresolved state — rather than defaulting to an arbitrary parish. Single-parish:
  // every user resolves, so this branch is never hit (inert now, correct later).
  if (error || !data) {
    console.warn('[parishSettings] parish unresolved for this user — leaving parishSettings unset (fail-closed)');
    store.parishSettings = null;
    return;
  }
  store.parishSettings = data;

  // Load the GROUP (for the group-level nav/login label) and the sibling parishes
  // (for shared-tree headings + the Add-Parish picker). Single-parish → one sibling
  // row and (usually) no group display_name. Non-fatal if either fails.
  if (data.group_id) {
    const [{ data: group }, { data: siblings }] = await Promise.all([
      sb.from('parish_groups').select('id, name, display_name').eq('id', data.group_id).maybeSingle(),
      sb.from('parish_settings').select('id, parish_name, display_name, principal_institution_id').eq('group_id', data.group_id),
    ]);
    store.parishGroup  = group || null;
    store.groupParishes = siblings || [];
  }

  // Nav header + login: GROUP display name when set, else the current parish FULL
  // name (naming rule). Inert for single-parish: blank group name → parish name.
  applyParishName(store.parishGroup?.display_name || data.parish_name || data.display_name);
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

  // Phase 1 — base data (parallel). loadParishSettings resolves the user's parish from
  // user_profiles.parish_id (Step 1b); the others are parish-agnostic.
  try {
    await Promise.all([loadParishSettings(user), loadDiocesanOverrides(), loadPersonnel(), loadTeamsStore()]);
  } catch (e) {
    console.error('[startApp] phase-1 init failed:', e);
  }

  // Phase 2 — user context (sequential, order matters)
  if (user?.id) {
    initNotifications(user.id);
    initChatBubble(user.id);
    initInviteLauncher();   // top-bar fa-user-plus → role-tiered invite modal
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
  // After designating the parish Google writer, land on Admin → Calendars so the
  // admin can pick which calendar is the global one.
  if (new URLSearchParams(location.search).has('parish_writer_connected')) {
    window.switchPanel('admin');
  } else {
    window.switchPanel('dashboard');
  }
}
// NOTE: the old additive syncParishStaff() was removed — "Parish Staff" is now
// DERIVED from HR at read time (ui/parishStaff.js), never stored in team_members.

// Service-worker updates are handled by initSWUpdate() (src/ui/swUpdate.js):
// under registerType: 'prompt' a new deploy's SW waits, we show a dismissible
// "Update available — Reload" banner, and the fresh bundle is adopted on the
// user's click — not silently mid-session. That is the SINGLE reload path
// (first install neither prompts nor reloads); the old unconditional
// controllerchange → reload handler was removed to avoid a second one.
initSWUpdate();

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
  } else if (_params.has('parish_writer_connected')) {
    console.log('[oauth] Parish Google calendar (global writer) connected');
  } else if (_params.has('google_error')) {
    const reason = _params.get('google_error');
    const detail = _params.get('detail') ?? '';
    console.error('[oauth] Google Calendar connection failed — reason:', reason, detail ? `| detail: ${detail}` : '');
  }

  initAuth(startApp);
})();
