import { sb } from './supabase.js';
import { store } from './store.js';

// ── Load ───────────────────────────────────────────────────────────────────

export async function loadUserRoles() {
  const { data, error } = await sb.auth.getUser();
  const user = data?.user;
  if (!user || error) return;

  const personnelId = store.currentUserProfile?.personnel_id || null;

  const [rolesRes, sacramentRes, grantsRes, teamsRes] = await Promise.all([
    sb.from('user_roles').select('role').eq('user_id', user.id),
    sb.from('sacramental_roles').select('sacrament').eq('user_id', user.id),
    sb.from('panel_grants').select('panel').eq('user_id', user.id),
    personnelId
      ? sb.from('team_members').select('team_id').eq('personnel_id', personnelId)
      : Promise.resolve({ data: [] }),
  ]);

  const roles   = rolesRes.data || [];
  const teamIds = (teamsRes.data || []).map(r => r.team_id);

  // Personnel IDs of everyone sharing a team with this user — used for directory filtering
  let teamPersonnelIds = [];
  if (personnelId && teamIds.length) {
    const { data: tpData } = await sb
      .from('team_members')
      .select('personnel_id')
      .in('team_id', teamIds);
    teamPersonnelIds = [...new Set((tpData || []).map(r => r.personnel_id).filter(Boolean))];
  }

  store.currentUserRoles = {
    isSuperAdmin:     roles.some(r => r.role === 'super_admin'),
    isAdmin:          roles.some(r => r.role === 'admin' || r.role === 'super_admin'),
    sacraments:       (sacramentRes.data || []).map(r => r.sacrament),
    panelGrants:      (grantsRes.data || []).map(r => r.panel),
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
