-- ═══════════════════════════════════════════════════════════════════════════
-- WIPE test-phase RECORD DATA  (DESTRUCTIVE — snapshot confirmed before running)
--
-- Deletes record data only; leaves structure/config and ALL users intact.
-- Runs as ONE transaction. It SHIPS SET TO `ROLLBACK` — i.e. a DRY RUN that
-- changes nothing. Run it, read the verification counts at the bottom, and ONLY
-- if WIPE = 0 / CASCADE = 0 / KEEP unchanged, change the final `ROLLBACK;` to
-- `COMMIT;` and run again to apply permanently.
--
-- WIPE: sacramental_baptism, sacramental_firstcomm, sacramental_confirmation,
--       sacramental_ocia, sacramental_cohorts, couples, annulment_cases,
--       projects, tasks, project_log, project_log_comments, personnel,
--       team_members, activity_log, notifications, announcements,
--       announcement_dismissals, and PROJECT-scoped discussions only.
-- KEEP: user_profiles, user_roles, sacramental_roles, panel_grants,
--       parish_settings, institutions, teams, calendars, *_templates,
--       push_subscriptions, notification_preferences, TEAM discussions.
--
-- Child→parent order, explicit (safe whether each FK is CASCADE or RESTRICT).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- 1. Project children → project
DELETE FROM project_log_comments;
DELETE FROM project_log;
DELETE FROM tasks;

-- 2. PROJECT-scoped discussions only (team discussions are KEPT)
DELETE FROM discussion_messages
 WHERE discussion_id IN (SELECT id FROM discussions WHERE context_type = 'project');
DELETE FROM discussions WHERE context_type = 'project';

-- 3. Projects
DELETE FROM projects;

-- 4. Announcements (dismissals child first)
DELETE FROM announcement_dismissals;
DELETE FROM announcements;

-- 5. Sacramental + marriage + annulments
--    annulment_cases first: its linked_marriage_prep_id/linked_ocia_id are
--    SET NULL refs to couples/ocia. couples.spouseN_ocia_id → ocia (SET NULL).
--    Records reference sacramental_cohorts via cohort_id, so cohorts go LAST.
DELETE FROM annulment_cases;
DELETE FROM couples;
DELETE FROM sacramental_confirmation;
DELETE FROM sacramental_firstcomm;
DELETE FROM sacramental_baptism;
DELETE FROM sacramental_ocia;
DELETE FROM sacramental_cohorts;

-- 6. Notifications + activity log
DELETE FROM notifications;
DELETE FROM activity_log;

-- 7. Team memberships ONLY — the teams themselves are KEPT
DELETE FROM team_members;

-- 8. People last. (A) Null the kept reference so the delete cannot be blocked;
--    user_profiles ROWS remain (only personnel_id is cleared). personnel's
--    ON DELETE CASCADE clears any person_positions / HR rows — none exist yet.
UPDATE user_profiles SET personnel_id = NULL WHERE personnel_id IS NOT NULL;
DELETE FROM personnel;

-- ── VERIFICATION (reads inside the transaction, before ROLLBACK/COMMIT) ─────
-- WIPE + CASCADE should be 0. KEEP should match your pre-wipe counts (teams,
-- user_profiles, institutions, calendars, templates, TEAM discussions, etc.).
SELECT 'WIPE'    AS bucket, 'personnel'                AS tbl, count(*) AS rows FROM personnel
UNION ALL SELECT 'WIPE','team_members',                 count(*) FROM team_members
UNION ALL SELECT 'WIPE','couples',                      count(*) FROM couples
UNION ALL SELECT 'WIPE','annulment_cases',              count(*) FROM annulment_cases
UNION ALL SELECT 'WIPE','sacramental_baptism',          count(*) FROM sacramental_baptism
UNION ALL SELECT 'WIPE','sacramental_firstcomm',        count(*) FROM sacramental_firstcomm
UNION ALL SELECT 'WIPE','sacramental_confirmation',     count(*) FROM sacramental_confirmation
UNION ALL SELECT 'WIPE','sacramental_ocia',             count(*) FROM sacramental_ocia
UNION ALL SELECT 'WIPE','sacramental_cohorts',          count(*) FROM sacramental_cohorts
UNION ALL SELECT 'WIPE','projects',                     count(*) FROM projects
UNION ALL SELECT 'WIPE','tasks',                        count(*) FROM tasks
UNION ALL SELECT 'WIPE','project_log',                  count(*) FROM project_log
UNION ALL SELECT 'WIPE','project_log_comments',         count(*) FROM project_log_comments
UNION ALL SELECT 'WIPE','notifications',                count(*) FROM notifications
UNION ALL SELECT 'WIPE','activity_log',                 count(*) FROM activity_log
UNION ALL SELECT 'WIPE','announcements',                count(*) FROM announcements
UNION ALL SELECT 'WIPE','announcement_dismissals',      count(*) FROM announcement_dismissals
UNION ALL SELECT 'WIPE','discussions(project)',         count(*) FROM discussions WHERE context_type = 'project'
-- CASCADE side-effects of wiping personnel (expect 0 — no HR data yet)
UNION ALL SELECT 'CASCADE','person_positions',          count(*) FROM person_positions
UNION ALL SELECT 'CASCADE','performance_reviews',       count(*) FROM performance_reviews
UNION ALL SELECT 'CASCADE','disciplinary_records',      count(*) FROM disciplinary_records
UNION ALL SELECT 'CASCADE','incident_reports',          count(*) FROM incident_reports
UNION ALL SELECT 'CASCADE','memos',                     count(*) FROM memos
-- KEEP — must be UNCHANGED from your pre-wipe counts
UNION ALL SELECT 'KEEP','teams',                        count(*) FROM teams
UNION ALL SELECT 'KEEP','discussions(team)',            count(*) FROM discussions WHERE context_type = 'team'
UNION ALL SELECT 'KEEP','user_profiles',                count(*) FROM user_profiles
UNION ALL SELECT 'KEEP','user_roles',                   count(*) FROM user_roles
UNION ALL SELECT 'KEEP','sacramental_roles',            count(*) FROM sacramental_roles
UNION ALL SELECT 'KEEP','panel_grants',                 count(*) FROM panel_grants
UNION ALL SELECT 'KEEP','parish_settings',              count(*) FROM parish_settings
UNION ALL SELECT 'KEEP','institutions',                 count(*) FROM institutions
UNION ALL SELECT 'KEEP','calendars',                    count(*) FROM calendars
UNION ALL SELECT 'KEEP','review_templates',             count(*) FROM review_templates
UNION ALL SELECT 'KEEP','baptism_templates',            count(*) FROM baptism_templates
UNION ALL SELECT 'KEEP','marriage_templates',           count(*) FROM marriage_templates
UNION ALL SELECT 'KEEP','annulment_templates',          count(*) FROM annulment_templates
ORDER BY bucket, tbl;

-- ⚠️ DRY RUN. Nothing above is saved while this says ROLLBACK. After you have
-- verified the counts, change ROLLBACK to COMMIT and run again to apply.
ROLLBACK;
