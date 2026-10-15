-- ============================================================================
-- §20 — the AI's model and effort are set by what it is doing, not by who
-- asks: the owner's table of actions (AI settings → Models, stored with the
-- assistant's settings in app_settings) says which model and effort a simple
-- question, an analysis, a deep analysis, a question with files, a
-- certificate, a title, a report's template and a scheduled summary each run
-- on.
--
--   • ai_access.model and ai_access.effort go: a person keeps their switch,
--     their data, their cap and their permissions; no longer a model.
--   • ai_turns.level, ai_turns.level_reason — the level a question was
--     answered at (chat-simple, chat-analysis, chat-deep, chat-files), and in
--     a sentence why the router gave it that level (null when the level was
--     fixed or the question carried files). The model and effort it ran on
--     stay in ai_turns.model and ai_turns.effort, as before.
--   • mtc_readings.reread — the certificate came back too doubtful and was
--     read again on a stronger model; both calls' usage point at the reading.
-- ============================================================================

ALTER TABLE ai_access DROP COLUMN model, DROP COLUMN effort;

ALTER TABLE ai_turns
  ADD COLUMN level        text,
  ADD COLUMN level_reason text,
  ADD CONSTRAINT ai_turns_level CHECK (level IS NULL OR level IN ('chat-simple', 'chat-analysis', 'chat-deep', 'chat-files'));

ALTER TABLE mtc_readings ADD COLUMN reread boolean NOT NULL DEFAULT false;
