-- 20260701_projects_archived.sql
-- Phase 2b-3: add an `archived` flag to projects, matching the couples / annulment_cases precedent
-- (both use `archived boolean default false`, filtered via `!archived`). Additive + defaulted, so
-- every existing project is not-archived — NO backfill needed. projects RLS is already on (client-
-- gated); no RLS change. Apply ONCE in the Supabase SQL editor BEFORE deploying the code.

alter table public.projects
  add column if not exists archived boolean default false;
