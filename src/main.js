import './styles/main.css';
import { initAuth, setSignOutCallback } from './auth.js';
import { initLiturgical } from './liturgical.js';
import { loadCalendar, loadInit } from './panels/dashboard.js';
import { initNavigation, renderSidebarProfileWidget, setActiveTeamSubNavItem, applyNavVisibility, resetNavVisibility, applyParishName, renderMinistryNav } from './ui/navigation.js';
import { loadUserRoles } from './roles.js';
import { clearUserScope } from './ui/userScope.js';
import { loadAdmin } from './panels/admin.js';
import { initModal } from './ui/modal.js';
import { loadUserProfile } from './panels/userProfile.js';
import { openCoupleAdd, loadCouples } from './panels/marriage.js';
import { caseForm, loadCases } from './panels/annulments.js';
import { projectForm, loadProjects, openNewProjectModal } from './panels/projects.js';
import { renderProjectDashboard } from './panels/projectDashboard.js';
import { loadSacramental } from './panels/sacramental.js';
import { loadOcia } from './panels/ocia.js';
import { loadCoordData } from './ui/coordinator.js';
import { loadSchool } from './panels/school.js';
import { loadPersonnel } from './panels/personnel.js';
import { loadTeams, loadTeamsStore } from './panels/teams.js';
import { renderTeamDashboard } from './panels/teamDashboard.js';
import { renderInstitutionDashboard } from './panels/institutionDashboard.js';
import { loadTasks } from './panels/tasks.js';
import { initNotifications } from './notifications.js';
import { loadMessaging, initChatBubble } from './panels/messaging.js';
import { sb } from './supabase.js';
import { store } from './store.js';

async function loadParishSettings() {
  const { data, error } = await sb.from('parish_settings').select('*').limit(1).single();
  if (error || !data) {
    console.warn('[parishSettings] no parish_settings row found');
    return;
  }
  store.parishSettings = data;
  applyParishName(data.parish_name);
}

async function startApp(user) {
  window.openModal = (type, defaultStatus) => {
    if (type === 'couple')  { openCoupleAdd(); return; }
    if (type === 'project') { openNewProjectModal(); return; }
    let html;
    if (type === 'case') html = caseForm();
    if (!html) return;
    document.getElementById('modal-content').innerHTML = html;
    document.getElementById('modal-overlay').classList.add('open');
  };

  window.showInstitutionDashboard = (institutionId) => {
    const container = document.getElementById('institution-dashboard-root');
    if (!container) return;
    // Highlight the matching nav item
    document.querySelectorAll('.nav-institution-item').forEach(el => {
      el.classList.toggle('active', el.dataset.institutionId === institutionId);
    });
    window.switchPanel('institutionDashboard', { title: 'Ministry' });
    renderInstitutionDashboard(container, institutionId);
  };

  window.showProjectDashboard = (projectId) => {
    const container = document.getElementById('project-dashboard-root');
    if (!container) return;
    window.switchPanel('projectDashboard', { title: 'Projects' });
    renderProjectDashboard(container, projectId).then(() => {
      const h1 = container.querySelector('h1');
      if (h1) document.getElementById('topbar-title').textContent = h1.textContent.trim();
    });
  };

  window.showTeamDashboard = (teamId) => {
    const container = document.getElementById('team-dashboard-root');
    if (!container) return;
    setActiveTeamSubNavItem(teamId);
    window.switchPanel('teamDashboard', { title: 'Teams' });
    renderTeamDashboard(container, teamId).then(() => {
      const h1 = container.querySelector('h1');
      if (h1) document.getElementById('topbar-title').textContent = h1.textContent.trim();
    });
  };

  initNavigation({
    marriage:      () => { loadCouples(); loadCoordData('marriage'); },
    annulments:    loadCases,
    projects:      loadProjects,
    personnel:     loadPersonnel,
    school:        loadSchool,
    baptism:       () => { loadSacramental('baptism');      loadCoordData('baptism'); },
    firstcomm:     () => { loadSacramental('firstcomm');    loadCoordData('firstcomm'); },
    confirmation:  () => { loadSacramental('confirmation'); loadCoordData('confirmation'); },
    ocia:          () => { loadOcia(); loadCoordData('ocia'); },
    teams:         () => { loadTeams(); setActiveTeamSubNavItem(null); },
    tasks:         loadTasks,
    teamDashboard:         () => {},   // handled by showTeamDashboard
    projectDashboard:      () => {},   // handled by showProjectDashboard
    institutionDashboard:  () => {},   // handled by showInstitutionDashboard
    userProfile:      loadUserProfile,
    admin:            loadAdmin,
    messaging:        loadMessaging,
  });

  initModal();
  initLiturgical();
  loadCalendar();

  // Phase 1 — non-user-dependent data (parallel)
  try {
    await Promise.all([loadParishSettings(), loadPersonnel(), loadTeamsStore()]);
  } catch (e) {
    console.error('[startApp] phase-1 init failed:', e);
  }

  // Phase 2 — user context (sequential, order matters)
  if (user?.id) {
    initNotifications(user.id);
    initChatBubble(user.id);
    // Hard-delete conversations and discussions soft-deleted more than 14 days ago
    const _cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    sb.from('conversations').delete()
      .lt('deleted_at', _cutoff).not('deleted_at', 'is', null).then(() => {});
    sb.from('discussions').delete()
      .lt('deleted_at', _cutoff).not('deleted_at', 'is', null).then(() => {});
    try { await loadUserProfile(); } catch (e) { console.error('[startApp] loadUserProfile failed:', e); }
    clearUserScope(); // ensure scope re-fetches with now-loaded profile
    try { await loadUserRoles(); } catch (e) { console.error('[startApp] loadUserRoles failed:', e); }
    renderSidebarProfileWidget(user);
    applyNavVisibility();
  }

  // Phase 3 — dashboard render (scope and roles are now in place)
  try {
    await loadInit();
  } catch (e) {
    console.error('[startApp] loadInit failed:', e);
  }

  console.log('[startApp] switching to dashboard');
  window.switchPanel('dashboard');

  // Phase 4 — background maintenance
  syncParishStaff();
}

async function syncParishStaff() {
  const primaryInstitution = store.parishSettings?.primary_institution;
  if (!primaryInstitution) {
    console.warn('[syncParishStaff] no parish_settings found, skipping sync');
    return;
  }

  const { data: team } = await sb
    .from('teams')
    .select('id')
    .eq('is_protected', true)
    .eq('name', 'Parish Staff')
    .maybeSingle();
  if (!team) return;

  const [{ data: staff }, { data: existing }] = await Promise.all([
    sb.from('personnel').select('id')
      .in('employment', ['full-time', 'part-time'])
      .eq('institution', primaryInstitution),
    sb.from('team_members').select('personnel_id').eq('team_id', team.id),
  ]);
  if (!staff?.length) return;

  const existingIds = new Set((existing || []).map(m => m.personnel_id));
  const toInsert = staff
    .filter(p => !existingIds.has(p.id))
    .map(p => ({ team_id: team.id, personnel_id: p.id }));
  if (!toInsert.length) return;

  await sb.from('team_members').insert(toInsert);
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
  initAuth(startApp);
})();
