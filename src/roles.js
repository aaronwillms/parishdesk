import { sb } from './supabase.js';
import { store } from './store.js';

// ── Load ───────────────────────────────────────────────────────────────────

export async function loadUserRoles() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;

  const personnelId = store.currentUserProfile?.personnel_id || null;

  const [rolesRes, sacramentRes, grantsRes, teamsRes] = await Promise.all([
    sb.from('user_roles').select('role').eq('user_id', user.id),
    sb.from('sacramental_roles').select('sacrament').eq('user_id', user.id),
    sb.from('panel_grants').select('panel').eq('user_id', user.id),
    personnelId
      ? sb.from('team_members').select('team_id').eq('personnel_id', personnelId)
      : Promise.resolve({ data: [] }),
  ]);

  const roles = rolesRes.data || [];
  store.currentUserRoles = {
    isSuperAdmin: roles.some(r => r.role === 'super_admin'),
    sacraments:   (sacramentRes.data || []).map(r => r.sacrament),
    panelGrants:  (grantsRes.data || []).map(r => r.panel),
    teamIds:      (teamsRes.data || []).map(r => r.team_id),
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function isSuperAdmin() {
  return !!store.currentUserRoles?.isSuperAdmin;
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

  // Always-on panels
  if (['dashboard', 'tasks', 'personnel', 'projects', 'userProfile'].includes(panel)) return true;

  // Teams — member of at least one team
  if (panel === 'teams') return r.teamIds.length > 0;

  // Sacramental panels
  const SACRAMENTAL = { baptism: 'baptism', firstcomm: 'first_communion', confirmation: 'confirmation', ocia: 'ocia', marriage: 'marriage', annulments: 'annulments' };
  if (SACRAMENTAL[panel]) return canAccessSacrament(SACRAMENTAL[panel]);

  // Panel grants catch-all
  return r.panelGrants.includes(panel);
}

export function isTeamAdmin(teamId) {
  if (isSuperAdmin()) return true;
  // For now team admin = team member; dedicated team_admin role can be layered in later
  return store.currentUserRoles?.teamIds.includes(teamId) || false;
}
