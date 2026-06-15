export function todayCST() {
  const n = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
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

export function daysUntil(iso) {
  if (!iso) return null;
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  now.setHours(0, 0, 0, 0);
  return Math.round((new Date(iso + 'T00:00:00') - now) / 86400000);
}

export const PANEL_TITLES = {
  dashboard:    "Parish Dashboard",
  marriage:     'Marriage preparation',
  annulments:   'Annulments',
  baptism:      'Baptismal Preparation',
  firstcomm:    'First Communion',
  confirmation: 'Confirmation',
  ocia:         'OCIA',
  homily:       'Homily preparation',
  school:       'Cathedral Catholic School',
  teams:        'Teams',
  projects:     'My Projects',
  tasks:        'Tasks',
  personnel:    'Directory',
};
