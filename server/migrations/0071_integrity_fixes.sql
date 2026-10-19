-- ============================================================================
-- Integrity fixes.
--
--   • One open inspection session per order line, held by the database as
--     well as by the API. A trigger, not a unique index: an installation may
--     already hold two open sessions on one line (written before the rule was
--     enforced everywhere), and a unique index could not be built over them.
--     Those stay as they are — each can still be recorded on and closed — and
--     no write may open another one next to an open session: neither a new
--     session, nor a reopened one, nor a restored one, nor one moved to
--     another line. The trigger serialises those writes per line with a
--     transaction-scoped advisory lock on the line's id, then looks for an
--     open session with a fresh snapshot, so two writers at once cannot both
--     find none. The API takes the line's row lock (FOR NO KEY UPDATE) before
--     it looks itself, so for it the advisory lock is never contended; the
--     trigger is what holds for any other writer.
--   • The refresh token a device just replaced stays good for a short grace
--     (auth.routes.ts): two tabs refreshing with the same cookie at once both
--     get an answer, and neither signs the other out.
--   • Each table that links a photo to a record is indexed by the photo: who
--     may read a photo is decided by what links to it.
--   • closed_at of a closed session is indexed: the dashboard's production
--     and ai.production_sessions read closed sessions by when they closed.
-- ============================================================================

-- ---- One open session per order line -----------------------------------------

CREATE FUNCTION inspection_sessions_one_open_per_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'Open' OR NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  -- An open session that stays open on its line (a version bump, a corrected
  -- quantity) is not opening anything: only a row that becomes open and live
  -- on a line is checked, so an older pair of open sessions stays workable.
  IF TG_OP = 'UPDATE' AND OLD.status = 'Open' AND OLD.deleted_at IS NULL AND OLD.order_id = NEW.order_id THEN
    RETURN NEW;
  END IF;
  -- The check below must see what was committed while it waited for the
  -- lock; a repeatable-read snapshot would not.
  IF current_setting('transaction_isolation') = 'repeatable read' THEN
    RAISE EXCEPTION 'Open inspection sessions in a read committed or serializable transaction.' USING ERRCODE = 'serialization_failure';
  END IF;
  PERFORM pg_advisory_xact_lock(710001, hashtext(NEW.order_id::text));
  IF EXISTS (
    SELECT 1 FROM inspection_sessions s
     WHERE s.order_id = NEW.order_id AND s.id <> NEW.id AND s.status = 'Open' AND s.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Another inspection session is already open on this order line.'
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'inspection_sessions_one_open_per_line',
            TABLE = 'inspection_sessions';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER inspection_sessions_one_open_per_line
  BEFORE INSERT OR UPDATE OF status, deleted_at, order_id ON inspection_sessions
  FOR EACH ROW EXECUTE FUNCTION inspection_sessions_one_open_per_line();

-- The trigger's look-up, and the API's: the open sessions of one line.
CREATE INDEX inspection_sessions_open_line_idx ON inspection_sessions (order_id) WHERE status = 'Open' AND deleted_at IS NULL;

-- ---- The refresh token just replaced ------------------------------------------

ALTER TABLE auth_sessions
  ADD COLUMN previous_token_hash text,
  ADD COLUMN rotated_at          timestamptz;
COMMENT ON COLUMN auth_sessions.previous_token_hash IS 'The refresh token this device held before its last rotation (hashed): answered for a short grace after rotated_at, never rotated again.';
COMMENT ON COLUMN auth_sessions.rotated_at IS 'When refresh_token_hash last replaced previous_token_hash.';
CREATE INDEX auth_sessions_previous_token_idx ON auth_sessions (previous_token_hash) WHERE previous_token_hash IS NOT NULL;

-- ---- What a photo belongs to ---------------------------------------------------
-- A photo is read by whoever may read what links to it (images.routes.ts):
-- each link table is looked up by the photo, on every photo shown.

CREATE INDEX item_reference_images_image_idx ON item_reference_images (image_id);
CREATE INDEX defect_images_image_idx ON defect_images (image_id);
CREATE INDEX paint_sample_images_image_idx ON paint_sample_images (image_id);
CREATE INDEX pt_record_images_image_idx ON pt_record_images (image_id);
CREATE INDEX session_note_images_image_idx ON session_note_images (image_id);
CREATE INDEX pdi_images_image_idx ON pdi_images (image_id);
CREATE INDEX notice_images_image_idx ON notice_images (image_id);
CREATE INDEX chat_message_images_image_idx ON chat_message_images (image_id);
CREATE INDEX task_message_images_image_idx ON task_message_images (image_id);

-- ---- Closed sessions by when they closed ---------------------------------------

CREATE INDEX inspection_sessions_closed_idx ON inspection_sessions (closed_at) WHERE deleted_at IS NULL AND status = 'Closed';
