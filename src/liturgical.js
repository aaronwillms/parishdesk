// ── Liturgical header (romcal-computed) ──────────────────────────────────────
// Replaces the old hand-rolled, year-hardcoded getLiturgicalDay() (which computed
// the Ordinary-Time week with a brittle day-offset formula — off by one, e.g. it
// showed "ELEVENTH" for 2026-06-21 which is really the XII Sunday of OT — and broke
// for any year but 2025-26). This computes the day from romcal with the US national
// calendar, in the parish's LOCAL timezone, fed by the diocesan transfer toggles,
// with local festal overrides applied on top.
//
// HDO note: romcal 1.x does NOT flag holy days of obligation, so we determine US HDO
// status ourselves from the celebration KEY (HDO_KEYS) ∪ Sundays — see ✠ rule below.

// Import romcal's PREBUILT UMD bundle, not its ESM entry. The ESM entry pulls in
// moment-recur, whose moment monkey-patching breaks under Vite/esbuild dep
// optimization ("Cannot set properties of undefined (setting 'recur')") in BOTH
// dev and the production bundle. The prebuilt bundle has moment + its plugins
// already wired internally (built by romcal's own webpack), so it loads cleanly.
import RomcalBundle from 'romcal/dist/romcal.bundle.min.js';
import { store } from './store.js';

const romcal = (RomcalBundle && RomcalBundle.calendarFor)
  ? RomcalBundle
  : (RomcalBundle && RomcalBundle.default) || RomcalBundle;

// ── US universal Holy Days of Obligation (by romcal celebration key) ─────────
// Whatever DAY romcal assigns these to (incl. a transferred Ascension), that day is
// an HDO → carries ✠. Epiphany & Corpus Christi are NOT HDOs in the US (transferred
// to Sunday). Sundays are always HDOs (handled separately).
const HDO_KEYS = new Set([
  'maryMotherOfGod', 'epiphany', 'ascension', 'assumption', 'allSaints', 'immaculateConception', 'christmas',
]);
// Epiphany is a US HDO too. When transferred to Sunday (the default) the Sunday
// already carries ✠; when NOT transferred (epiphany_on_sunday off → romcal puts it
// on Jan 6, possibly a weekday) the 'epiphany' key supplies the ✠.

// Liturgical-color key → vestment palette. WHITE and GOLD are DISTINCT (a white
// SOLEMNITY renders gold; ordinary white Sundays/feasts stay white — see colorKeyFor).
const COLOR_MAP = {
  GREEN: '#3B6D11', WHITE: '#F0EDE6', GOLD: '#C9A84C', RED: '#8B1A2F',
  PURPLE: '#534AB7', VIOLET: '#534AB7', ROSE: '#C47E9A', PINK: '#C47E9A', BLACK: '#2C2C2A',
};
const colorHex = (key) => COLOR_MAP[String(key || '').toUpperCase()] || '#3B6D11';

// Ferial color of a season (used when a feria carries only optional memorials —
// the day stays the season's color, not the saint's).
function seasonColorKey(season) {
  if (/lent|advent/i.test(season)) return 'PURPLE';
  if (/easter|christmas/i.test(season)) return 'WHITE';
  return 'GREEN';
}
// HEADER COLOR RULES — applied to romcal's computed color (NOT to overrides, which
// supply their own color). Returns the final color KEY.
function colorKeyFor(base, rank, ymd, season) {
  const baseKey = String(base?.data?.meta?.liturgicalColor?.key || 'GREEN').toUpperCase();
  const name = base?.name || '';
  if (ymd.slice(5) === '11-02') return 'BLACK';                       // 3) All Souls (Nov 2) → black
  if (/3rd Sunday of Advent/i.test(name)) return 'ROSE';             // 5) Gaudete → rose
  if (/4th Sunday of Lent/i.test(name)) return 'ROSE';              // 5) Laetare → rose
  if (rank === 'OPT_MEMORIAL') return seasonColorKey(season);        // 4) feria + optional memorial → season color
  if (rank === 'SOLEMNITY' && baseKey === 'WHITE') return 'GOLD';    // 1) white solemnity → gold (incl. solemnity-Sundays)
  return baseKey;                                                    // 2) red stays red; all else unchanged
}

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX', 'XXI', 'XXII', 'XXIII', 'XXIV', 'XXV', 'XXVI', 'XXVII', 'XXVIII', 'XXIX', 'XXX', 'XXXI', 'XXXII', 'XXXIII', 'XXXIV'];
const roman = (n) => ROMAN[n] || String(n);

// romcal seasons surface as "Eastertide" in season.value but "Easter" in names;
// normalise to the name form used in the header.
const seasonName = (s) => /easter/i.test(s) ? 'Easter' : s;

const pad2 = (n) => String(n).padStart(2, '0');
const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + Number(n || 0)); return d.toISOString().slice(0, 10); };

// ── romcal calendar cache (per civil year + transfer config) ─────────────────
const _calCache = new Map();
function yearCalendar(year, t) {
  const key = `${year}|${t.ascensionOnSunday ? 1 : 0}${t.epiphanyOnSunday ? 1 : 0}${t.corpusChristiOnSunday ? 1 : 0}`;
  if (_calCache.has(key)) return _calCache.get(key);
  const cal = romcal.calendarFor({
    year, country: 'unitedStates', locale: 'en',
    ascensionOnSunday: !!t.ascensionOnSunday,
    epiphanyOnJan6: !t.epiphanyOnSunday,   // romcal 1.x option is inverted from our "on Sunday" toggle
    corpusChristiOnSunday: !!t.corpusChristiOnSunday,
  });
  _calCache.set(key, cal);
  return cal;
}
const ymdOf = (entry) => String(entry.moment).slice(0, 10);
const entryForDate = (cal, ymd) => cal.find(e => ymdOf(e) === ymd) || null;

// Moveable anchors (for anchored overrides), resolved from the same calendar so they
// respect the transfer toggles (e.g. Ascension's actual day).
function anchorsFor(cal) {
  const byKey = (k) => { const e = cal.find(x => x.key === k); return e ? ymdOf(e) : null; };
  return {
    easter: byKey('easter'), ashWednesday: byKey('ashWednesday'), goodFriday: byKey('goodFriday'),
    ascension: byKey('ascension'), pentecost: byKey('pentecostSunday'),
  };
}

// ── Transfer toggles + overrides from the store (diocesan config) ────────────
// Defaults = the common US / Province of Mobile (Diocese of Jackson) practice:
// all three moveable feasts transferred to Sunday.
export function diocesanTransfers() {
  const p = store.parishSettings || {};
  const def = (v) => (v === undefined || v === null) ? true : !!v;
  return {
    ascensionOnSunday: def(p.ascension_on_sunday),
    epiphanyOnSunday: def(p.epiphany_on_sunday),
    corpusChristiOnSunday: def(p.corpus_christi_on_sunday),
  };
}
const diocesanOverrides = () => Array.isArray(store.diocesanOverrides) ? store.diocesanOverrides : [];

// Find a local override whose computed date matches the given parish-local ymd.
function overrideForDate(ymd, year, cal, overrides) {
  const anchors = anchorsFor(cal);
  for (const o of overrides) {
    let target = null;
    if (o.rule_type === 'fixed' && o.month && o.day) target = `${year}-${pad2(o.month)}-${pad2(o.day)}`;
    else if (o.rule_type === 'oneoff' && o.full_date) target = String(o.full_date).slice(0, 10);
    else if (o.rule_type === 'anchored' && o.anchor && anchors[o.anchor]) target = addDays(anchors[o.anchor], o.offset_days);
    if (target === ymd) return o;
  }
  return null;
}

// ── Rank normalisation ───────────────────────────────────────────────────────
// romcal `type` → our variant rank. COMMEMORATION (Lenten weekday saints) behaves
// like an optional memorial on the feria.
const RANK_FROM_TYPE = {
  SOLEMNITY: 'SOLEMNITY', FEAST: 'FEAST', MEMORIAL: 'MEMORIAL', OPT_MEMORIAL: 'OPT_MEMORIAL',
  COMMEMORATION: 'OPT_MEMORIAL', SUNDAY: 'SUNDAY', FERIA: 'FERIA', HOLY_WEEK: 'NAMED', TRIDUUM: 'NAMED',
};
const RANK_FROM_OVERRIDE = {
  solemnity: 'SOLEMNITY', feast: 'FEAST', memorial: 'MEMORIAL',
  'optional memorial': 'OPT_MEMORIAL', 'opt memorial': 'OPT_MEMORIAL',
};
const RANK_LABEL = { SOLEMNITY: 'Solemnity', FEAST: 'Feast', MEMORIAL: 'Memorial', OPT_MEMORIAL: 'Optional Memorial' };

// Most-recent Sunday on/before ymd (for the season week line).
function recentSunday(cal, ymd) {
  let best = null;
  for (const e of cal) {
    const ey = ymdOf(e);
    if (ey > ymd) break;
    if (e.type === 'SUNDAY' || (new Date(ey + 'T12:00:00').getDay() === 0)) best = e;
  }
  return best;
}
// "XII Week of Ordinary Time" / "III Week of Easter" etc.
function weekLine(baseEntry, cal, ymd) {
  let m = baseEntry?.name?.match(/of the (\d+)(?:st|nd|rd|th)\s+week\s+of\s+(.+)$/i);
  if (m) return `${roman(+m[1])} Week of ${seasonName(m[2]).trim()}`;
  const sun = recentSunday(cal, ymd);
  const sm = sun?.name?.match(/^(\d+)(?:st|nd|rd|th)\s+Sunday\s+of\s+(.+)$/i);
  if (sm) return `${roman(+sm[1])} Week of ${seasonName(sm[2]).trim()}`;
  return seasonName(baseEntry?.data?.season?.value || '');
}

const upper = (s) => String(s || '').toUpperCase();
// Sunday line-2 name: "XII SUNDAY OF ORDINARY TIME" for an ordinary Sunday, else the
// celebration name in caps (Easter, Palm Sunday, an override, …).
function sundayName(displayName) {
  const m = displayName.match(/^(\d+)(?:st|nd|rd|th)\s+Sunday\s+of\s+(.+)$/i);
  if (m) return `${roman(+m[1])} SUNDAY OF ${upper(seasonName(m[2]).trim())}`;
  return upper(displayName);
}
// Split romcal's '/'-joined optional memorials into "a; b; c".
const memorialList = (name) => String(name || '').split('/').map(s => s.trim()).filter(Boolean).join('; ');

// ── Core: compute the displayed liturgical day ───────────────────────────────
export function computeLiturgicalDay(date = new Date(), tz = 'America/Chicago') {
  const transfers = diocesanTransfers();
  const ymd = date.toLocaleDateString('en-CA', { timeZone: tz });          // parish-LOCAL date
  const year = Number(ymd.slice(0, 4));
  const dow = new Date(ymd + 'T12:00:00').getDay();                        // 0 = Sunday
  const cal = yearCalendar(year, transfers);
  const base = entryForDate(cal, ymd);

  const civilDate = date.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  if (!base) return { civilDate, cross: dow === 0, line2: 'FERIA', line3: '', color: '#3B6D11', season: 'Ordinary Time' };

  const isSunday = dow === 0;
  // ✠ is a property of the DAY: Sunday OR a US HDO. Determined from the romcal day
  // (NOT the override — a local override never carries its own HDO status).
  const isHDO = isSunday || HDO_KEYS.has(base.key);

  // Override REPLACES the displayed celebration (name/rank/color) if one matches today.
  const ov = overrideForDate(ymd, year, cal, diocesanOverrides());
  const rank = ov ? (RANK_FROM_OVERRIDE[String(ov.rank || '').toLowerCase()] || 'MEMORIAL') : (RANK_FROM_TYPE[base.type] || 'FERIA');
  const name = ov ? ov.name : base.name;
  const season = seasonName(base.data?.season?.value || 'Ordinary Time');
  // Overrides use their picked color directly; romcal days go through the color rules.
  const color = ov ? colorHex(ov.color) : colorHex(colorKeyFor(base, rank, ymd, season));

  const cross = isHDO;
  const xp = cross ? '✠ ' : '';
  let line2 = '', line3 = '', feriaMems = '';

  if (isSunday) {
    // Variant A — the day is a Sunday (incl. an override or solemnity on a Sunday).
    line2 = xp + (ov ? upper(name) : sundayName(name));
    line3 = (rank === 'SOLEMNITY' || rank === 'FEAST') ? RANK_LABEL[rank] : '';   // plain green Sunday → no rank line
  } else if (rank === 'SOLEMNITY' || rank === 'FEAST') {
    // Variant B — weekday solemnity/feast.
    line2 = xp + upper(name);
    line3 = RANK_LABEL[rank];
  } else if (rank === 'MEMORIAL') {
    // Variant C — obligatory memorial.
    line2 = name;
    line3 = 'Memorial';
  } else if (rank === 'NAMED') {
    // Holy Week / Triduum weekday — show the proper name + the season week line.
    line2 = xp + upper(name);
    line3 = weekLine(base, cal, ymd);
  } else {
    // Variant D — feria (with optional memorials, if any) + season week line.
    const mems = rank === 'OPT_MEMORIAL' ? memorialList(name) : '';
    feriaMems = mems;
    line2 = mems ? `FERIA, ${mems}` : 'FERIA';
    line3 = weekLine(base, cal, ymd);
  }

  return { civilDate, cross, line2, line3, color, season, feriaMems, feriaMemorials: !!feriaMems };
}

// ── DOM wiring ───────────────────────────────────────────────────────────────
export function initLiturgical() {
  const tz = store.parishSettings?.timezone || 'America/Chicago';
  let lit;
  try {
    lit = computeLiturgicalDay(new Date(), tz);
  } catch (e) {
    console.error('[liturgical] compute failed:', e);
    lit = { civilDate: new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }), cross: false, line2: '', line3: '', color: '#3B6D11', season: '' };
  }

  const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
  set('lit-date', lit.civilDate);

  const dayEl = document.getElementById('lit-day');
  if (dayEl) {
    if (lit.feriaMems) {
      // "FERIA" keeps the header size; the optional memorial(s) render slightly
      // smaller + italic. romcal supplies the names (no user input), but escape anyway.
      const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      dayEl.innerHTML = `FERIA, <span class="lit-feria-mem">${esc(lit.feriaMems)}</span>`;
    } else {
      dayEl.textContent = lit.line2;
    }
    // Feria with optional memorials may wrap — hang the wrapped lines under the saints.
    dayEl.style.textIndent = lit.feriaMemorials ? '-3.4em' : '';
    dayEl.style.paddingLeft = lit.feriaMemorials ? '3.4em' : '';
  }
  const rankEl = document.getElementById('lit-rank');
  if (rankEl) { rankEl.textContent = lit.line3 || ''; rankEl.style.display = lit.line3 ? '' : 'none'; }

  const icon = document.getElementById('lit-color-icon');
  // fa-church tinted to the final liturgical color. Black vestments (#2C2C2A) are
  // invisible on the navy block, so render those as silver instead.
  if (icon) icon.style.color = lit.color === '#2C2C2A' ? '#B8BCC2' : lit.color;
  const bar = document.getElementById('season-bar');
  if (bar) bar.style.background = lit.color;
  const topbarSeason = document.getElementById('topbar-season');
  if (topbarSeason) topbarSeason.textContent = lit.season;
  return lit;
}
