import { RRule } from 'rrule';

function unfold(raw) {
  return raw.replace(/\r\n[ \t]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// Returns the UTC offset of tzid at the given instant, in minutes.
// Uses the locale-string cancellation trick: both strings are parsed by new Date()
// in browser-local time, so the browser offset cancels and only the TZID offset remains.
// Works correctly regardless of browser timezone setting.
function getOffsetMinutes(date, tzid) {
  const utc   = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const local  = new Date(date.toLocaleString('en-US', { timeZone: tzid }));
  return (utc - local) / 60000;
}

// Convert a wall-clock datetime string ("YYYYMMDDTHHmmss") in a named IANA timezone to UTC.
// Treats the datetime as UTC first, then applies the DST-aware offset for tzid at that instant.
function parseTzidDate(dateStr, tzid) {
  try {
    const y  = dateStr.substr(0, 4), mo = dateStr.substr(4, 2), d  = dateStr.substr(6, 2);
    const h  = dateStr.substr(9, 2)  || '00';
    const mi = dateStr.substr(11, 2) || '00';
    const s  = dateStr.substr(13, 2) || '00';
    const naiveDate    = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`); // treat wall-clock as UTC
    const offsetMins   = getOffsetMinutes(naiveDate, tzid);             // DST-aware offset for tzid
    return new Date(naiveDate.getTime() + offsetMins * 60000);          // shift to true UTC
  } catch {
    return null;
  }
}

function parseDateTime(value, param) {
  if (!value) return null;

  // Date-only: VALUE=DATE or bare 8-digit string (all-day)
  if (param?.includes('VALUE=DATE') || /^\d{8}$/.test(value)) {
    const y = value.slice(0, 4), m = value.slice(4, 6), d = value.slice(6, 8);
    return { date: new Date(+y, +m - 1, +d), allDay: true, tzid: null };
  }

  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!match) return null;
  const [, yr, mo, dy, hr, mn, sc, utcFlag] = match;

  const tzidMatch = param?.match(/TZID=([^;:]+)/);
  const tzid = tzidMatch ? tzidMatch[1] : null;

  let date;
  if (utcFlag === 'Z') {
    date = new Date(Date.UTC(+yr, +mo - 1, +dy, +hr, +mn, +sc));
  } else if (tzid) {
    date = parseTzidDate(value, tzid);
    console.log('[ics] raw DTSTART:', value, 'TZID:', tzid);
    console.log('[ics] parsed as UTC:', date?.toISOString());
    console.log('[ics] displayed as parish time:', date?.toLocaleString('en-US', { timeZone: tzid }));
  } else {
    date = new Date(+yr, +mo - 1, +dy, +hr, +mn, +sc);
  }

  return { date, allDay: false, tzid };
}

// Parse an EXDATE property value into a Set of ISO date strings (YYYY-MM-DD or full ISO)
// so we can quickly check if a given occurrence is excluded.
function parseExdates(value, param) {
  const dates = new Set();
  for (const part of value.split(',')) {
    const parsed = parseDateTime(part.trim(), param);
    if (parsed?.date) {
      // Normalize to YYYY-MM-DD for date-level exclusions; also store full ms for precision
      dates.add(parsed.date.toISOString().slice(0, 10));
      dates.add(String(parsed.date.getTime()));
    }
  }
  return dates;
}

// Format a Date as the compact UTC string rrule expects: YYYYMMDDTHHmmssZ
function toRRuleDtstart(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
         `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

// Expand a recurring event for a specific target date window [windowStart, windowEnd).
// Returns an array of UTC Date objects representing occurrences within that window.
function expandRRule(dtstart, rruleStr, windowStart, windowEnd, exdates) {
  try {
    // rrule operates in UTC — dtstart must already be a proper UTC Date
    const ruleText = `DTSTART:${toRRuleDtstart(dtstart)}\n${rruleStr}`;
    const rule = RRule.fromString(ruleText);
    const occurrences = rule.between(windowStart, windowEnd, true /* inclusive */);
    return occurrences.filter(d => {
      const dateKey  = d.toISOString().slice(0, 10);
      const msKey    = String(d.getTime());
      return !exdates.has(dateKey) && !exdates.has(msKey);
    });
  } catch (e) {
    console.warn('[icsParser] RRULE expansion failed:', rruleStr, e);
    return [];
  }
}

function unescape(val) {
  return val.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

// Public API: parse an ICS string and return events.
// If targetDate is provided, recurring events are expanded to find occurrences
// on that calendar date (in parishTz). Non-recurring events outside targetDate
// are also filtered out when targetDate is provided.
export function parseICS(raw, { targetDate, timezone } = {}) {
  const parishTz = timezone || 'America/Chicago';
  const text = unfold(raw);
  const events = [];
  const blocks = text.split('BEGIN:VEVENT');
  blocks.shift();

  const filterByDate = !!targetDate;
  const todayStr = filterByDate
    ? new Date(targetDate).toLocaleDateString('en-CA', { timeZone: parishTz || 'America/Chicago' })
    : null;

  // Build window for rrule.between — full UTC day span wide enough to catch any TZ offset
  let windowStart, windowEnd;
  if (filterByDate) {
    windowStart = new Date(targetDate);
    windowStart.setUTCHours(0, 0, 0, 0);
    windowStart = new Date(windowStart.getTime() - 14 * 60 * 60 * 1000); // 14h buffer before
    windowEnd   = new Date(targetDate);
    windowEnd.setUTCHours(23, 59, 59, 999);
    windowEnd   = new Date(windowEnd.getTime() + 14 * 60 * 60 * 1000);   // 14h buffer after
  }

  for (const block of blocks) {
    const end = block.indexOf('END:VEVENT');
    const lines = (end >= 0 ? block.slice(0, end) : block).split('\n');

    let id = '', summary = '', location = '', description = '';
    let startParsed = null, endParsed = null;
    let rruleStr = null;
    const exdates = new Set();

    for (const line of lines) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const key = line.slice(0, colon).trim();
      const val = line.slice(colon + 1).trim();

      if      (key === 'UID')                  id          = val;
      else if (key === 'SUMMARY')              summary     = unescape(val);
      else if (key === 'LOCATION')             location    = unescape(val);
      else if (key === 'DESCRIPTION')          description = unescape(val);
      else if (key === 'RRULE')                rruleStr    = val;
      else if (key.startsWith('DTSTART'))      startParsed = parseDateTime(val, key);
      else if (key.startsWith('DTEND'))        endParsed   = parseDateTime(val, key);
      else if (key.startsWith('EXDATE')) {
        const ex = parseExdates(val, key);
        ex.forEach(d => exdates.add(d));
      }
    }

    if (!startParsed) continue;

    const duration = endParsed?.date
      ? endParsed.date.getTime() - startParsed.date.getTime()
      : 60 * 60 * 1000; // default 1 hour

    if (rruleStr) {
      // Recurring event — expand occurrences
      if (!filterByDate) {
        // Without a target date, just return the base event (caller can filter)
        events.push({
          id, title: summary || '(No title)',
          start: startParsed.date, end: endParsed?.date || null,
          location: location || null, description: description || null,
          allDay: startParsed.allDay, _tzid: startParsed.tzid, _rrule: rruleStr,
        });
        continue;
      }

      const occurrences = expandRRule(startParsed.date, rruleStr, windowStart, windowEnd, exdates);
      for (const occ of occurrences) {
        // Verify the occurrence actually falls on todayStr in parish timezone
        const occDateStr = occ.toLocaleDateString('en-CA', { timeZone: parishTz || 'America/Chicago' });
        if (occDateStr !== todayStr) continue;

        const occEnd = endParsed?.date ? new Date(occ.getTime() + duration) : null;
        events.push({
          id: `${id}_${occ.getTime()}`,
          title:       summary || '(No title)',
          start:       occ,
          end:         occEnd,
          location:    location || null,
          description: description || null,
          allDay:      startParsed.allDay,
          _tzid:       startParsed.tzid,
          _rrule:      rruleStr,
        });
      }
    } else {
      // Non-recurring event
      if (filterByDate) {
        const evTz = startParsed.tzid || parishTz || 'America/Chicago';
        const evDateStr = startParsed.allDay
          ? new Date(startParsed.date).toLocaleDateString('en-CA')
          : new Date(startParsed.date).toLocaleDateString('en-CA', { timeZone: evTz });
        if (evDateStr !== todayStr) continue;
      }

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
  }

  return events;
}
