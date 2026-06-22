// ── "Parish Staff" — DERIVED, read-only team that mirrors HR ─────────────────
// Membership is NEVER a stored list; it is recomputed from the current HR state.
// A person is a member when they CURRENTLY occupy a position at the PRIMARY
// institution and either the occupancy's employment type is Full-Time or
// Part-Time, OR the person is clergy.
//
// HR fields used (single source of truth — the HR occupancy model, NOT
// directory-entry filtering):
//   • primary institution → institutions.name === parish_settings.primary_institution
//                           (the same identifier ui/directory.js uses)
//   • position location   → positions.institution_id (non-archived: archived_at IS NULL)
//   • current occupancy   → person_positions.unlinked_at IS NULL (active only)
//   • employment type     → person_positions.employment_type ∈ {full_time, part_time}
//   • clergy              → personnel.clergy (person-level boolean — the parish-wide
//                           single source of truth; there is NO clergy employment_type
//                           or positions.is_clergy flag in this schema)

import { sb } from '../supabase.js';
import { store } from '../store.js';

const STAFF_EMP = new Set(['full_time', 'part_time']);

// Personnel ids of the current Parish Staff, derived from HR. Returns [] when the
// primary institution isn't configured/found or has no qualifying occupants.
export async function deriveParishStaffPersonnelIds() {
  const primaryName = store.parishSettings?.primary_institution;
  if (!primaryName) return [];

  // Primary institution id (matched by its configured name).
  const { data: insts } = await sb.from('institutions').select('id,name');
  const primary = (insts || []).find(i => i.name === primaryName);
  if (!primary) return [];

  // Non-archived positions at the primary institution.
  const { data: positions } = await sb.from('positions')
    .select('id').is('archived_at', null).eq('institution_id', primary.id);
  const posIds = (positions || []).map(p => p.id);
  if (!posIds.length) return [];

  // Current (active) occupants of those positions, with their employment type.
  const { data: occ } = await sb.from('person_positions')
    .select('person_id, employment_type').is('unlinked_at', null).in('position_id', posIds);
  if (!occ?.length) return [];

  // Clergy is a person-level boolean; resolve it for the occupants.
  const occIds = [...new Set(occ.map(o => o.person_id).filter(Boolean))];
  const { data: people } = await sb.from('personnel').select('id, clergy').in('id', occIds);
  const clergy = new Set((people || []).filter(p => p.clergy).map(p => p.id));

  // FT/PT occupants, plus any clergy occupant regardless of employment type.
  const out = new Set();
  occ.forEach(o => {
    if (o.person_id && (STAFF_EMP.has(o.employment_type) || clergy.has(o.person_id))) out.add(o.person_id);
  });
  return [...out];
}
