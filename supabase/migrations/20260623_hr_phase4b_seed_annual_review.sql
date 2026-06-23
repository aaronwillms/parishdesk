-- ═══════════════════════════════════════════════════════════════════════════
-- HR PHASE 4B — seed the "Annual Performance Review" personnel-evaluation template,
-- then REPOINT-THEN-DROP the old "Full-Time Staff: Annual Review" row:
--   1. insert the new template (stable, human-readable field ids),
--   2. move any position assignments from the old row to the new one,
--   3. delete the old row.
-- review_templates is RLS-protected (admin write), so this runs in the SQL editor
-- (service role bypasses RLS) rather than the client. Idempotent: re-running just
-- recreates the new row only if missing. Run once.
--
-- The Self-Evaluation template is seeded in CODE (the self-report flow's built-in
-- definition), so it is NOT a row here. Incident Report and Disciplinary Action are
-- fixed-column tables (no frozen_definition/answers) — NOT seeded; see the report.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_old uuid;
  v_new uuid;
BEGIN
  SELECT id INTO v_old FROM review_templates WHERE name = 'Full-Time Staff: Annual Review' LIMIT 1;

  SELECT id INTO v_new FROM review_templates WHERE name = 'Annual Performance Review' LIMIT 1;
  IF v_new IS NULL THEN
    INSERT INTO review_templates (name, definition) VALUES (
      'Annual Performance Review',
      $json$[
        {"id":"rated_section","type":"section","prompt":"Performance Ratings","help":"1 = lowest, 5 = highest"},
        {"id":"job_knowledge","type":"scale","min":1,"max":5,"prompt":"Job Knowledge","help":"Knowledge of policies and procedures; required job skills and procedures."},
        {"id":"quality_of_work","type":"scale","min":1,"max":5,"prompt":"Quality of Work","help":"Accuracy and quality of work in general."},
        {"id":"quantity_of_work","type":"scale","min":1,"max":5,"prompt":"Quantity of Work","help":"Productivity of the employee."},
        {"id":"reliability","type":"scale","min":1,"max":5,"prompt":"Reliability","help":"Extent the employee can be depended upon to be available and complete work properly and on time; reliable, trustworthy, persistent."},
        {"id":"initiative_creativity","type":"scale","min":1,"max":5,"prompt":"Initiative & Creativity","help":"Ability to plan work and proceed without being told every detail; ability to make constructive suggestions."},
        {"id":"judgment","type":"scale","min":1,"max":5,"prompt":"Judgment","help":"Extent decisions are sound; ability to base decisions on fact rather than emotion."},
        {"id":"cooperation","type":"scale","min":1,"max":5,"prompt":"Cooperation","help":"Willingness to work harmoniously with others; readiness to respond positively to instructions and procedures."},
        {"id":"interactions_others","type":"scale","min":1,"max":5,"prompt":"Interactions with Others","help":"Consistently treats co-workers, parishioners, and visitors with respect and kindness."},
        {"id":"safe_environment","type":"scale","min":1,"max":5,"prompt":"Safe Environment","help":"Maintains Safe-Environment Certification in accordance with Diocesan policy."},
        {"id":"accomplishments","type":"text","prompt":"Noteworthy accomplishments during this review period."},
        {"id":"areas_improvement","type":"text","prompt":"Areas requiring improvement in job performance."},
        {"id":"prior_actions","type":"text","prompt":"Actions taken to improve performance from the previous review."},
        {"id":"development_goals","type":"text","prompt":"Professional development goals."}
      ]$json$::jsonb
    ) RETURNING id INTO v_new;
  END IF;

  IF v_old IS NOT NULL AND v_old <> v_new THEN
    UPDATE review_template_positions SET template_id = v_new WHERE template_id = v_old;
    DELETE FROM review_templates WHERE id = v_old;
  END IF;
END $$;
