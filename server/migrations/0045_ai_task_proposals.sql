-- ============================================================================
-- 0045 — tasks the AI assistant drafts. A draft is shown as a card in the
-- conversation: what is to be done, to whom, how urgent, by when, with Send
-- task and Discard. Nothing is sent until the person presses Send task; the
-- task then made is linked here. A later draft that revises one still
-- waiting replaces it (its card says so).
-- ============================================================================

CREATE TABLE ai_task_proposals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     uuid NOT NULL REFERENCES ai_conversations (id),
  turn_id             uuid NOT NULL REFERENCES ai_turns (id),
  tool_use_id         text NOT NULL,
  user_id             uuid NOT NULL REFERENCES users (id),
  -- The task as it will be sent (title, description, priority, dueAt, assignees with names); null when it did not pass.
  draft               json,
  ok                  boolean NOT NULL,
  error               text,
  status              text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'sent', 'discarded', 'superseded')),
  task_id             uuid REFERENCES tasks (id),
  revises_proposal_id uuid REFERENCES ai_task_proposals (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  decided_at          timestamptz,
  UNIQUE (conversation_id, tool_use_id),
  CONSTRAINT ai_task_proposals_draft_when_ok CHECK (ok = (draft IS NOT NULL)),
  CONSTRAINT ai_task_proposals_sent_task CHECK ((status = 'sent') = (task_id IS NOT NULL)),
  CONSTRAINT ai_task_proposals_failed_stay CHECK (ok OR status = 'proposed')
);
CREATE INDEX ai_task_proposals_turn_idx ON ai_task_proposals (conversation_id, turn_id);
CREATE TRIGGER ai_task_proposals_no_delete BEFORE DELETE ON ai_task_proposals FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();
