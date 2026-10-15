-- ============================================================================
-- 0064 — reports the assistant builds (save_report), and what they ask for.
--
--   • inputs: what a run asks for besides the period (shared/aiReportInputs:
--     the orders, a week, the orders to leave out…), named {{name}} in the
--     sections' SQL and filled from each run's checked values.
--   • shared: open to everyone given the assistant, each running it over the
--     data they may read; only its maker renames, changes or deletes it.
--   • description: what it shows, for a report the assistant built.
--   • made_by: kept from an answer, built by the assistant, or one the app
--     starts with (`starter_key` names it, so it is made once).
--   • sections gain how they show their rows (a table, headline figures, a
--     tree) in their json; nothing to change here.
--
-- ai_report_changes: each report the assistant built or changed, by the
-- answer and the tool call that did it — the card in that answer, and the
-- record of who changed what.
-- ============================================================================

ALTER TABLE ai_reports
  ADD COLUMN inputs      json NOT NULL DEFAULT '[]',
  ADD COLUMN shared      boolean NOT NULL DEFAULT false,
  ADD COLUMN description text,
  ADD COLUMN made_by     text NOT NULL DEFAULT 'answer' CHECK (made_by IN ('answer', 'assistant', 'starter')),
  ADD COLUMN starter_key text,
  ADD CONSTRAINT ai_reports_inputs_array CHECK (json_typeof(inputs) = 'array'),
  ADD CONSTRAINT ai_reports_description_length CHECK (description IS NULL OR char_length(description) <= 2000);
CREATE UNIQUE INDEX ai_reports_starter_key ON ai_reports (starter_key) WHERE starter_key IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX ai_reports_shared_idx ON ai_reports (updated_at DESC, id DESC) WHERE shared AND deleted_at IS NULL;

-- What a run stamps (last_run_at) still leaves the list's order alone; a change of what it holds moves it.
DROP TRIGGER ai_reports_updated_at ON ai_reports;
CREATE TRIGGER ai_reports_updated_at BEFORE UPDATE ON ai_reports FOR EACH ROW
  WHEN (OLD.title IS DISTINCT FROM NEW.title
        OR OLD.period::text IS DISTINCT FROM NEW.period::text
        OR OLD.adjustable IS DISTINCT FROM NEW.adjustable
        OR OLD.sections::text IS DISTINCT FROM NEW.sections::text
        OR OLD.inputs::text IS DISTINCT FROM NEW.inputs::text
        OR OLD.shared IS DISTINCT FROM NEW.shared
        OR OLD.description IS DISTINCT FROM NEW.description
        OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION set_updated_at();

CREATE TABLE ai_report_changes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id       uuid NOT NULL REFERENCES ai_reports (id),
  conversation_id uuid NOT NULL REFERENCES ai_conversations (id),
  turn_id         uuid NOT NULL REFERENCES ai_turns (id),
  tool_use_id     text NOT NULL,
  user_id         uuid NOT NULL REFERENCES users (id),
  action          text NOT NULL CHECK (action IN ('create', 'update')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, tool_use_id)
);
CREATE INDEX ai_report_changes_turn_idx ON ai_report_changes (conversation_id, turn_id);
CREATE INDEX ai_report_changes_report_idx ON ai_report_changes (report_id, created_at);
CREATE FUNCTION ai_report_changes_keep() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ai_report_changes is append-only';
END $$;
CREATE TRIGGER ai_report_changes_keep BEFORE UPDATE OR DELETE ON ai_report_changes FOR EACH ROW EXECUTE FUNCTION ai_report_changes_keep();
