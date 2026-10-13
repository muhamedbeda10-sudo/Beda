-- ============================================================================
-- 0052 — keeping one's conversations with the assistant in order: pinned to
-- the top, renamed, put in a group, archived out of the way, and found again
-- by what was asked or answered in them. All of it is the person's own: a
-- group, like a conversation, is seen only by whoever made it.
--
--   • ai_conversation_groups: a person's groups, by name. A conversation is in
--     one group at most; a group removed is only marked so, and its
--     conversations go back to the list (the API clears their group in the
--     same transaction).
--   • ai_conversations: when it was pinned (pinned ones are listed first, the
--     latest pinned on top), its group, when it was archived (out of the list
--     until it is unarchived or asked in again), and whether its title is still
--     the first question or one the person gave it.
--   • ai_turns.answer_text: the words of an answer, without the blocks it
--     carries for the app, set when the turn closes, so a search reads the
--     answers without opening the transcript. Answers before this are filled
--     in below.
-- ============================================================================

CREATE TABLE ai_conversation_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60 AND name = btrim(name)),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  -- What a conversation's group is checked against: the group must be its owner's.
  UNIQUE (id, user_id)
);
CREATE UNIQUE INDEX ai_conversation_groups_name_live ON ai_conversation_groups (user_id, lower(name)) WHERE deleted_at IS NULL;
CREATE TRIGGER ai_conversation_groups_updated_at BEFORE UPDATE ON ai_conversation_groups FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER ai_conversation_groups_no_delete BEFORE DELETE ON ai_conversation_groups FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

ALTER TABLE ai_conversations
  ADD COLUMN pinned_at    timestamptz,
  ADD COLUMN group_id     uuid,
  ADD COLUMN archived_at  timestamptz,
  ADD COLUMN title_source text NOT NULL DEFAULT 'question' CHECK (title_source IN ('question', 'person')),
  -- A conversation's group is one of its owner's groups, never someone else's.
  ADD CONSTRAINT ai_conversations_group_fk FOREIGN KEY (group_id, user_id) REFERENCES ai_conversation_groups (id, user_id),
  -- An archived conversation is out of the list, pinned section included.
  ADD CONSTRAINT ai_conversations_archived_unpinned CHECK (archived_at IS NULL OR pinned_at IS NULL);

-- The list is the conversations neither archived nor removed; pinned and grouped ones are read on their own.
DROP INDEX ai_conversations_user_idx;
CREATE INDEX ai_conversations_user_idx ON ai_conversations (user_id, last_message_at DESC, id DESC) WHERE deleted_at IS NULL AND archived_at IS NULL;
CREATE INDEX ai_conversations_archived_idx ON ai_conversations (user_id, last_message_at DESC, id DESC) WHERE deleted_at IS NULL AND archived_at IS NOT NULL;
CREATE INDEX ai_conversations_pinned_idx ON ai_conversations (user_id, pinned_at DESC) WHERE deleted_at IS NULL AND pinned_at IS NOT NULL;
CREATE INDEX ai_conversations_group_idx ON ai_conversations (group_id, last_message_at DESC, id DESC) WHERE deleted_at IS NULL AND group_id IS NOT NULL;

ALTER TABLE ai_turns ADD COLUMN answer_text text;

-- An answer's words: the text blocks of its assistant messages in order, the
-- <kpis> and <suggestions> blocks taken out, on one line. Used when a turn
-- closes and for the answers already there.
CREATE FUNCTION ai_turn_answer_text(turn uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT NULLIF(btrim(regexp_replace(
           -- One pattern per block: a back reference would make the whole pattern greedy.
           regexp_replace(regexp_replace(string_agg(b.value ->> 'text', ' ' ORDER BY m.seq, b.ordinality),
             '<kpis(\s[^>]*?)??>.*?</kpis\s*?>', ' ', 'gi'),
             '<suggestions(\s[^>]*?)??>.*?</suggestions\s*?>', ' ', 'gi'),
           '\s+', ' ', 'g')), '')
    FROM ai_messages m
    CROSS JOIN LATERAL json_array_elements(m.content) WITH ORDINALITY AS b(value, ordinality)
   WHERE m.turn_id = turn AND m.kind = 'assistant' AND b.value ->> 'type' = 'text'
$$;

UPDATE ai_turns SET answer_text = ai_turn_answer_text(id) WHERE status = 'done';

-- Text as a search compares it: lower case, an Arabic letter written several
-- ways read as one (أ إ آ ٱ as ا, ى as ي, ة as ه), the short vowels and the
-- tatweel left out. The API folds the words searched for the same way
-- (server/src/ai/conversationSearch.ts).
CREATE FUNCTION ai_search_fold(t text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT translate(lower(regexp_replace(t, '[ً-ْٰـ]', '', 'g')), 'أإآٱىة', 'اااايه')
$$;
