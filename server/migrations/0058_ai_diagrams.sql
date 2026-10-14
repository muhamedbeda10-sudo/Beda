-- ============================================================================
-- 0058 — diagrams the assistant draws in an answer (shared/aiDiagram.ts): a
-- process map, a swimlane, a tree, a fishbone or columns. The model says what
-- a diagram holds and the app lays it out; each one that passed the server's
-- checks is kept here, in the transaction that keeps the call and its result,
-- as it was checked: its layout, boxes, arrows and groups, the figures the
-- server wrote in from its queries, and those queries. The answer shows it as
-- a card in its place, from this row, as long as the conversation is kept.
--
-- A diagram is part of the answer's record: it is never changed or deleted
-- (to change one, the assistant draws it again).
-- ============================================================================

CREATE TABLE ai_diagrams (
  id              uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES ai_conversations (id),
  turn_id         uuid NOT NULL REFERENCES ai_turns (id),
  tool_use_id     text NOT NULL,
  user_id         uuid NOT NULL REFERENCES users (id),
  -- The diagram as checked (shared/aiDiagram.ts AiDiagramSpec): json, kept as written.
  spec            json NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, tool_use_id)
);
CREATE INDEX ai_diagrams_turn_idx ON ai_diagrams (conversation_id, turn_id);
CREATE INDEX ai_diagrams_user_idx ON ai_diagrams (user_id, created_at);
CREATE TRIGGER ai_diagrams_no_delete BEFORE DELETE ON ai_diagrams FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

CREATE FUNCTION ai_diagrams_keep() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ai_diagrams is append-only';
END $$;
CREATE TRIGGER ai_diagrams_keep BEFORE UPDATE ON ai_diagrams FOR EACH ROW EXECUTE FUNCTION ai_diagrams_keep();
