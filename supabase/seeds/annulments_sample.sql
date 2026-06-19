-- ─────────────────────────────────────────────────────────────────────────────
-- SAMPLE / THROWAWAY annulment cases — for eyeballing the Phase-1 shell list,
-- status groups, chips, and the bottom Archive section. NOT real data.
--
-- Run in the Supabase SQL editor to preview, then WIPE before any real seed:
--     DELETE FROM annulment_cases WHERE petitioner_last IN
--       ('Piazza','Hartwell','Okafor','Bauer','Sandoval');
--   (the five sample petitioner last names below)
--
-- Exercises every Phase-1 chip/sort state:
--   1. Preparing — docs incomplete        (Preparing group, no Docs-Complete chip)
--   2. Preparing — docs complete          (Preparing group, green "Docs Complete")
--   3. In Tribunal — briefer_process=true (In Tribunal group, "Briefer Process" type chip)
--   4. Affirmative — NOT finalized        (Affirmative group, "Affirmative · Pending")
--   5. Archived (boolean)                 (bottom "Archived" section, overrides status)
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Preparing, documents incomplete. Maiden override → title "Glodjo vs Piazza".
INSERT INTO annulment_cases
  (petitioner, respondent,
   petitioner_first, petitioner_middle, petitioner_last, petitioner_maiden,
   respondent_first, respondent_last, annulment_type, status_code, archived,
   briefer_process, judgement_finalized, tribunal_diocese, date_filed,
   contact_phone, contact_email, documents, timeline)
VALUES
  ('Eva Piazza','Michael Piazza',
   'Eva','Faye','Piazza','Glodjo','Michael','Piazza','formal','prep',false,
   false,'no','Diocese of Jackson','2026-02-10','6015550101','eva.sample@example.com',
   '[{"name":"Completed Petition","received":true,"deletable":false},
     {"name":"Marriage License","received":false,"deletable":false},
     {"name":"Divorce Decree","received":false,"deletable":false}]'::jsonb,
   '[{"type":"auto","text":"Case opened","created_at":"2026-02-10T15:00:00Z"}]'::jsonb);

-- 2) Preparing, ALL documents complete → green "Docs Complete" chip.
INSERT INTO annulment_cases
  (petitioner, respondent,
   petitioner_first, petitioner_last, respondent_first, respondent_last,
   annulment_type, status_code, archived, briefer_process, judgement_finalized,
   tribunal_diocese, date_filed, documents, timeline)
VALUES
  ('Thomas Hartwell','Marie Hartwell',
   'Thomas','Hartwell','Marie','Hartwell','lack_of_form','prep',false,
   false,'no','Diocese of Jackson','2026-03-01',
   '[{"name":"Completed Petition","received":true,"deletable":false},
     {"name":"Marriage License","received":true,"deletable":false},
     {"name":"Divorce Decree","received":true,"deletable":false}]'::jsonb,
   '[{"type":"auto","text":"Case opened","created_at":"2026-03-01T15:00:00Z"},
     {"type":"auto","text":"Documents Collected","created_at":"2026-03-20T17:30:00Z"}]'::jsonb);

-- 3) In Tribunal, briefer_process=true → type chip shows "Briefer Process".
INSERT INTO annulment_cases
  (petitioner, respondent,
   petitioner_first, petitioner_last, respondent_first, respondent_last,
   annulment_type, status_code, archived, briefer_process, judgement_finalized,
   tribunal_diocese, date_filed, documents, timeline)
VALUES
  ('Daniel Okafor','Grace Okafor',
   'Daniel','Okafor','Grace','Okafor','formal','tribunal',false,
   true,'no','Diocese of Jackson','2025-11-15',
   '[{"name":"Completed Petition","received":true,"deletable":false},
     {"name":"Personal Testimony","received":true,"deletable":true}]'::jsonb,
   '[{"type":"auto","text":"Case opened","created_at":"2025-11-15T15:00:00Z"},
     {"type":"progress","text":"Submitted to Tribunal","created_at":"2025-12-02T16:00:00Z"}]'::jsonb);

-- 4) Affirmative judgement, NOT finalized → "Affirmative · Pending".
INSERT INTO annulment_cases
  (petitioner, respondent,
   petitioner_first, petitioner_last, respondent_first, respondent_last,
   annulment_type, status_code, archived, briefer_process, judgement_finalized,
   tribunal_diocese, date_filed, documents, timeline)
VALUES
  ('Laura Bauer','Kevin Bauer',
   'Laura','Bauer','Kevin','Bauer','formal','affirm',false,
   false,'no','Diocese of Jackson','2025-08-01',
   '[{"name":"Completed Petition","received":true,"deletable":false}]'::jsonb,
   '[{"type":"auto","text":"Case opened","created_at":"2025-08-01T15:00:00Z"},
     {"type":"auto","text":"Affirmative Decision Received","created_at":"2026-04-10T18:00:00Z"}]'::jsonb);

-- 5) Archived (boolean) — appears in the bottom "Archived" section regardless of status.
INSERT INTO annulment_cases
  (petitioner, respondent,
   petitioner_first, petitioner_last, respondent_first, respondent_last,
   annulment_type, status_code, archived, briefer_process, judgement_finalized,
   tribunal_diocese, date_filed, documents, timeline)
VALUES
  ('Rosa Sandoval','Hector Sandoval',
   'Rosa','Sandoval','Hector','Sandoval','formal','affirm',true,
   false,'yes','Diocese of Jackson','2024-05-01',
   '[{"name":"Completed Petition","received":true,"deletable":false}]'::jsonb,
   '[{"type":"auto","text":"Case opened","created_at":"2024-05-01T15:00:00Z"},
     {"type":"auto","text":"Case Closed","created_at":"2025-09-01T18:00:00Z"}]'::jsonb);
