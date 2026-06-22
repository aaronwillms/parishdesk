-- ═══════════════════════════════════════════════════════════════════════════
-- Discernment: per-user card PINS + editable-note timestamp.
--
-- PROPOSED — pause for approval before applying. Additive + idempotent + nullable.
-- Client-gated (RLS DISABLED), consistent with the other discernment tables; the
-- app reads only the CURRENT user's pins (`.eq('user_id', auth-uid)`).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Per-user pins ───────────────────────────────────────────────────────────
-- A pin is PER USER (each user's pins are their own), NOT a boolean on the
-- discerner record (that would be a single global flag). One row per (user,
-- discerner); pin = insert, unpin = delete. UNIQUE prevents duplicate pins.
CREATE TABLE IF NOT EXISTS discernment_pins (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parish_id    uuid NOT NULL DEFAULT current_parish_id() REFERENCES parish_settings(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  discerner_id uuid NOT NULL REFERENCES discerners(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, discerner_id)
);
ALTER TABLE discernment_pins DISABLE ROW LEVEL SECURITY;   -- see RLS GOTCHA below
CREATE INDEX IF NOT EXISTS idx_discernment_pins_user ON discernment_pins (user_id);

-- ── Editable notes ──────────────────────────────────────────────────────────
-- discernment_notes is a TABLE (unlike the notes_log jsonb / annulment text-JSON
-- panels, where the edited_at lives INSIDE the JSON and needs no schema change),
-- so it gets a real column. Editing overwrites `body` and stamps `edited_at`;
-- no prior versions are kept.
ALTER TABLE discernment_notes ADD COLUMN IF NOT EXISTS edited_at timestamptz;

-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠️ RLS GOTCHA — RUN THIS AS A SEPARATE STEP, AFTER the CREATE above.
-- This project auto-RE-ENABLES row-level security on every new table, so the
-- inline DISABLE on line 21 does NOT stick (confirmed 3×: discerners,
-- record_links, discernment_pins). New tables come up with RLS ON and the
-- anon/client gate hits "violates row-level security policy" on INSERT until
-- RLS is explicitly disabled in its own execution. Re-run this line on its own:
ALTER TABLE discernment_pins DISABLE ROW LEVEL SECURITY;
