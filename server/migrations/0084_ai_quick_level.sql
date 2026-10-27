-- ============================================================================
-- §20 — the person picks how deep a question is answered, above the question
-- box: Quick (Haiku, low effort), Standard (the router's choice, as before)
-- or Deep (Opus). A question asked Quick is kept at the new level chat-quick.
-- ============================================================================

ALTER TABLE ai_turns DROP CONSTRAINT ai_turns_level;
ALTER TABLE ai_turns
  ADD CONSTRAINT ai_turns_level CHECK (level IS NULL OR level IN ('chat-quick', 'chat-standard', 'chat-deep', 'chat-simple', 'chat-analysis', 'chat-files'));
