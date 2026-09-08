-- ============================================================================
-- 0015 — Chat (§17).
--   • chat_conversations — the general channel (one row, everyone), a direct
--     conversation between two people (private: no administrator bypass),
--     or a group an administrator made.
--   • chat_members — who is in a conversation and how far they have read.
--     The general channel has no rows: every active account is in it, and a
--     row is written the first time someone reads it.
--   • chat_messages — kept forever. Deleting for everyone blanks the body
--     and keeps the row; deleting for me hides it for one reader.
--   • chat_message_images / chat_files — photos through the image pipeline,
--     documents in the document store.
--   • chat_reactions — one emoji per person per message.
--   • chat_mentions — who and what a message points at, for counting and
--     for the chips on screen.
-- ============================================================================

CREATE TABLE chat_conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('general', 'direct', 'group')),
  name            text NOT NULL DEFAULT '',
  -- For a direct conversation: the two user ids sorted and joined, so there is only ever one.
  direct_key      text,
  created_by_id   uuid REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz,
  deleted_at      timestamptz,
  deleted_by_id   uuid REFERENCES users (id),
  CONSTRAINT chat_conversations_group_named CHECK (kind <> 'group' OR btrim(name) <> '')
);
CREATE UNIQUE INDEX chat_conversations_general_key ON chat_conversations ((kind)) WHERE kind = 'general';
CREATE UNIQUE INDEX chat_conversations_direct_key ON chat_conversations (direct_key) WHERE direct_key IS NOT NULL;
CREATE INDEX chat_conversations_activity_idx ON chat_conversations (last_message_at DESC NULLS LAST) WHERE deleted_at IS NULL;
CREATE TRIGGER chat_conversations_updated_at BEFORE UPDATE ON chat_conversations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER chat_conversations_no_delete BEFORE DELETE ON chat_conversations FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

INSERT INTO chat_conversations (kind, name) VALUES ('general', 'General');

CREATE TABLE chat_members (
  conversation_id uuid NOT NULL REFERENCES chat_conversations (id),
  user_id         uuid NOT NULL REFERENCES users (id),
  joined_at       timestamptz NOT NULL DEFAULT now(),
  last_read_at    timestamptz,
  removed_at      timestamptz,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX chat_members_user_idx ON chat_members (user_id) WHERE removed_at IS NULL;

CREATE TABLE chat_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES chat_conversations (id),
  sender_id       uuid NOT NULL REFERENCES users (id),
  sender_name     text NOT NULL,
  client_id       uuid NOT NULL,
  body            text NOT NULL DEFAULT '',
  reply_to_id     uuid REFERENCES chat_messages (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  edited_at       timestamptz,
  deleted_at      timestamptz,
  deleted_by_id   uuid REFERENCES users (id),
  UNIQUE (sender_id, client_id)
);
CREATE INDEX chat_messages_conversation_idx ON chat_messages (conversation_id, created_at DESC, id DESC);
CREATE TRIGGER chat_messages_no_delete BEFORE DELETE ON chat_messages FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

CREATE TABLE chat_hidden_messages (
  message_id uuid NOT NULL REFERENCES chat_messages (id),
  user_id    uuid NOT NULL REFERENCES users (id),
  hidden_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE chat_message_images (
  message_id uuid NOT NULL REFERENCES chat_messages (id),
  image_id   uuid NOT NULL REFERENCES images (id),
  position   integer NOT NULL,
  PRIMARY KEY (message_id, image_id)
);

CREATE TABLE chat_files (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id        uuid REFERENCES chat_messages (id),
  storage_key       text NOT NULL UNIQUE,
  driver            image_driver NOT NULL,
  original_filename text NOT NULL,
  mime_type         text NOT NULL,
  byte_size         integer NOT NULL CHECK (byte_size > 0),
  sha256            char(64) NOT NULL,
  uploaded_by_id    uuid REFERENCES users (id),
  uploaded_by_name  text NOT NULL,
  uploaded_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
CREATE INDEX chat_files_message_idx ON chat_files (message_id) WHERE deleted_at IS NULL;
CREATE TRIGGER chat_files_no_delete BEFORE DELETE ON chat_files FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

CREATE TABLE chat_reactions (
  message_id uuid NOT NULL REFERENCES chat_messages (id),
  user_id    uuid NOT NULL REFERENCES users (id),
  user_name  text NOT NULL,
  emoji      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji),
  CONSTRAINT chat_reactions_emoji_short CHECK (char_length(emoji) BETWEEN 1 AND 16)
);

CREATE TABLE chat_mentions (
  message_id uuid NOT NULL REFERENCES chat_messages (id),
  kind       text NOT NULL CHECK (kind IN ('user', 'order', 'item', 'machine', 'session')),
  value      text NOT NULL,
  label      text NOT NULL DEFAULT '',
  PRIMARY KEY (message_id, kind, value)
);
CREATE INDEX chat_mentions_user_idx ON chat_mentions (value) WHERE kind = 'user';
