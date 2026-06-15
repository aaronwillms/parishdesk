function unfold(raw) {
  return raw.replace(/\r\n[ \t]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function parseDateTime(value, param) {
  if (!value) return null;
  // Date-only: 20260615
  if (param?.includes('VALUE=DATE') || /^\d{8}$/.test(value)) {
    const y = value.slice(0, 4), m = value.slice(4, 6), d = value.slice(6, 8);
    return { date: new Date(+y, +m - 1, +d), allDay: true };
  }
  // Datetime: 20260615T100000Z or 20260615T100000
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const [, yr, mo, dy, hr, mn, sc, utc] = m;
  const date = utc === 'Z'
    ? new Date(Date.UTC(+yr, +mo - 1, +dy, +hr, +mn, +sc))
    : new Date(+yr, +mo - 1, +dy, +hr, +mn, +sc);
  return { date, allDay: false };
}

function unescape(val) {
  return val.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

export function parseICS(raw) {
  const text = unfold(raw);
  const events = [];
  const blocks = text.split('BEGIN:VEVENT');
  blocks.shift(); // remove preamble before first VEVENT

  for (const block of blocks) {
    const end = block.indexOf('END:VEVENT');
    const lines = (end >= 0 ? block.slice(0, end) : block).split('\n');

    let id = '', summary = '', location = '', description = '';
    let startParsed = null, endParsed = null;

    for (const line of lines) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const key = line.slice(0, colon).trim();
      const val = line.slice(colon + 1).trim();

      if (key === 'UID')         id = val;
      else if (key === 'SUMMARY')     summary = unescape(val);
      else if (key === 'LOCATION')    location = unescape(val);
      else if (key === 'DESCRIPTION') description = unescape(val);
      else if (key.startsWith('DTSTART')) startParsed = parseDateTime(val, key);
      else if (key.startsWith('DTEND'))   endParsed   = parseDateTime(val, key);
    }

    if (!startParsed) continue;

    events.push({
      id:          id || Math.random().toString(36).slice(2),
      title:       summary || '(No title)',
      start:       startParsed.date,
      end:         endParsed?.date || null,
      location:    location || null,
      description: description || null,
      allDay:      startParsed.allDay,
    });
  }

  return events;
}
