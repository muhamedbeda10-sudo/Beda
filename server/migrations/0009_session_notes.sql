-- ============================================================================
-- 0009 — Notes about the order, written on the Review step. A note is a
-- general remark (text and/or photos) about the order the session inspects,
-- not about one sample. It is kept on the session for traceability — who
-- wrote it, when, on which machine, while saving which sample — and shown
-- to every later session on the same order.
-- ============================================================================

CREATE TABLE session_notes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES inspection_sessions (id),
  order_id      uuid NOT NULL REFERENCES production_orders (id),
  -- The sample whose save carried the note, when it was written from the wizard.
  sample_id     uuid REFERENCES inspection_samples (id),
  text          text NOT NULL DEFAULT '',
  author_id     uuid NOT NULL REFERENCES users (id),
  author_name   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  version       integer NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  deleted_by_id uuid REFERENCES users (id),
  CONSTRAINT session_notes_text_length CHECK (char_length(text) <= 4000)
);
CREATE INDEX session_notes_session_idx ON session_notes (session_id) WHERE deleted_at IS NULL;
CREATE INDEX session_notes_order_idx ON session_notes (order_id) WHERE deleted_at IS NULL;
CREATE TRIGGER session_notes_updated_at BEFORE UPDATE ON session_notes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER session_notes_no_delete BEFORE DELETE ON session_notes FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

CREATE TABLE session_note_images (
  note_id  uuid NOT NULL REFERENCES session_notes (id),
  image_id uuid NOT NULL REFERENCES images (id),
  position integer NOT NULL,
  PRIMARY KEY (note_id, image_id)
);
CREATE TRIGGER session_note_images_no_delete BEFORE DELETE ON session_note_images FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();
