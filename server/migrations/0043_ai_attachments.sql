-- ============================================================================
-- 0043 — files a question to the AI assistant carries: photos (handwritten
-- sheets too) and PDFs, kept in the file store as they were sent, and
-- spreadsheets, read on the device into the text Claude reads.
--
-- A file is attached first (no conversation yet), counted in tokens on the
-- model of the person attaching it, then taken by the question it is sent
-- with: from then on it is part of that conversation's history, which is
-- replayed byte for byte, so it never changes and is never removed. The
-- question's stored message holds a reference to it; the bytes are read from
-- the store when the question is sent to Claude.
-- ============================================================================

CREATE TABLE ai_attachments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users (id),
  kind              text NOT NULL CHECK (kind IN ('image', 'pdf', 'sheet')),
  original_filename text NOT NULL CHECK (char_length(original_filename) BETWEEN 1 AND 255),
  mime_type         text NOT NULL,
  byte_size         integer NOT NULL CHECK (byte_size > 0),
  sha256            char(64) NOT NULL,
  -- A photo's or a PDF's bytes, in the file store; a spreadsheet has none.
  storage_key       text UNIQUE,
  driver            image_driver,
  -- A photo's size as sent, and its small preview.
  width             integer CHECK (width > 0),
  height            integer CHECK (height > 0),
  thumbnail_data_url text,
  -- A spreadsheet's text as Claude reads it, and its outline for the chip.
  content_text      text,
  summary           text,
  -- What Claude reads of it, counted when it was attached, on this model.
  input_tokens      integer NOT NULL CHECK (input_tokens > 0),
  token_model       text NOT NULL,
  -- The question that sent it, once sent; its place among that question's files.
  conversation_id   uuid REFERENCES ai_conversations (id),
  turn_id           uuid REFERENCES ai_turns (id),
  position          smallint CHECK (position BETWEEN 0 AND 19),
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Removed before it was sent (the person took it off the question).
  deleted_at        timestamptz,
  CONSTRAINT ai_attachments_bytes_or_text CHECK (
    (kind = 'sheet' AND content_text IS NOT NULL AND storage_key IS NULL AND driver IS NULL)
    OR (kind <> 'sheet' AND content_text IS NULL AND storage_key IS NOT NULL AND driver IS NOT NULL)
  ),
  CONSTRAINT ai_attachments_image_size CHECK ((kind = 'image') = (width IS NOT NULL AND height IS NOT NULL)),
  CONSTRAINT ai_attachments_sent_whole CHECK (
    (turn_id IS NULL AND conversation_id IS NULL AND position IS NULL)
    OR (turn_id IS NOT NULL AND conversation_id IS NOT NULL AND position IS NOT NULL)
  ),
  CONSTRAINT ai_attachments_sent_not_deleted CHECK (turn_id IS NULL OR deleted_at IS NULL)
);
-- A question's files in order; a conversation's, for its totals.
CREATE UNIQUE INDEX ai_attachments_turn_idx ON ai_attachments (turn_id, position) WHERE turn_id IS NOT NULL;
CREATE INDEX ai_attachments_conversation_idx ON ai_attachments (conversation_id) WHERE conversation_id IS NOT NULL;
-- A person's files not yet sent: how many they hold is bounded.
CREATE INDEX ai_attachments_pending_idx ON ai_attachments (user_id, created_at) WHERE turn_id IS NULL AND deleted_at IS NULL;
CREATE TRIGGER ai_attachments_no_delete BEFORE DELETE ON ai_attachments FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

-- A file sent with a question is part of the conversation's history: nothing of it changes again.
CREATE FUNCTION protect_ai_attachment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.turn_id IS NOT NULL AND (ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*)) THEN
    RAISE EXCEPTION 'A file sent to the AI assistant cannot be changed.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.turn_id IS NULL AND (
       NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.storage_key IS DISTINCT FROM OLD.storage_key OR NEW.sha256 IS DISTINCT FROM OLD.sha256
    OR NEW.content_text IS DISTINCT FROM OLD.content_text OR NEW.input_tokens IS DISTINCT FROM OLD.input_tokens
  ) THEN
    RAISE EXCEPTION 'A file attached to the AI assistant cannot be changed.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_attachments_append_only BEFORE UPDATE ON ai_attachments FOR EACH ROW EXECUTE FUNCTION protect_ai_attachment();
