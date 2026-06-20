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
  const roleNames   = roles.map(r => r.role);
  const isSuperAdm  = roles.some(r => r.role === 'super_admin');
  const isAdm       = roles.some(r => r.role === 'admin' || r.role === 'super_admin');

  // Super admins: access is entirely rule-based — no DB records needed
  if (isSuperAdm) {
    store.currentUserRoles = {
      isSuperAdmin: true, isAdmin: true, roles: roleNames,
      sacraments: [], panelGrants: [], teamIds: [], teamPersonnelIds: [], advocateCaseIds: [],
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
      isSuperAdmin: false, isAdmin: true, roles: roleNames,
      sacraments:   [...new Set([...sacSacraments, ...coordSacraments])],
      panelGrants:  [],
      teamIds:      [],
      teamPersonnelIds: [],
      advocateCaseIds: [],
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

  // Annulment cases where this user is the assigned advocate (grants scoped access).
  let advocateCaseIds = [];
  if (personnelId) {
    const { data: advCases } = await sb.from('annulment_cases').select('id').eq('advocate_id', personnelId);
    advocateCaseIds = (advCases || []).map(c => c.id);
  }

  store.currentUserRoles = {
    isSuperAdmin: false, isAdmin: false, roles: roleNames,
    sacraments:   [...new Set([...sacSacraments, ...coordSacraments])],
    panelGrants:  (grantsRes.data || []).map(r => r.panel),
    teamIds,
    teamPersonnelIds,
    advocateCaseIds,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function isSuperAdmin() {
  return !!store.currentUserRoles?.isSuperAdmin;
}

export function isAdmin() {
  return !!store.currentUserRoles?.isAdmin;  // true for admin AND super_admin
}

export function hasRole(role) {
  return (store.currentUserRoles?.roles || []).includes(role);
}

export function canAccessSacrament(sacrament) {
  if (isSuperAdmin()) return true;
  const r = store.currentUserRoles;
  return r?.sacraments.includes(sacrament) || r?.panelGrants.includes(sacrament) || false;
}

// ── Discernment PANEL ACCESS (axis 1) ───────────────────────────────────────
// True for super-admin + anyone holding the 'discernment' panel grant (granted
// in the Admin Panel by a super-admin — same family as the sacramental-
// coordinator/panel-grant roles) + the legacy 'vocation_director' role. These
// are COLLABORATORS: they read AND write every parish discernment file. The
// panel defaults to just the pastor (super-admin) and is extensible to other
// priests / the youth director via the toggle. Entirely pastor/staff-facing —
// there is no discerner self-view. NOTE: admins do NOT auto-get access (the
// loadUserRoles admin path carries no panelGrants) — discernment is private by
// design. The READ-ONLY % file-grant (axis 2) is enforced per-file in the
// Discernment panel (canViewDiscerner), NOT here.
export function canAccessDiscernment() {
  if (isSuperAdmin()) return true;
  const r = store.currentUserRoles;
  if (!r) return false;
  return (r.panelGrants || []).includes('discernment') || hasRole('vocation_director');
}

// Stricter than canAccessSacrament: super admin OR the actual sacramental
// coordinator role for this sacrament (sacramental_roles / program_coordinators).
// Excludes panel_grants and plain admins — used to gate template management.
export function isSacramentCoordinator(sacrament) {
  if (isSuperAdmin()) return true;
  return (store.currentUserRoles?.sacraments || []).includes(sacrament);
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

  // Annulments: coordinator/granted/super-admin, OR an advocate assigned to ≥1 case
  if (panel === 'annulments') return canAccessSacrament('annulments') || (r.advocateCaseIds?.length > 0);

  // Pastoral Care stubs
  // Discernment: super-admin, a manual panel_grants('discernment') holder
  // (granted in the Admin Panel — the "panel access" axis), or the legacy
  // vocation_director role. See canAccessDiscernment() below.
  if (panel === 'discernment') return canAccessDiscernment();
  // Homebound: admin + super admin for now (dedicated role to come later)
  if (panel === 'homebound') return isAdmin();

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

// ── Permission basis model (Admin > Users) ──────────────────────────────────
// A team / institution(panel) / sacrament permission can be held on more than
// one BASIS at once. Tracking WHY a permission is held keeps locks and removals
// correct and non-destructive. Bases:
//   manual — an admin set the toggle directly (a row in panel_grants /
//            team_members / sacramental_roles).
//   admin  — derived from the user being Admin (covers ALL team + panel perms).
//   role   — derived from a sacramental coordinator assignment (one sacrament).
// A permission is effectively granted if ANY basis is present. Derived bases
// (admin, role) are NEVER written into the manual tables — so removing Admin or
// a coordinator role drops only that basis and any manual grant survives.
//
// This is the single source of truth: the Admin UI reads the computed state and
// does not hand-derive locks. `kind` is 'team' | 'panel' | 'sacrament'.
export function computePermissionBasis({ kind, isAdmin = false, hasManual = false, hasRole = false, roleLabel = '' }) {
  const bases = new Set();
  if (hasManual) bases.add('manual');
  // Admin grants ALL team + institution(panel) perms — but NOT sacraments.
  if (isAdmin && (kind === 'team' || kind === 'panel')) bases.add('admin');
  // Coordinator role grants its one sacrament.
  if (hasRole && kind === 'sacrament') bases.add('role');

  // Locks are additive but only ONE label is shown; admin takes precedence over
  // role (they apply to different kinds, so they never actually collide).
  let locked = false, lockedBy = null, lockLabel = null;
  if (bases.has('admin')) { locked = true; lockedBy = 'admin'; lockLabel = 'Granted by Admin role'; }
  else if (bases.has('role')) { locked = true; lockedBy = 'role'; lockLabel = `Granted by ${roleLabel} coordinator role`; }

  return { granted: bases.size > 0, bases, locked, lockedBy, lockLabel };
}

// ── Coordinator chip labels (shared, explicit per-sacrament wording) ─────────
// Single source of truth for the coordinator label shown wherever a directory
// person's coordinator role is surfaced. Keyed by the sacrament key as stored in
// sacramental_roles. NOT a templated "{Sacrament} Coordinator" string — Marriage
// is labeled "Wedding Coordinator". This map is the COMPLETE set: a coordinator
// role with no entry here (e.g. annulments) produces NO chip, by design.
export const SACRAMENT_COORDINATOR_LABELS = {
  baptism:         'Baptismal Preparation Coordinator',
  first_communion: 'First Communion Coordinator',
  confirmation:    'Confirmation Coordinator',
  ocia:            'OCIA Coordinator',
  marriage:        'Wedding Coordinator',
  // annulments: intentionally absent → no chip
};

// Map a person's coordinator sacrament keys to their chip labels, dropping any
// key with no mapped label (no generic fallback). Deduped, order preserved.
export function coordinatorChipLabels(sacramentKeys) {
  return [...new Set(sacramentKeys || [])]
    .map(k => SACRAMENT_COORDINATOR_LABELS[k])
    .filter(Boolean);
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
