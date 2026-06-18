-- Clear the dashboard "Recent Activity" feed.
-- activity_log is an ephemeral log written on most create/edit/delete actions,
-- so it repopulates with normal use — this empties it now, it is not an off
-- switch. Safe and non-structural; re-runnable anytime.
DELETE FROM activity_log;
