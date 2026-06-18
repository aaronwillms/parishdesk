import { sb } from './supabase.js';
import { store } from './store.js';

export async function logActivity({ action, entityType, entityName, contextType = 'general', contextId = null }) {
  try {
    const { data: { user } } = await sb.auth.getUser();
    await sb.from('activity_log').insert({
      triggered_by: user?.id || null,
      action,
      entity_type:  entityType,
      entity_name:  entityName,
      context_type: contextType,
      context_id:   contextId || null,
    });
  } catch (e) {
    console.warn('[logActivity] failed:', e);
  }
}

// Resolve a person's directory title(s) from their CURRENT HR positions.
// Titles derive from person_positions -> positions (the title field on the
// personnel row was retired in the HR-module Stage 1 collapse). store.personTitles
// is populated by loadPersonnel() from the person_current_titles view, shaped:
//   { [personId]: { byInstitution: { [instName]: title }, all: [title, ...] } }
// With an institution name, returns that institution's collapsed title; without
// one, joins all current titles. Empty string when the person holds no position.
export function personTitle(personId, institutionName = null) {
  const entries = (store.personDirectory || {})[personId] || [];
  if (!entries.length) return '';
  if (institutionName) return entries.find(e => e.institution_name === institutionName)?.title || '';
  return entries.map(e => e.title).filter(Boolean).join(' · ');
}

// ── HR-derived directory placement (single source of truth) ─────────────────
// store.personPlacement[id] = { isClergy, hasPosition, derivedType } (person_placement view)
// store.personDirectory[id] = [{ institution_id, institution_name, title, entry_is_clergy, employment_heading }] (person_directory view)
// Both are loaded by loadPersonnel(). These replace the retired manual
// personnel.institution / personnel.type / personnel.employment columns.
export function isPersonClergy(personId) {
  return !!(store.personPlacement || {})[personId]?.isClergy;
}
export function personDerivedType(personId) {
  return (store.personPlacement || {})[personId]?.derivedType || 'volunteer';
}
export function personEntries(personId) {
  return (store.personDirectory || {})[personId] || [];
}

export function todayCST() {
  const tz = store.parishSettings?.timezone || 'America/Chicago';
  const n = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export function fmtDateYear(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${parseInt(d)} ${MONTHS[parseInt(m) - 1]} ${y}`;
}

export function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${parseInt(d)} ${MONTHS[parseInt(m) - 1]}`;
}

// Display an ISO date (YYYY-MM-DD) as DD/MM/YYYY. Storage stays ISO; only display changes.
export function formatDateDisplay(isoDate) {
  if (!isoDate) return '';
  const [y, m, d] = String(isoDate).slice(0, 10).split('-');
  if (!y || !m || !d) return '';
  return `${d}/${m}/${y}`;
}

// Parse a DD/MM/YYYY string back to ISO (YYYY-MM-DD) for storage. Returns null if blank/invalid.
export function parseDateInput(displayDate) {
  if (!displayDate) return null;
  const [d, m, y] = String(displayDate).split('/');
  if (!d || !m || !y) return null;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

export function daysUntil(iso) {
  if (!iso) return null;
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: store.parishSettings?.timezone || 'America/Chicago' }));
  now.setHours(0, 0, 0, 0);
  return Math.round((new Date(iso + 'T00:00:00') - now) / 86400000);
}

export const PANEL_TITLES = {
  dashboard:    "Parish Dashboard",
  marriage:     'Marriage preparation',
  annulments:   'Annulments',
  discernment:  'Discernment Tracker',
  homebound:    'Sick & Homebound',
  baptism:      'Baptismal Preparation',
  firstcomm:    'First Communion',
  confirmation: 'Confirmation',
  ocia:         'OCIA',
  homily:       'Homily preparation',
  school:       'Cathedral Catholic School',
  teams:        'Teams',
  projects:     'My Projects',
  tasks:        'My Tasks',
  personnel:    'Directory',
  hr:           'Human Resources',
  admin:        'Administration',
  userProfile:  'My Profile',
};
