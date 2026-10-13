-- ============================================================================
-- 0051 — the assistant's answers outlive the request that asked for them.
-- Closing the page no longer stops an answer: it goes on on the server, and
-- the bell says when it is ready. Only Stop ends it early. A server that
-- restarts, or stops, hands the answer on, and it continues from its last
-- step rather than starting over.
--
--   • ai_turns: which instance is writing the answer (runner) and when it
--     last said so (heartbeat_at, every few seconds). An answer whose
--     heartbeat has stopped was lost with its instance: another takes it
--     over and continues it. stop_requested_at is Stop, seen by whichever
--     instance writes it. calls, pauses and elapsed_ms are the limits an
--     answer keeps across a hand-over (the model calls it made, the times
--     the model paused, the time it has run); resumes counts the hand-overs,
--     so an answer that keeps failing its instance is ended. progress is a
--     line on what it does now, for whoever reopens the conversation;
--     watched_at is when someone last had it on screen.
--   • ai_messages.pending: an answer's step stored before its tools run, so
--     a step cut short is finished, its tools run once each, rather than
--     asked of the model again. The step joins the replay with its results.
--   • user_notifications: the kind 'ai-answer', at most one per answer.
-- ============================================================================

ALTER TABLE ai_turns
  ADD COLUMN runner            text,
  ADD COLUMN heartbeat_at      timestamptz,
  ADD COLUMN stop_requested_at timestamptz,
  ADD COLUMN calls             integer NOT NULL DEFAULT 0 CHECK (calls >= 0),
  ADD COLUMN pauses            integer NOT NULL DEFAULT 0 CHECK (pauses >= 0),
  ADD COLUMN elapsed_ms        integer NOT NULL DEFAULT 0 CHECK (elapsed_ms >= 0),
  ADD COLUMN resumes           integer NOT NULL DEFAULT 0 CHECK (resumes >= 0),
  ADD COLUMN progress          text CHECK (progress IS NULL OR length(progress) <= 300),
  ADD COLUMN watched_at        timestamptz;

-- The answers being written, by when they last said so: what the instances look through for one to take over.
CREATE INDEX ai_turns_running_idx ON ai_turns (heartbeat_at NULLS FIRST) WHERE status = 'running';

ALTER TABLE ai_messages
  ADD COLUMN pending boolean NOT NULL DEFAULT false,
  -- Only an answer's step waits for its results, and it is out of the replay until they come.
  ADD CONSTRAINT ai_messages_pending_step CHECK (NOT pending OR (kind = 'assistant' AND NOT in_replay));
CREATE INDEX ai_messages_pending_idx ON ai_messages (turn_id) WHERE pending;

ALTER TABLE user_notifications ADD COLUMN ai_turn_id uuid REFERENCES ai_turns (id);
ALTER TABLE user_notifications DROP CONSTRAINT user_notifications_kind;
ALTER TABLE user_notifications ADD CONSTRAINT user_notifications_kind CHECK (kind IN (
  'automation-case', 'automation-digest', 'automation-report', 'automation-stopped',
  'follow-up-assigned', 'follow-up-overdue', 'follow-up-updated',
  'task-assigned', 'task-updated', 'task-done', 'task-reopened',
  'ai-answer'));
-- One bell row per answer, however many instances finish it.
CREATE UNIQUE INDEX user_notifications_ai_answer_once ON user_notifications (ai_turn_id) WHERE kind = 'ai-answer';
ALTER TABLE user_notifications ADD CONSTRAINT user_notifications_ai_answer_turn CHECK ((kind = 'ai-answer') = (ai_turn_id IS NOT NULL));
