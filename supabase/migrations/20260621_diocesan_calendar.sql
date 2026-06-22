-- ═══════════════════════════════════════════════════════════════════════════
-- Diocesan Calendar: liturgical-header transfer toggles + local festal overrides.
--
-- PROPOSED — pause for approval before applying. Additive + idempotent + nullable.
-- Client-gated (RLS DISABLED), consistent with the other app tables.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 4b) Transfer toggles (diocesan policy → fed to romcal) ───────────────────
-- Which day Ascension / Epiphany / Corpus Christi are observed on. Default TRUE =
-- transferred to Sunday, the common US (Province of Mobile / Diocese of Jackson)
-- practice. Stored on parish_settings (the single parish-config row).
ALTER TABLE parish_settings ADD COLUMN IF NOT EXISTS ascension_on_sunday      boolean NOT NULL DEFAULT true;
ALTER TABLE parish_settings ADD COLUMN IF NOT EXISTS epiphany_on_sunday       boolean NOT NULL DEFAULT true;
ALTER TABLE parish_settings ADD COLUMN IF NOT EXISTS corpus_christi_on_sunday boolean NOT NULL DEFAULT true;

-- ── 4a) Festal overrides (local feasts) ──────────────────────────────────────
-- Each override REPLACES the romcal-computed celebration on its day (name/rank/
-- color). Local overrides are NEVER holy days of obligation — the ✠ comes only
-- from the day being a Sunday/HDO, so there is intentionally no HDO column.
--
-- rule_type:
--   'fixed'    → month + day, every year (patronal feast, etc.)
--   'oneoff'   → full_date, that specific date only
--   'anchored' → anchor (moveable romcal point) + offset_days (±N), computed yearly
--                anchor ∈ ('easter','ashWednesday','goodFriday','ascension','pentecost')
CREATE TABLE IF NOT EXISTS diocesan_overrides (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parish_id    uuid NOT NULL DEFAULT current_parish_id() REFERENCES parish_settings(id) ON DELETE CASCADE,
  name         text NOT NULL,
  rank         text NOT NULL DEFAULT 'Memorial',   -- Solemnity | Feast | Memorial | Optional Memorial
  color        text NOT NULL DEFAULT 'WHITE',       -- GREEN | WHITE | RED | PURPLE | ROSE
  rule_type    text NOT NULL CHECK (rule_type IN ('fixed', 'oneoff', 'anchored')),
  month        int  CHECK (month BETWEEN 1 AND 12),
  day          int  CHECK (day BETWEEN 1 AND 31),
  full_date    date,
  anchor       text CHECK (anchor IN ('easter', 'ashWednesday', 'goodFriday', 'ascension', 'pentecost')),
  offset_days  int  DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ── RLS GOTCHA — RUN AS A SEPARATE STEP, AFTER the CREATE above ──────────────
-- This project auto-RE-ENABLES row-level security on new tables, so the inline
-- disable does not stick. New tables come up with RLS ON and the anon/client gate
-- hits "violates row-level security policy" until RLS is explicitly disabled in its
-- own execution. Re-run this line on its own if needed.
ALTER TABLE diocesan_overrides DISABLE ROW LEVEL SECURITY;
