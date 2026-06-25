// ── Partial-index-aware write helper for program_coordinators ─────────────────
// Step 2a gave program_coordinators a partial unique-index PAIR:
//   UNIQUE(program)              WHERE parish_id IS NULL      — group-shared / cura rows
//   UNIQUE(program, parish_id)   WHERE parish_id IS NOT NULL  — parish-scoped prep rows
// PostgREST's `onConflict` inference cannot target a partial index, so we identify the
// existing row by its exact (program, parish_id) identity and UPDATE it, else INSERT.
// parishId null = a group-shared (cura) row. Other columns (name/phone/email) are left
// untouched on update, matching the prior upsert's behaviour.

import { sb } from '../supabase.js';

// Prep programs are parish-scoped; everything else (annulments, discernment, homebound)
// is group-shared cura → NULL parish.
export const PREP_PROGRAMS = new Set(['baptism', 'firstcomm', 'first_communion', 'confirmation', 'ocia', 'marriage']);

export async function upsertProgramCoordinators(program, coordinatorIds, parishId = null) {
  let sel = sb.from('program_coordinators').select('id').eq('program', program);
  sel = parishId == null ? sel.is('parish_id', null) : sel.eq('parish_id', parishId);
  const { data: existing } = await sel.maybeSingle();
  const base = { coordinator_ids: coordinatorIds, updated_at: new Date().toISOString() };
  if (existing) return sb.from('program_coordinators').update(base).eq('id', existing.id);
  return sb.from('program_coordinators').insert({ program, parish_id: parishId, ...base });
}
