-- ============================================================================
-- §20 — the model and effort of each AI job are fixed in the app, no longer
-- the owner's to set (AI settings → Models goes): every job runs on Sonnet at
-- high effort, a chat question needing heavy work on Opus at high, as the
-- router gives it; a doubtful certificate is read again on Opus.
--
--   • ai_turns.level: a question is now answered at chat-standard or
--     chat-deep. The levels of questions answered before (chat-simple,
--     chat-analysis, chat-files) stay on their turns, for Activity.
--   • The assistant's stored settings lose the Models' fields (chatMode,
--     actions, mtcReread): only the switch and the cap remain.
-- ============================================================================

ALTER TABLE ai_turns DROP CONSTRAINT ai_turns_level;
ALTER TABLE ai_turns
  ADD CONSTRAINT ai_turns_level CHECK (level IS NULL OR level IN ('chat-standard', 'chat-deep', 'chat-simple', 'chat-analysis', 'chat-files'));

UPDATE app_settings SET value = value - 'chatMode' - 'actions' - 'mtcReread' WHERE key = 'ai-assistant';
