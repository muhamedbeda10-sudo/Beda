-- ============================================================================
-- 0058 — diagrams the assistant draws in an answer (shared/src/aiDiagram.ts):
-- a fishbone of a problem's causes, a 5 Whys chain, a flowchart of a process,
-- a mind map. The model writes each one with draw_diagram; the server checks
-- it and keeps it here, in the transaction that keeps the call and its
-- result, and the answer shows it as a card. A diagram holds what the model
-- concluded, not the factory's data, and reads no query: it is kept as it was
-- drawn and never changes.
-- ============================================================================

CREATE TABLE ai_diagrams (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES ai_conversations (id),
  turn_id         uuid NOT NULL REFERENCES ai_turns (id),
  tool_use_id     text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('fishbone', 'five-whys', 'flowchart', 'mind-map')),
  -- The diagram as checked (AiDiagram): its kind again, its title, its notes and its body.
  diagram         json NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, tool_use_id)
);
CREATE INDEX ai_diagrams_turn_idx ON ai_diagrams (conversation_id, turn_id);

CREATE FUNCTION ai_diagrams_kept() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ai_diagrams is kept as drawn';
END $$;
CREATE TRIGGER ai_diagrams_kept BEFORE UPDATE OR DELETE ON ai_diagrams FOR EACH ROW EXECUTE FUNCTION ai_diagrams_kept();
