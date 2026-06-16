function unfold(raw) {
  return raw.replace(/\r\n[ \t]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// Convert a wall-clock datetime in a named timezone (TZID) to a UTC Date.
// Uses the Intl offset trick: probe the nominal UTC instant, measure how much
// the TZID local time differs, then shift to find the true UTC instant.
function tzidToDate(yr, mo, dy, hr, mn, sc, tzid) {
  try {
    const probe = new Date(Date.UTC(+yr, +mo - 1, +dy, +hr, +mn, +sc));
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(probe).map(p => [p.type, p.value]));
    const probeLocalMs = Date.UTC(+parts.year, +parts.month - 1, +parts.day,
                                  +parts.hour % 24, +parts.minute, +parts.second);
    return new Date(probe.getTime() - (probeLocalMs - probe.getTime()));
  } catch {
    // Unknown TZID — fall back to treating the time as local browser time
    return new Date(+yr, +mo - 1, +dy, +hr, +mn, +sc);
  }
}

function parseDateTime(value, param) {
  if (!value) return null;

  // Date-only: VALUE=DATE or bare 8-digit string (all-day event, no timezone)
  if (param?.includes('VALUE=DATE') || /^\d{8}$/.test(value)) {
    const y = value.slice(0, 4), m = value.slice(4, 6), d = value.slice(6, 8);
    return { date: new Date(+y, +m - 1, +d), allDay: true, tzid: null };
  }

  // Datetime: 20260615T100000Z (UTC) or 20260615T100000 (floating/TZID)
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!match) return null;
  const [, yr, mo, dy, hr, mn, sc, utcFlag] = match;

  // Extract TZID from the property parameter, e.g. "DTSTART;TZID=America/Chicago"
  const tzidMatch = param?.match(/TZID=([^;:]+)/);
  const tzid = tzidMatch ? tzidMatch[1] : null;

  let date;
  if (utcFlag === 'Z') {
    // Explicit UTC
    date = new Date(Date.UTC(+yr, +mo - 1, +dy, +hr, +mn, +sc));
  } else if (tzid) {
    // Named timezone — convert wall-clock time to UTC
    date = tzidToDate(yr, mo, dy, hr, mn, sc, tzid);
  } else {
    // Floating time — no timezone specified, treat as local browser time
    date = new Date(+yr, +mo - 1, +dy, +hr, +mn, +sc);
  }

  return { date, allDay: false, tzid };
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

      if (key === 'UID')                   id          = val;
      else if (key === 'SUMMARY')          summary     = unescape(val);
      else if (key === 'LOCATION')         location    = unescape(val);
      else if (key === 'DESCRIPTION')      description = unescape(val);
      else if (key.startsWith('DTSTART'))  startParsed = parseDateTime(val, key);
      else if (key.startsWith('DTEND'))    endParsed   = parseDateTime(val, key);
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
      _tzid:       startParsed.tzid,
    });
  }

  return events;
}
