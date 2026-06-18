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
  admin:        'Administration',
  userProfile:  'My Profile',
};
