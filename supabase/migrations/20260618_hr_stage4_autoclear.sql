-- ═══════════════════════════════════════════════════════════════════════════
-- HR MODULE — STAGE 4: auto-clear ENFORCEMENT (the one trigger-bearing migration)
--
-- When a person is fully removed from the org tree (their LAST current
-- occupancy is unlinked), and the parish has hr_grant_autoclear on, their
-- record_grants are cleared automatically. A single-position unlink during a
-- transfer (other occupancies remain) must NOT clear anything.
--
-- Run once in the Supabase SQL editor. Reversible: DROP TRIGGER + DROP FUNCTION.
-- Does not run against any remote DB from here — review then apply.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── clear_grants_for_person ─────────────────────────────────────────────────
-- Deletes record_grants where the person is the GRANTEE, plus HR records ABOUT
-- the person (resolved record_id → person via person_position_id). Each
-- deletion writes an activity_log row (the SQL-side equivalent of logActivity()
-- — the history survives the row's deletion). SECURITY DEFINER so it can delete
-- grants and write the log regardless of the caller's RLS.
CREATE OR REPLACE FUNCTION clear_grants_for_person(p_person_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();   -- the admin performing the unlink (may be null)
  v_count integer := 0;
  r record;
BEGIN
  FOR r IN
    SELECT rg.id, rg.record_type, rg.record_id
    FROM record_grants rg
    WHERE
      -- (A) the person is the GRANTEE (map personnel → auth user via user_profiles)
      rg.granted_to IN (SELECT user_id FROM user_profiles WHERE personnel_id = p_person_id)
      -- (B) the granted record is an HR record ABOUT this person, resolved
      --     record_id → person_position_id → person_id.
      OR (rg.record_type = 'review'
          AND rg.record_id IN (SELECT id FROM performance_reviews
                               WHERE person_position_id IN (SELECT id FROM person_positions WHERE person_id = p_person_id)))
      OR (rg.record_type = 'disciplinary'
          AND rg.record_id IN (SELECT id FROM disciplinary_records
                               WHERE person_position_id IN (SELECT id FROM person_positions WHERE person_id = p_person_id)))
      OR (rg.record_type = 'incident'
          AND rg.record_id IN (SELECT id FROM incident_reports
                               WHERE person_position_id IN (SELECT id FROM person_positions WHERE person_id = p_person_id)))
      OR (rg.record_type = 'memo'
          AND rg.record_id IN (SELECT id FROM memos
                               WHERE person_position_id IN (SELECT id FROM person_positions WHERE person_id = p_person_id)))
      -- TODO(later stage): sacramental / youth_member / adult_volunteer "subject"
      -- resolution. Those record types are in the record_grants CHECK list but
      -- their record_id → subject-person mapping is not wired yet. When the
      -- sacramental/youth modules expose that mapping, add their cases here so a
      -- departing person's sacramental/youth grants also auto-clear. Until then
      -- this function only resolves the HR record types above (plus grantee).
  LOOP
    INSERT INTO activity_log (triggered_by, action, entity_type, entity_name, context_type)
    VALUES (v_actor, 'auto-cleared record grant', 'record_grant',
            r.record_type || ':' || r.record_id, 'hr');
    DELETE FROM record_grants WHERE id = r.id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- ── Trigger: fire on the transition INTO unlinked ───────────────────────────
CREATE OR REPLACE FUNCTION hr_autoclear_on_unlink()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_autoclear boolean;
  v_remaining integer;
BEGIN
  -- Only act when a row transitions from current → unlinked.
  IF NEW.unlinked_at IS NOT NULL AND OLD.unlinked_at IS NULL THEN
    -- Read the auto-clear setting for THIS row's parish; default on.
    SELECT hr_grant_autoclear INTO v_autoclear FROM parish_settings WHERE id = NEW.parish_id;
    IF COALESCE(v_autoclear, true) THEN
      -- Does the person retain ANY current occupancy (any institution)?
      SELECT count(*) INTO v_remaining
      FROM person_positions
      WHERE person_id = NEW.person_id AND unlinked_at IS NULL;
      -- Only a FULL removal (no occupancy remains) clears grants. A transfer
      -- (other occupancies still current) is a no-op.
      IF v_remaining = 0 THEN
        PERFORM clear_grants_for_person(NEW.person_id);
      END IF;
    END IF;
    -- If hr_grant_autoclear is off, this is a no-op here — manual revoke
    -- (a direct DELETE on record_grants) is unaffected.
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hr_autoclear_on_unlink ON person_positions;
CREATE TRIGGER trg_hr_autoclear_on_unlink
  AFTER UPDATE OF unlinked_at ON person_positions
  FOR EACH ROW
  EXECUTE FUNCTION hr_autoclear_on_unlink();
