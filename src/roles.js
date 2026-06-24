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

  // HR Layer 0: institutions whose org tree this user is a CURRENT node on. Drives
  // the HR nav link (gated by tree membership, NOT by admin role) and the tab set.
  const hrInstitutionIds = await hrInstitutionIdsForUser(personnelId);

  // Super admins: access is entirely rule-based — no DB records needed
  if (isSuperAdm) {
    store.currentUserRoles = {
      isSuperAdmin: true, isAdmin: true, roles: roleNames,
      sacraments: [], panelGrants: [], teamIds: [], teamPersonnelIds: [], advocateCaseIds: [],
      onHomeboundRosterLinked: false, homeboundAssignedRecipientIds: [],   // broad via super-admin
      hrInstitutionIds,
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
    // program_coordinators carries non-sacrament programs too ('homebound',
    // 'discernment'); split 'homebound' out of the sacrament set.
    const coordPrograms   = (coordRes.data || []).map(r => r.program);
    const coordSacraments = coordPrograms.filter(p => p !== 'homebound');
    store.currentUserRoles = {
      isSuperAdmin: false, isAdmin: true, roles: roleNames,
      sacraments:   [...new Set([...sacSacraments, ...coordSacraments])],
      panelGrants:  [],
      teamIds:      [],
      teamPersonnelIds: [],
      advocateCaseIds: [],
      onHomeboundRosterLinked: coordPrograms.includes('homebound'),
      homeboundAssignedRecipientIds: [],   // broad via admin; per-recipient unused
      hrInstitutionIds,
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
  // program_coordinators carries non-sacrament programs too; 'homebound' is the
  // account-linked Ministers-to-the-Sick roster (broad-tier access), not a sacrament.
  const coordPrograms   = (coordRes.data    || []).map(r => r.program);
  const coordSacraments = coordPrograms.filter(p => p !== 'homebound');

  // Annulment cases where this user is the assigned advocate (grants scoped access).
  let advocateCaseIds = [];
  if (personnelId) {
    const { data: advCases } = await sb.from('annulment_cases').select('id').eq('advocate_id', personnelId);
    advocateCaseIds = (advCases || []).map(c => c.id);
  }

  // Sick & Homebound assignments (narrow tier; advocate-model — cached at load).
  // Only account-linked assignees (minister_personnel_id) carry access; inline-name
  // assignees confer nothing (no personnel → user link).
  let homeboundAssignedRecipientIds = [];
  if (personnelId) {
    const { data: hbAssign } = await sb.from('homebound_assignments')
      .select('recipient_id').eq('minister_personnel_id', personnelId);
    homeboundAssignedRecipientIds = [...new Set((hbAssign || []).map(a => a.recipient_id).filter(Boolean))];
  }

  store.currentUserRoles = {
    isSuperAdmin: false, isAdmin: false, roles: roleNames,
    sacraments:   [...new Set([...sacSacraments, ...coordSacraments])],
    panelGrants:  (grantsRes.data || []).map(r => r.panel),
    teamIds,
    teamPersonnelIds,
    advocateCaseIds,
    onHomeboundRosterLinked: coordPrograms.includes('homebound'),
    homeboundAssignedRecipientIds,
    hrInstitutionIds,
  };
}

// Institutions whose org tree a personnel record is a CURRENT node on (any active
// occupancy). Used by Layer 0 (HR nav link + per-institution tabs).
async function hrInstitutionIdsForUser(personnelId) {
  if (!personnelId) return [];
  const { data } = await sb.from('person_positions')
    .select('positions(institution_id)')
    .eq('person_id', personnelId)
    .is('unlinked_at', null);
  return [...new Set((data || []).map(r => r.positions?.institution_id).filter(Boolean))];
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function isSuperAdmin() {
  return !!store.currentUserRoles?.isSuperAdmin;
}

export function isAdmin() {
  return !!store.currentUserRoles?.isAdmin;  // true for admin AND super_admin
}

// Write policy for the GLOBAL parish calendar: super-admin OR admin may write
// (create parish events via the designated-writer token). Regular users NEVER write
// — they only READ the global calendar's events on the dashboard. The proxy also
// enforces this server-side for the global-write path (defense-in-depth).
export function canWriteGlobalCalendar() {
  return isAdmin();   // isAdmin() === admin || super_admin
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

// ── SICK & HOMEBOUND access (Pastoral Care) — CACHED-AT-LOAD (advocate model) ──
// Broad tier (full roster + full file edit): super-admin, admin, a manual
// panel_grants('homebound') holder, OR an account-linked Ministers-to-the-Sick
// roster member (program_coordinators program='homebound' → onHomeboundRosterLinked
// at role-load). Narrow tier: a minister ASSIGNED to specific recipient(s) via
// homebound_assignments (homeboundAssignedRecipientIds, loaded like advocateCaseIds)
// — sees the panel + only their recipients, visits-only. Like the advocate model,
// membership/assignment is SNAPSHOTTED at role-load; losing it drops access on the
// NEXT roles reload, not mid-session (deliberate, documented — not a bug).
export function isHomeboundBroad() {
  if (isSuperAdmin()) return true;
  const r = store.currentUserRoles;
  if (!r) return false;
  return isAdmin() || (r.panelGrants || []).includes('homebound') || !!r.onHomeboundRosterLinked;
}
// Panel access: broad OR assigned to ≥1 recipient (mirrors the advocate rule).
export function canAccessHomebound() {
  if (isHomeboundBroad()) return true;
  return (store.currentUserRoles?.homeboundAssignedRecipientIds || []).length > 0;
}
// Per-recipient access: broad OR this recipient is among the user's assignments.
export function canAccessHomeboundRecipient(recipientId) {
  if (isHomeboundBroad()) return true;
  return (store.currentUserRoles?.homeboundAssignedRecipientIds || []).includes(recipientId);
}
// Capability on an accessible recipient: broad → full edit; assignment-only → visits-only.
export function homeboundCapability() {
  return isHomeboundBroad() ? 'full' : 'visits';
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

  // HR (Layer 0): visible IFF the user is a node on ANY institution's org tree
  // (super-admin always). NOT gated by admin role.
  if (panel === 'hr') return canAccessHr();

  // Annulments: coordinator/granted/super-admin, OR an advocate assigned to ≥1 case
  if (panel === 'annulments') return canAccessSacrament('annulments') || (r.advocateCaseIds?.length > 0);

  // Pastoral Care stubs
  // Discernment: super-admin, a manual panel_grants('discernment') holder
  // (granted in the Admin Panel — the "panel access" axis), or the legacy
  // vocation_director role. See canAccessDiscernment() below.
  if (panel === 'discernment') return canAccessDiscernment();
  // Sick & Homebound (Pastoral Care): broad tier OR an assignment-only minister.
  if (panel === 'homebound') return canAccessHomebound();

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

// ── Work-calendar event visibility (Phase 3) ────────────────────────────────
// A work-calendar event records its originating PANEL (Google extendedProperties
// pd_panel). Visibility is governed by the PANEL, not the calendar: a user sees a
// work-calendar event only if they can access the panel that created it. Write
// access is the SAME — if you can access the panel, you can schedule for it.
export function canSeeWorkEvent(panel) {
  if (!panel) return false;
  return canAccessPanel(panel);
}
export function canScheduleForPanel(panel) {
  return canAccessPanel(panel);
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
export function computePermissionBasis({ kind, isAdmin = false, hasManual = false, hasRole = false, roleLabel = '', hasRoster = false, rosterLabel = '' }) {
  const bases = new Set();
  if (hasManual) bases.add('manual');
  // Admin grants ALL team + institution(panel) perms — but NOT sacraments.
  if (isAdmin && (kind === 'team' || kind === 'panel')) bases.add('admin');
  // Coordinator role grants its one sacrament.
  if (hasRole && kind === 'sacrament') bases.add('role');
  // A named roster (e.g. Ministers to the Sick) grants — and LOCKS — its PANEL.
  // This is the first non-sacrament, roster-driven panel lock; kept generic
  // ("panel X locked by roster R") rather than hardcoded to one panel.
  if (hasRoster && kind === 'panel') bases.add('roster');

  // Locks are additive but only ONE label is shown. Precedence: admin > role >
  // roster. admin and roster can both apply to a panel — admin wins; role is
  // sacrament-only so it never collides with the panel-only roster basis.
  let locked = false, lockedBy = null, lockLabel = null;
  if (bases.has('admin')) { locked = true; lockedBy = 'admin'; lockLabel = 'Granted by Admin role'; }
  else if (bases.has('role')) { locked = true; lockedBy = 'role'; lockLabel = `Granted by ${roleLabel} coordinator role`; }
  else if (bases.has('roster')) { locked = true; lockedBy = 'roster'; lockLabel = rosterLabel ? `Granted by the ${rosterLabel} roster` : 'Granted by roster membership'; }

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

// ══════════════════════════════════════════════════════════════════════════
// HR REDESIGN — PHASE 3 authority (JS-enforced; consistent with the app, NOT RLS)
//
// Two axes: the TREE = work/reporting structure; the SUPERVISOR boolean
// (positions.is_administrator) = HR AUTHORITY. Pure functions take the tree
// context built by hr.js (buildContext): ctx = { posById:Map<id,position>,
// currentByPos:Map<posId,[occupancy]> }. All authority is per-institution.
// ══════════════════════════════════════════════════════════════════════════

// Layer 0 — HR panel visible IFF super-admin OR the user is a node on ≥1 tree.
export function canAccessHr() {
  if (isSuperAdmin()) return true;
  return (store.currentUserRoles?.hrInstitutionIds || []).length > 0;
}

// Current positions a person holds in one institution (position objects).
function hrPersonPositions(personId, institutionId, ctx) {
  const out = [];
  if (!personId || !ctx) return out;
  for (const [posId, occs] of ctx.currentByPos) {
    const pos = ctx.posById.get(posId);
    if (pos && pos.institution_id === institutionId && occs.some(o => o.person_id === personId)) out.push(pos);
  }
  return out;
}
// Is ancestorPosId a STRICT ancestor of descendantPosId? (walk the parent chain)
function hrIsAncestorPosition(ancestorPosId, descendantPosId, ctx) {
  let cur = ctx.posById.get(descendantPosId);
  cur = cur ? ctx.posById.get(cur.parent_position_id) : null;
  while (cur) {
    if (cur.id === ancestorPosId) return true;
    cur = ctx.posById.get(cur.parent_position_id);
  }
  return false;
}

// HR AUTHORITY: the viewer can create/view/manage another person's HR entries in an
// institution IFF super-admin, OR the viewer holds a SUPERVISOR (is_administrator)
// position that is an ANCESTOR of any position the target holds there. Authority
// flows down the ENTIRE subtree (transitive — intermediate supervisors don't block it).
export function hrHasAuthority(viewerPersonId, targetPersonId, institutionId, ctx) {
  if (isSuperAdmin()) return true;
  if (!viewerPersonId || !targetPersonId || !institutionId || !ctx) return false;
  const supPositions = hrPersonPositions(viewerPersonId, institutionId, ctx).filter(p => p.is_administrator);
  if (!supPositions.length) return false;
  const targetPositions = hrPersonPositions(targetPersonId, institutionId, ctx);
  return supPositions.some(v => targetPositions.some(t => hrIsAncestorPosition(v.id, t.id, ctx)));
}

// Structural edits (position title/type, supervisor toggle, +Add Position, move,
// delete, occupancy link/unlink) = SUPER-ADMIN ONLY.
export function hrCanManageStructure() { return isSuperAdmin(); }

// Finalize a self-report = a SUPERVISOR above the subject OR super-admin (same as
// having authority over that person).
export function hrCanFinalizeSelfReport(viewerPersonId, targetPersonId, institutionId, ctx) {
  return hrHasAuthority(viewerPersonId, targetPersonId, institutionId, ctx);
}

// Institutions where a person is a CURRENT node (for per-institution tabs from a ctx).
export function hrInstitutionsForPerson(personId, ctx) {
  const set = new Set();
  if (!ctx) return [];
  for (const [posId, occs] of ctx.currentByPos) {
    if (occs.some(o => o.person_id === personId)) {
      const pos = ctx.posById.get(posId);
      if (pos) set.add(pos.institution_id);
    }
  }
  return [...set];
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
