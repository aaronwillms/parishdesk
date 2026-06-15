import { sb } from '../supabase.js';
import { store } from '../store.js';

// Resolves and caches the current user's scope for filtering.
// Returns { personnelId, teamIds, ready }
// ready = false means the user has no linked directory entry yet.

let _cached = null;

export async function getUserScope() {
  if (_cached) return _cached;

  const profile = store.currentUserProfile;
  const personnelId = profile?.personnel_id || null;

  let teamIds = [];
  if (personnelId) {
    const { data } = await sb
      .from('team_members')
      .select('team_id')
      .eq('personnel_id', personnelId);
    teamIds = (data || []).map(r => r.team_id);
  }

  _cached = { personnelId, teamIds, ready: !!personnelId };
  return _cached;
}

// Call this when the user links / unlinks a directory entry so next load re-fetches.
export function clearUserScope() {
  _cached = null;
}

// Returns true if a project/task row is visible to the current user.
// assigned_to may be a uuid[] array or a single uuid string.
export function isVisible(row, { personnelId, teamIds }) {
  if (!personnelId) {
    // No linked entry: only show rows with no team and no assignee
    return !row.team_id && !row.assigned_to?.length && !row.assigned_to;
  }

  // Created by this user
  if (row.created_by && row.created_by === personnelId) return true;

  // Belongs to a team the user is in
  if (row.team_id && teamIds.includes(row.team_id)) return true;

  // Assigned to this user
  const assignees = Array.isArray(row.assigned_to)
    ? row.assigned_to
    : row.assigned_to ? [row.assigned_to] : [];
  if (assignees.includes(personnelId)) return true;

  return false;
}

export function scopeNotice() {
  return `<div style="
    background:#FDF3D0;border:.5px solid #C9A84C;border-radius:7px;
    padding:.75rem 1rem;font-size:13px;color:#7A5C00;margin-bottom:1rem;
    display:flex;align-items:center;gap:10px;
  ">
    <span style="font-size:16px;">⚠</span>
    <span>Your account isn't linked to a directory entry yet, so projects and tasks can't be fully scoped.
    <button onclick="window.switchPanel('userProfile',{title:'My Profile'})" style="
      background:none;border:none;color:#8B1A2F;cursor:pointer;font-family:'Inter',sans-serif;
      font-size:13px;font-weight:600;padding:0;text-decoration:underline;
    ">Link your profile</button> to see everything assigned to you.</span>
  </div>`;
}
