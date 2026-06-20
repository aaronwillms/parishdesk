-- ═══════════════════════════════════════════════════════════════════════════
-- Fix: a "%"-grant recipient could not OPEN the file they were granted.
--
-- ROOT CAUSE: the grant WRITE is correct (record_grants.granted_to = the selected
-- recipient, granted_by = the granter — two distinct fields). But the SELECT RLS
-- policy on record_grants was super-admin ONLY:
--     record_grants_select  USING (is_super_admin(auth.uid()))
-- so a non-super-admin GRANTEE cannot read their own grant row. The client access
-- gate (loadMyGrants → hasMyGrantForLink → canAccessLink) reads record_grants
-- directly, gets zero rows under RLS, and denies access — the panel never opens.
-- (The audit view works because it runs as the super-admin.)
--
-- FIX: also allow a user to SELECT grant rows where THEY are the grantee
-- (granted_to = auth.uid()), in addition to super-admins. The WRITE policy is
-- unchanged — only super-admins create/revoke grants. No column/schema change.
--
-- PROPOSED — pause for approval before applying. Idempotent (drop-then-create).
-- ═══════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS record_grants_select ON record_grants;
CREATE POLICY record_grants_select ON record_grants FOR SELECT TO authenticated
  USING (is_super_admin(auth.uid()) OR granted_to = auth.uid());
