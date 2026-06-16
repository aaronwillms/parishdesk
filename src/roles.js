import { sb } from './supabase.js';
import { store } from './store.js';

// ── Load ───────────────────────────────────────────────────────────────────

export async function loadUserRoles() {
  const { data, error } = await sb.auth.getUser();
  const user = data?.user;
  if (!user || error) return;

  const personnelId = store.currentUserProfile?.personnel_id || null;

  // Always fetch the role row first — it determines what else we need
  const { data: roleRows } = await sb.from('user_roles').select('role').eq('user_id', user.id);
  const roles       = roleRows || [];
  const isSuperAdm  = roles.some(r => r.role === 'super_admin');
  const isAdm       = roles.some(r => r.role === 'admin' || r.role === 'super_admin');

  // Super admins: access is entirely rule-based — no DB records needed
  if (isSuperAdm) {
    store.currentUserRoles = {
      isSuperAdmin: true, isAdmin: true,
      sacraments: [], panelGrants: [], teamIds: [], teamPersonnelIds: [],
    };
    return;
  }

  // Admins: sacramental access is individually assigned + coordinator assignments; teams/panels are rule-based
  if (isAdm) {
    const [sacRes, coordRes] = await Promise.all([
      sb.from('sacramental_roles').select('sacrament').eq('user_id', user.id),
      personnelId
        ? sb.from('program_coordinators').select('program').contains('coordinator_ids', [personnelId])
        : Promise.resolve({ data: [] }),
    ]);
    const sacSacraments   = (sacRes.data   || []).map(r => r.sacrament);
    const coordSacraments = (coordRes.data || []).map(r => r.program);
    store.currentUserRoles = {
      isSuperAdmin: false, isAdmin: true,
      sacraments:   [...new Set([...sacSacraments, ...coordSacraments])],
      panelGrants:  [],
      teamIds:      [],
      teamPersonnelIds: [],
    };
    return;
  }

  // Basic users: fetch all grants and team memberships for scoped access
  const [sacramentRes, grantsRes, teamsRes, coordRes] = await Promise.all([
    sb.from('sacramental_roles').select('sacrament').eq('user_id', user.id),
    sb.from('panel_grants').select('panel').eq('user_id', user.id),
    personnelId
      ? sb.from('team_members').select('team_id').eq('personnel_id', personnelId)
      : Promise.resolve({ data: [] }),
    personnelId
      ? sb.from('program_coordinators').select('program').contains('coordinator_ids', [personnelId])
      : Promise.resolve({ data: [] }),
  ]);

  const teamIds = (teamsRes.data || []).map(r => r.team_id);

  // Personnel IDs of teammates — used to scope the directory for basic users
  let teamPersonnelIds = [];
  if (personnelId && teamIds.length) {
    const { data: tpData } = await sb
      .from('team_members')
      .select('personnel_id')
      .in('team_id', teamIds);
    teamPersonnelIds = [...new Set((tpData || []).map(r => r.personnel_id).filter(Boolean))];
  }

  const sacSacraments   = (sacramentRes.data || []).map(r => r.sacrament);
  const coordSacraments = (coordRes.data    || []).map(r => r.program);

  store.currentUserRoles = {
    isSuperAdmin: false, isAdmin: false,
    sacraments:   [...new Set([...sacSacraments, ...coordSacraments])],
    panelGrants:  (grantsRes.data || []).map(r => r.panel),
    teamIds,
    teamPersonnelIds,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function isSuperAdmin() {
  return !!store.currentUserRoles?.isSuperAdmin;
}

export function isAdmin() {
  return !!store.currentUserRoles?.isAdmin;  // true for admin AND super_admin
}

export function canAccessSacrament(sacrament) {
  if (isSuperAdmin()) return true;
  const r = store.currentUserRoles;
  return r?.sacraments.includes(sacrament) || r?.panelGrants.includes(sacrament) || false;
}

export function canAccessPanel(panel) {
  if (isSuperAdmin()) return true;
  const r = store.currentUserRoles;
  if (!r) return false;

  // Always-on panels (all authenticated users)
  if (['dashboard', 'tasks', 'userProfile'].includes(panel)) return true;

  // Personnel + Projects: all authenticated users see the panel, but content is scoped
  if (panel === 'personnel' || panel === 'projects') return true;

  // Teams: admin sees all; basic users need team membership
  if (panel === 'teams') return isAdmin() || r.teamIds.length > 0;

  // Admin panel: super_admin only
  if (panel === 'admin') return false;

  // School: admin+
  if (panel === 'school') return isAdmin();

  // Sacramental panels
  const SACRAMENTAL = {
    baptism:      'baptism',
    firstcomm:    'first_communion',
    confirmation: 'confirmation',
    ocia:         'ocia',
    marriage:     'marriage',
    annulments:   'annulments',
  };
  if (SACRAMENTAL[panel]) return canAccessSacrament(SACRAMENTAL[panel]);

  // Panel grants catch-all
  return r.panelGrants.includes(panel);
}

export function isTeamAdmin(teamId) {
  if (isAdmin()) return true;  // admin and super_admin can manage all teams
  return store.currentUserRoles?.teamIds.includes(teamId) || false;
}

// ── Notification visibility gate ───────────────────────────────────────────
// Returns true if the given user (by userId) should receive a notification
// for the given context. Queries DB directly since we don't have another
// user's roles in store.
//
// contextType: 'team' | 'project' | 'task' | 'sacrament' | 'announcement' | null
// contextId:   team_id / sacrament name / announcement visible_to array / etc.
export async function canUserSeeNotification(sb, userId, contextType, contextId) {
  if (!contextType || !userId) return true; // no gate — notify freely

  // Lookup this user's role row to determine admin status
  const { data: roleRows } = await sb.from('user_roles').select('role').eq('user_id', userId);
  const isSuperAdm = (roleRows || []).some(r => r.role === 'super_admin');
  const isAdm      = (roleRows || []).some(r => r.role === 'admin' || r.role === 'super_admin');
  if (isSuperAdm) return true;

  if (contextType === 'team') {
    // contextId = team_id
    const { data: profile } = await sb.from('user_profiles').select('personnel_id').eq('user_id', userId).maybeSingle();
    if (!profile?.personnel_id) return isAdm;
    const { data: mem } = await sb.from('team_members').select('id').eq('team_id', contextId).eq('personnel_id', profile.personnel_id).maybeSingle();
    return !!mem || isAdm;
  }

  if (contextType === 'project') {
    // contextId = project id; project is visible if user is assigned or is admin
    const { data: proj } = await sb.from('projects').select('assigned_to,team_id').eq('id', contextId).maybeSingle();
    if (!proj) return false;
    if (isAdm) return true;
    const { data: profile } = await sb.from('user_profiles').select('personnel_id').eq('user_id', userId).maybeSingle();
    const { data: uProf } = await sb.from('user_profiles').select('personnel_id').eq('user_id', userId).maybeSingle();
    if (proj.assigned_to && uProf?.personnel_id && (proj.assigned_to === uProf.personnel_id || (Array.isArray(proj.assigned_to) && proj.assigned_to.includes(uProf.personnel_id)))) return true;
    return false;
  }

  if (contextType === 'task') {
    const { data: task } = await sb.from('tasks').select('assigned_to,team_id').eq('id', contextId).maybeSingle();
    if (!task) return false;
    if (isAdm) return true;
    const { data: uProf } = await sb.from('user_profiles').select('personnel_id').eq('user_id', userId).maybeSingle();
    return task.assigned_to && uProf?.personnel_id && task.assigned_to === uProf.personnel_id;
  }

  if (contextType === 'sacrament') {
    // contextId = sacrament name e.g. 'ocia', 'baptism', 'marriage', 'annulments'
    if (isAdm) return true;
    const { data: sacRole } = await sb.from('sacramental_roles').select('sacrament').eq('user_id', userId).eq('sacrament', contextId).maybeSingle();
    if (sacRole) return true;
    const { data: uProf } = await sb.from('user_profiles').select('personnel_id').eq('user_id', userId).maybeSingle();
    if (uProf?.personnel_id) {
      const { data: coord } = await sb.from('program_coordinators').select('program').eq('program', contextId).contains('coordinator_ids', [uProf.personnel_id]).maybeSingle();
      if (coord) return true;
    }
    return false;
  }

  if (contextType === 'announcement') {
    // contextId = visible_to array or null (null = all)
    if (!contextId || !contextId.length) return true;
    if (isAdm) return true;
    const { data: uProf } = await sb.from('user_profiles').select('personnel_id').eq('user_id', userId).maybeSingle();
    if (!uProf?.personnel_id) return false;
    for (const teamId of contextId) {
      const { data: mem } = await sb.from('team_members').select('id').eq('team_id', teamId).eq('personnel_id', uProf.personnel_id).maybeSingle();
      if (mem) return true;
    }
    return false;
  }

  return true;
}
