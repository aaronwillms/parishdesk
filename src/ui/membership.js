import { sb } from '../supabase.js';
import { store } from '../store.js';

// Phase 2a: polymorphic container membership + roles. ONE table (container_members) backs
// BOTH projects (now) and teams (Phase 3). Role hierarchy: 'owner' > 'admin' > 'member'.
//
// ⚠️ KEYSPACE: container_members.personnel_id is a PERSONNEL id. Resolve "me" for membership
// checks via store.currentUserRoles.personnelId (NOT the auth uid). projects.created_by stays
// an auth uid; the OWNER row in container_members is the creator's RESOLVED personnel id.

// ── Reads ────────────────────────────────────────────────────────────────────

// One person's stored role in a container, or null if not a member.
export async function fetchMemberRole(contextType, contextId, personnelId) {
  if (!personnelId || !contextId) return null;
  const { data } = await sb.from('container_members')
    .select('role')
    .eq('context_type', contextType)
    .eq('context_id', contextId)
    .eq('personnel_id', personnelId)
    .maybeSingle();
  return data?.role || null;
}

// All members of a container, with roles.
export async function fetchMembers(contextType, contextId) {
  if (!contextId) return [];
  const { data } = await sb.from('container_members')
    .select('id, personnel_id, role, created_at')
    .eq('context_type', contextType)
    .eq('context_id', contextId)
    .order('created_at');
  return data || [];
}

// Cascade-aware effective role resolution.
//   PROJECT: if the project belongs to a TEAM (project.team_id), the effective role comes from
//   the TEAM's membership (see the Phase-3 seam below). Otherwise it's the person's own project
//   membership. Teams don't exist in 2a (team_id is always null), so the team branch is written
//   but UNREACHED.
//   TEAM (Phase 3): direct team membership.
export async function containerRole(contextType, contextId, personnelId) {
  if (!personnelId || !contextId) return null;

  if (contextType === 'project') {
    const { data: proj } = await sb.from('projects')
      .select('team_id').eq('id', contextId).maybeSingle();
    if (proj?.team_id) {
      // ── Phase 3 SEAM ─────────────────────────────────────────────────────────
      // A team-owned project inherits the person's role FROM THE TEAM. Teams have no
      // membership in 2a, so this is unreached (team_id always null). Phase 3 fills it:
      //   return containerRole('team', proj.team_id, personnelId);
      // (bridging team_members.team_role → owner/admin/member as needed).
      return null;
    }
    return fetchMemberRole('project', contextId, personnelId);
  }

  // team (Phase 3) — direct membership on container_members(context_type='team')
  return fetchMemberRole(contextType, contextId, personnelId);
}

// ── Preload (sync-reader seam) ───────────────────────────────────────────────
// Fetch ALL project memberships and attach `_members` (a personnel_id[]) to each project
// row, so SYNCHRONOUS readers (userScope.isVisible, projectCard→assigneeLabel) can consult
// membership from the in-memory row without a query — the container_members-sourced
// replacement for the old `assigned_to` array. Also caches store.projectMembers (the Map).
// ⚠️ Call this BEFORE isVisible filters the rows at each load site.
export async function attachProjectMembers(projects) {
  const rows = projects || [];
  const { data } = await sb.from('container_members')
    .select('context_id, personnel_id')
    .eq('context_type', 'project');
  const map = new Map();
  (data || []).forEach(r => {
    if (!map.has(r.context_id)) map.set(r.context_id, []);
    map.get(r.context_id).push(r.personnel_id);
  });
  rows.forEach(p => { p._members = map.get(p.id) || []; });
  store.projectMembers = map;
  return map;
}

// ── Predicates (off a resolved role) ─────────────────────────────────────────
export function canManageRole(role) { return role === 'owner' || role === 'admin'; }
export function isOwnerRole(role)    { return role === 'owner'; }
export function isMemberRole(role)   { return role != null; }

// ── Writes ───────────────────────────────────────────────────────────────────
export async function addMember(contextType, contextId, personnelId, role = 'member') {
  return sb.from('container_members').insert({
    context_type: contextType, context_id: contextId, personnel_id: personnelId, role,
  });
}
export async function removeMember(contextType, contextId, personnelId) {
  return sb.from('container_members').delete()
    .eq('context_type', contextType).eq('context_id', contextId).eq('personnel_id', personnelId);
}
export async function setMemberRole(contextType, contextId, personnelId, role) {
  return sb.from('container_members').update({ role })
    .eq('context_type', contextType).eq('context_id', contextId).eq('personnel_id', personnelId);
}
