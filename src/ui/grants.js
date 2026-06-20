// ── Universal record-grant layer (Stage 4) ──────────────────────────────────
// The single client surface over the record_grants table + the Stage 1
// has_record_grant()/is_super_admin() DB functions. Reused by the chat %
// controller, the grantee header on record views, the PDF export gate, and the
// Admin Panel audit view. Access lives in the ROW; UI here only reflects/edits
// it. Every grant + revoke logs through logActivity() so history survives row
// (and message) deletion.

import { sb, deleteWithRetry } from '../supabase.js';
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

// Sacramental / marriage / annulment records are grantable sources too. They are
// searched by NAME directly (mirroring the '#' mention picker), keyed by the
// mention-link type. `gtype` is the record_grants.record_type CHECK value — note
// firstcomm → 'first_communion'. RLS is DISABLED on these tables (they are
// client-gated, see 20260617_sacramental_bugfixes.sql), so a grant flips the
// client access gate (canAccessLink) rather than a DB RLS rule the way HR does.
const SAC_GRANTABLE = {
  marriage:     { gtype: 'marriage',        typeLabel: 'Marriage',        table: 'couples',                 cols: ['groom', 'bride'],           label: r => `${r.groom || '?'} & ${r.bride || '?'}` },
  annulment:    { gtype: 'annulment',       typeLabel: 'Annulment',       table: 'annulment_cases',         cols: ['petitioner', 'respondent'], label: r => r.respondent ? `${r.petitioner} v. ${r.respondent}` : (r.petitioner || '?') },
  ocia:         { gtype: 'ocia',            typeLabel: 'OCIA',            table: 'sacramental_ocia',        cols: ['name'],                     label: r => r.name || '?' },
  baptism:      { gtype: 'baptism',         typeLabel: 'Baptism',         table: 'sacramental_baptism',     cols: ['name'],                     label: r => r.name || '?' },
  firstcomm:    { gtype: 'first_communion', typeLabel: 'First Communion', table: 'sacramental_firstcomm',   cols: ['name'],                     label: r => r.name || '?' },
  confirmation: { gtype: 'confirmation',    typeLabel: 'Confirmation',    table: 'sacramental_confirmation',cols: ['name'],                     label: r => r.name || '?' },
  // Discernment files ride the % layer too (super-admin grants ONE file
  // READ-ONLY to a non-panel user, e.g. a diocesan vocations director). Searched
  // by the inline `name` column — a discerner LINKED to a directory person
  // (name NULL, derived from personnel) is not name-searchable here yet, but a
  // grant on it is fully functional (audit / grantee header / revoke / view gate).
  discerner:    { gtype: 'discerner',       typeLabel: 'Discerner',       table: 'discerners',              cols: ['name'],                     label: r => r.name || 'Discerner' },
};

// Map a mention/link type key → the record_grants.record_type value. Used both
// when writing grants from the % picker and when checking the current user's
// grants against a '#' link chip (see hasMyGrantForLink / canAccessLink).
export const LINK_TYPE_TO_GRANT = Object.fromEntries(
  Object.entries(SAC_GRANTABLE).map(([k, v]) => [k, v.gtype]),
);
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

// ── Current-user grant cache (powers the client access gate) ────────────────
// The set of records the CURRENT user has been granted, as `${type}:${id}`.
// canAccessLink() consults this so a '#' link to an otherwise-locked record
// becomes openable once a super-admin grants it via '%'. Refreshed at boot and
// whenever a message thread is opened (see messaging._fetchAndRenderMessages).
let _myGrants = null;
export async function loadMyGrants(force = false) {
  if (_myGrants && !force) return _myGrants;
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { _myGrants = new Set(); return _myGrants; }
  const { data } = await sb.from('record_grants')
    .select('record_type, record_id').eq('granted_to', user.id);
  _myGrants = new Set((data || []).map(g => `${g.record_type}:${g.record_id}`));
  return _myGrants;
}
// Sync check used by the (synchronous) link-chip renderer. linkType is a mention
// type key ('firstcomm' …); it is mapped to the record_grants record_type.
export function hasMyGrantForLink(linkType, recordId) {
  if (!_myGrants || !recordId) return false;
  const gtype = LINK_TYPE_TO_GRANT[linkType] || linkType;
  return _myGrants.has(`${gtype}:${recordId}`);
}

// ── Grant CRUD (each logs through logActivity) ──────────────────────────────

export async function writeGrant({ recordType, recordId, grantedTo, grantedBy, note = null }) {
  const { data, error } = await sb.from('record_grants').insert({
    record_type: recordType, record_id: recordId,
    granted_to: grantedTo, granted_by: grantedBy, note,
  }).select('*').single();
  if (!error) {
    _myGrants = null;   // self-grant: drop cache so the granter sees it next render
    logActivity({ action: 'granted record access', entityType: 'record_grant',
      entityName: `${recordType}:${recordId}`, contextType: 'hr' });
  }
  return { data, error };
}

export async function revokeGrant(grantId) {
  const { data: row } = await sb.from('record_grants').select('record_type, record_id').eq('id', grantId).maybeSingle();
  const { error } = await deleteWithRetry(() => sb.from('record_grants').delete().eq('id', grantId));
  if (!error) {
    _myGrants = null;   // drop cache so a revoked self-grant re-locks next render
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
// Searches TWO universes and merges them:
//   • HR records — by the staff person they are ABOUT (name → occupancies →
//     records). DB RLS scopes results (super-admin sees all).
//   • Sacramental / marriage / annulment records — by name directly, mirroring
//     the '#' mention picker (these tables have RLS disabled, so the grant flips
//     the client access gate rather than a DB rule).
// The two searches are independent: an empty HR result never suppresses
// sacramental hits, and vice-versa.
export async function searchGrantableRecords(query) {
  const safe = query.trim().replace(/[%_,()"'*]/g, ' ').trim();
  if (!safe) return [];

  // HR universe — gated through personnel → person_positions → HR tables.
  const hrRun = (async () => {
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
    return (await Promise.all(runs)).flat();
  })();

  // Sacramental universe — by name, one ilike-OR query per type.
  const sacRuns = Object.entries(SAC_GRANTABLE).map(async ([mtype, cfg]) => {
    const orExpr = cfg.cols.map(c => `${c}.ilike.%${safe}%`).join(',');
    const { data, error } = await sb.from(cfg.table).select('*').or(orExpr).limit(6);
    if (error) { console.warn('[grant] search', mtype, error.message); return []; }
    return (data || []).map(r => ({
      record_type: cfg.gtype, record_id: r.id,
      label: `${cfg.label(r)} — ${cfg.typeLabel}`,
    }));
  });

  const [hr, ...sac] = await Promise.all([hrRun, ...sacRuns]);
  const merged = [...hr, ...sac.flat()];
  // Rank: label-prefix matches first, then alphabetical.
  const lc = safe.toLowerCase();
  merged.sort((a, b) => {
    const as = a.label.toLowerCase().startsWith(lc) ? 0 : 1;
    const bs = b.label.toLowerCase().startsWith(lc) ? 0 : 1;
    return as - bs || a.label.localeCompare(b.label);
  });
  return merged.slice(0, 10);
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
