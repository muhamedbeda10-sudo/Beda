-- ============================================================================
-- 0032 — saved reports of the AI assistant (§20, phase 2).
--   • ai_reports — an answer kept as a report: its successful queries, in
--     order, each a section. Reopening one runs the sections' SQL again
--     through the sandboxed reader; no model is called. When the period could
--     be made adjustable, each section's SQL is a template carrying {{from}}
--     and {{to}}, which the API alone fills with DATE 'YYYY-MM-DD' literals
--     built from validated days.
--   • Reports are personal: only their creator lists, runs, renames or
--     deletes them. Like the assistant's other records they live in public and
--     are never granted to the reader role.
--   • ai.audit_log leaves the reports' own audit entries out, as it does the
--     key's: they are the assistant's bookkeeping, not the factory's record,
--     and one administrator's report titles are not another's to read.
-- ============================================================================

CREATE TABLE ai_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id),
  -- The answer it was saved from.
  conversation_id uuid REFERENCES ai_conversations (id),
  turn_id         uuid REFERENCES ai_turns (id),
  title           text NOT NULL,
  -- The question as it was asked.
  question        text NOT NULL,
  -- The period as asked (AiReportPeriod), or null: no section has one, or it could not be made adjustable.
  period          json,
  -- Whether the sections are templates whose period can be changed when the report runs.
  adjustable      boolean NOT NULL,
  -- [{ title, sql }]: sql is the template when adjustable, else the query as it ran.
  sections        json NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_run_at     timestamptz,
  deleted_at      timestamptz,
  CONSTRAINT ai_reports_title_length CHECK (char_length(title) BETWEEN 1 AND 120),
  CONSTRAINT ai_reports_sections_array CHECK (json_typeof(sections) = 'array' AND json_array_length(sections) >= 1),
  -- An adjustable report always knows the period it was asked for.
  CONSTRAINT ai_reports_adjustable_period CHECK (NOT adjustable OR (period IS NOT NULL AND json_typeof(period) = 'object'))
);
CREATE INDEX ai_reports_user_idx ON ai_reports (user_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
-- An answer is saved once; saved again only after its report was deleted.
CREATE UNIQUE INDEX ai_reports_one_per_turn ON ai_reports (user_id, turn_id) WHERE deleted_at IS NULL AND turn_id IS NOT NULL;
CREATE INDEX ai_reports_conversation_idx ON ai_reports (conversation_id) WHERE deleted_at IS NULL;

-- Running a report stamps last_run_at only: the list's order (by updated_at)
-- moves for a rename or a removal, not for every run. json has no equality, so
-- its columns are compared as text.
CREATE TRIGGER ai_reports_updated_at BEFORE UPDATE ON ai_reports FOR EACH ROW
  WHEN (OLD.title IS DISTINCT FROM NEW.title
        OR OLD.period::text IS DISTINCT FROM NEW.period::text
        OR OLD.adjustable IS DISTINCT FROM NEW.adjustable
        OR OLD.sections::text IS DISTINCT FROM NEW.sections::text
        OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER ai_reports_no_delete BEFORE DELETE ON ai_reports FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

-- ---- The audit trail the assistant reads ------------------------------------------

-- As in 0031, with the reports' entries left out too. Same columns, so the
-- reader's grant and every comment stay as they are.
CREATE OR REPLACE VIEW ai.audit_log AS
SELECT a.id                                   AS audit_id,
       a.at,
       (a.at AT TIME ZONE current_setting('TimeZone'))::date AS day,
       a.user_id,
       a.user_name,
       a.action::text                         AS action,
       a.entity,
       a.entity_id,
       a.field,
       a.old_value,
       a.new_value,
       a.order_number,
       a.item,
       a.work_center_code                     AS machine_code,
       CASE WHEN a.work_center_code IS NULL THEN NULL
            ELSE COALESCE(NULLIF(btrim(m.display_name), ''), 'Machine ' || a.work_center_code) END AS machine,
       a.session_id,
       a.sample_id
  FROM audit_log a
  LEFT JOIN machines m ON lower(m.code) = lower(a.work_center_code) AND m.deleted_at IS NULL
 WHERE a.deleted_at IS NULL
   AND a.entity NOT IN ('AiAssistant', 'AiReport', 'Notice', 'ChatGroup');
