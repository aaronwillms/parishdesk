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
  const m = (store.personTitles || {})[personId];
  if (!m) return '';
  if (institutionName) return m.byInstitution[institutionName] || '';
  return (m.all || []).join(' · ');
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
// Shared numeric date display — MM/DD/YYYY (US order; the parish is US-based and all
// inputs are MM/DD). This is the ONE place numeric dates are formatted, so every card
// and file-viewer routes through it and the order can't drift per-site. Previously
// emitted DD/MM/YYYY, which mis-displayed every date app-wide.
export function formatDateMDY(isoDate) {
  if (!isoDate) return '';
  const [y, m, d] = String(isoDate).slice(0, 10).split('-');
  if (!y || !m || !d) return '';
  return `${m}/${d}/${y}`;
}
// Back-compat name kept so existing call sites (31 of them) need no churn.
export const formatDateDisplay = formatDateMDY;

// Parse a DD/MM/YYYY string back to ISO (YYYY-MM-DD) for storage. Returns null if blank/invalid.
export function parseDateInput(displayDate) {
  if (!displayDate) return null;
  const [d, m, y] = String(displayDate).split('/');
  if (!d || !m || !y) return null;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// Sort key for a single full-name string (personnel store full names, not
// discrete first/last). Last whitespace token = surname; the remainder = given
// names (tiebreak). Single-token names and multi-word surnames ("van der Berg")
// are handled gracefully — never crash or drop a name.
export function lastNameKey(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { last: '', first: '' };
  if (parts.length === 1) return { last: parts[0].toLowerCase(), first: '' };
  return { last: parts[parts.length - 1].toLowerCase(), first: parts.slice(0, -1).join(' ').toLowerCase() };
}
// Compare two full-name strings by last name, then given names.
export function compareByLastName(a, b) {
  const ka = lastNameKey(a), kb = lastNameKey(b);
  return ka.last.localeCompare(kb.last) || ka.first.localeCompare(kb.first);
}

// Surface a failed Supabase write to the user AND log the full error object
// (message, details, hint, code) to the console for diagnosis. Use in every
// save error branch so rejections are never silently swallowed.
export function reportWriteError(context, error) {
  console.error(`[${context}] write failed`, {
    message: error?.message, details: error?.details, hint: error?.hint, code: error?.code, error,
  });
  alert('Save failed: ' + (error?.message || 'Unknown error') + (error?.details ? `\n(${error.details})` : ''));
}

export function daysUntil(iso) {
  if (!iso) return null;
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: store.parishSettings?.timezone || 'America/Chicago' }));
  now.setHours(0, 0, 0, 0);
  return Math.round((new Date(iso + 'T00:00:00') - now) / 86400000);
}

export const PANEL_TITLES = {
  dashboard:    "Parish Dashboard",
  marriage:     'Marriage Preparation',
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
