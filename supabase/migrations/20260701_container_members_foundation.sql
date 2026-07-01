-- 20260701_container_members_foundation.sql
-- Phase 2a: unified, polymorphic container membership + roles.
-- ONE table backs BOTH projects (now) and teams (Phase 3). Roles cascade owner > admin > member.
--
-- Standing rule: new table ships RLS OFF + anon REVOKED — access is enforced client-side
-- (roles.js / membership.js), consistent with the app's known/intentional RLS-off posture.
-- Apply this file ONCE in the Supabase SQL editor BEFORE deploying the code that reads it.

-- ── Table ─────────────────────────────────────────────────────────────────────
create table if not exists public.container_members (
  id            uuid primary key default gen_random_uuid(),
  context_type  text not null,                    -- 'project' | 'team'  (teams join in Phase 3)
  context_id    uuid not null,                    -- projects.id (or teams.id later)
  personnel_id  uuid not null references public.personnel(id) on delete cascade,
  role          text not null default 'member',   -- 'owner' | 'admin' | 'member'
  created_at    timestamptz default now(),
  constraint container_members_role_chk check (role in ('owner','admin','member')),
  constraint container_members_ctx_chk  check (context_type in ('project','team')),
  unique (context_type, context_id, personnel_id) -- one membership row per person per container
);

create index if not exists container_members_ctx_idx
  on public.container_members (context_type, context_id);

-- ── Standing rule: RLS OFF + anon revoked (own statements, after CREATE) ──────
alter table public.container_members disable row level security;
revoke all on public.container_members from anon;

-- ── Data migration: backfill existing projects onto container_members ─────────
-- (1) Every personnel_id in projects.assigned_to → a 'member' row (handles N projects).
insert into public.container_members (context_type, context_id, personnel_id, role)
select 'project', p.id, m.personnel_id, 'member'
from public.projects p
cross join lateral unnest(coalesce(p.assigned_to, '{}')::uuid[]) as m(personnel_id)
where m.personnel_id is not null
on conflict (context_type, context_id, personnel_id) do nothing;

-- (2) The OWNER: projects.created_by is an AUTH uid — resolve it to a personnel_id via
--     user_profiles, then insert (or PROMOTE an existing member row) to role 'owner'.
--     If created_by doesn't resolve to a personnel row, the project simply gets no owner
--     row (report/re-run after linking). For the current single test project
--     "Campaign for the Sacred Heart", created_by resolves to Fr. Aaron M. Williams,
--     who is also in assigned_to → that row is promoted member→owner.
insert into public.container_members (context_type, context_id, personnel_id, role)
select 'project', p.id, up.personnel_id, 'owner'
from public.projects p
join public.user_profiles up on up.user_id = p.created_by
where up.personnel_id is not null
on conflict (context_type, context_id, personnel_id)
  do update set role = 'owner';
