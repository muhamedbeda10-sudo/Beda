-- ============================================================================
-- 0055 — a conversation's title the assistant gave it: a few words on what it
-- is about, written from the first question while the answer is written
-- (server/src/ai/conversationTitle.ts). It replaces only the first question
-- shortened ('question'); a title the person gave ('person') is never changed.
-- ============================================================================

ALTER TABLE ai_conversations DROP CONSTRAINT ai_conversations_title_source_check;
ALTER TABLE ai_conversations ADD CONSTRAINT ai_conversations_title_source_check CHECK (title_source IN ('question', 'assistant', 'person'));
