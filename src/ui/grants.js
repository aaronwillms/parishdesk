// ── Universal record-grant layer (Stage 4) ──────────────────────────────────
// The single client surface over the record_grants table + the Stage 1
// has_record_grant()/is_super_admin() DB functions. Reused by the chat %
// controller, the grantee header on record views, the PDF export gate, and the
// Admin Panel audit view. Access lives in the ROW; UI here only reflects/edits
// it. Every grant + revoke logs through logActivity() so history survives row
// (and message) deletion.

import { sb } from '../supabase.js';
import { logActivity } from '../utils.js';

// Grantable record-type registry. record_type values are the Stage 1
// record_grants CHECK-bounded list. For THIS stage only the four HR types are
// wired as grantable SOURCES (they have views/export). Sacramental + youth
// types are CHECK-valid and surface in the audit ledger, but are not yet
// searchable sources here — see the TODO in searchGrantableRecords().
export const GRANTABLE = {
  review:        { label: 'Performance Review',  table: 'performance_reviews',  hr: true },
  disciplinary:  { label: 'Disciplinary Record', table: 'disciplinary_records', hr: true },
  incident:      { label: 'Incident Report',     table: 'incident_reports',     hr: true },
  memo:          { label: 'Memo',                table: 'memos',                hr: true },
};
// Highest-priority-to-review record types in the audit view (visual marker only;
// never auto-prompted).
export const PRIORITY_TYPES = new Set(['youth_member', 'adult_volunteer']);

export function recordTypeLabel(type) {
  return GRANTABLE[type]?.label || type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function fmtD(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Identity resolution (auth user_id → display name) ───────────────────────

let _idMap = null;   // user_id -> name
export async function ensureIdentities(force = false) {
  if (_idMap && !force) return _idMap;
  const { data } = await sb.from('user_profiles').select('user_id, personnel(name)');
  _idMap = new Map((data || []).map(p => [p.user_id, p.personnel?.name || null]));
  return _idMap;
}
export function userName(userId) {
  if (!userId) return 'Unknown';
  return _idMap?.get(userId) || 'Staff member';
}
// Users that can be granted to (have a linked personnel name).
export async function grantableUsers() {
  const { data } = await sb.from('user_profiles').select('user_id, personnel(name)');
  return (data || [])
    .filter(p => p.personnel?.name)
    .map(p => ({ userId: p.user_id, name: p.personnel.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── Grant CRUD (each logs through logActivity) ──────────────────────────────

export async function writeGrant({ recordType, recordId, grantedTo, grantedBy, note = null }) {
  const { data, error } = await sb.from('record_grants').insert({
    record_type: recordType, record_id: recordId,
    granted_to: grantedTo, granted_by: grantedBy, note,
  }).select('*').single();
  if (!error) {
    logActivity({ action: 'granted record access', entityType: 'record_grant',
      entityName: `${recordType}:${recordId}`, contextType: 'hr' });
  }
  return { data, error };
}

export async function revokeGrant(grantId) {
  const { data: row } = await sb.from('record_grants').select('record_type, record_id').eq('id', grantId).maybeSingle();
  const { error } = await sb.from('record_grants').delete().eq('id', grantId);
  if (!error) {
    logActivity({ action: 'revoked record access', entityType: 'record_grant',
      entityName: row ? `${row.record_type}:${row.record_id}` : grantId, contextType: 'hr' });
  }
  return { error };
}

export async function setGrantNote(grantId, note) {
  const { error } = await sb.from('record_grants')
    .update({ note: note || null, updated_at: new Date().toISOString() }).eq('id', grantId);
  if (!error) {
    logActivity({ action: 'edited grant reason', entityType: 'record_grant', entityName: grantId, contextType: 'hr' });
  }
  return { error };
}

// ── Reads ───────────────────────────────────────────────────────────────────

// The grant row by which a specific user sees a specific record (grantee header).
export async function fetchGrantRow(recordType, recordId, userId) {
  const { data } = await sb.from('record_grants').select('*')
    .eq('record_type', recordType).eq('record_id', recordId).eq('granted_to', userId)
    .order('granted_at').limit(1).maybeSingle();
  return data;
}
export async function fetchGrantsForRecord(recordType, recordId) {
  const { data } = await sb.from('record_grants').select('*')
    .eq('record_type', recordType).eq('record_id', recordId).order('granted_at');
  return data || [];
}
export async function fetchAllGrants() {
  const { data } = await sb.from('record_grants').select('*').order('granted_at', { ascending: false });
  return data || [];
}

// ── Grantable-record search (for the % chat picker; super-admin context) ────
// Searches HR records by the person they are ABOUT (name → occupancies →
// records). RLS scopes results (super-admin sees all). TODO: when sacramental/
// youth modules expose a record search, add their types here so they become
// grantable sources too (record_grants already accepts those record_type values).
export async function searchGrantableRecords(query) {
  const safe = query.trim().replace(/[%_,()"'*]/g, ' ').trim();
  if (!safe) return [];
  const { data: people } = await sb.from('personnel').select('id, name').ilike('name', `%${safe}%`).limit(8);
  if (!people?.length) return [];
  const nameById = new Map(people.map(p => [p.id, p.name]));
  const { data: pps } = await sb.from('person_positions').select('id, person_id').in('person_id', people.map(p => p.id));
  if (!pps?.length) return [];
  const personByPp = new Map(pps.map(pp => [pp.id, pp.person_id]));
  const ppIds = pps.map(pp => pp.id);

  const runs = Object.entries(GRANTABLE).map(async ([type, cfg]) => {
    const { data } = await sb.from(cfg.table)
      .select('id, person_position_id, record_date, created_at').in('person_position_id', ppIds);
    return (data || []).map(r => ({
      record_type: type, record_id: r.id,
      label: `${nameById.get(personByPp.get(r.person_position_id)) || '?'} — ${cfg.label} (${fmtD(r.record_date || r.created_at)})`,
    }));
  });
  return (await Promise.all(runs)).flat().slice(0, 10);
}

// Resolve a record_grants row's record to a human label for the audit view.
// Best-effort: HR types resolve person+type+date; others fall back to type+id.
export async function labelForGrant(grant) {
  const cfg = GRANTABLE[grant.record_type];
  if (!cfg) return `${recordTypeLabel(grant.record_type)} · ${grant.record_id.slice(0, 8)}`;
  const { data: rec } = await sb.from(cfg.table)
    .select('id, person_position_id, record_date, created_at').eq('id', grant.record_id).maybeSingle();
  if (!rec) return `${cfg.label} (deleted)`;
  let who = '';
  const { data: pp } = await sb.from('person_positions').select('person_id').eq('id', rec.person_position_id).maybeSingle();
  if (pp) {
    const { data: person } = await sb.from('personnel').select('name').eq('id', pp.person_id).maybeSingle();
    who = person?.name ? person.name + ' — ' : '';
  }
  return `${who}${cfg.label} (${fmtD(rec.record_date || rec.created_at)})`;
}
