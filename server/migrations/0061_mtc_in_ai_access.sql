-- ============================================================================
-- MTC — who may upload certificates is the AI assistant's owner's to say, with
-- the rest of each person's AI settings; and every reading is logged with what
-- it cost, for the owner's Activity.
--
--   • ai_access.mtc — the owner allows a person to upload mill test
--     certificates (MTC tab). It stands on its own: a person may have it with
--     the assistant switched off for them, and so never see the chat. The
--     owner always may. A reading counts toward the person's monthly cap and
--     the assistant's, like any call.
--   • users.mtc_upload goes: whoever had it keeps the permission, now in
--     ai_access (a row with the assistant off is made for anyone without one).
--   • mtc_readings — one row per certificate read: who, which file, which
--     register it turned out to belong to, how many items, how it ended. Its
--     cost is the ai_usage row that points at it (ai_usage.mtc_reading_id), so
--     the month's spend, the caps and the usage page count it with the rest.
-- ============================================================================

ALTER TABLE ai_access ADD COLUMN mtc boolean NOT NULL DEFAULT false;

UPDATE ai_access a SET mtc = true FROM users u WHERE u.id = a.user_id AND u.mtc_upload;
INSERT INTO ai_access (user_id, enabled, domains, model, effort, monthly_cap_usd, updated_by_name, mtc)
SELECT u.id, false, ARRAY['inspection'], 'claude-sonnet-5-5', 'medium', 10, 'MTC permission moved to the AI settings', true
  FROM users u
 WHERE u.mtc_upload AND u.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM ai_access a WHERE a.user_id = u.id);

ALTER TABLE users DROP COLUMN mtc_upload;

CREATE TABLE mtc_readings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id),
  file_name   text NOT NULL,
  -- The register the certificate belongs to; null when it fit none, or the reading failed.
  kind        text,
  -- Items listed; null when the reading failed.
  items       integer,
  outcome     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mtc_readings_kind CHECK (kind IS NULL OR kind IN ('coils', 'welding-wire', 'mesh-wire')),
  CONSTRAINT mtc_readings_outcome CHECK (outcome IN ('read', 'not-certificate', 'failed', 'stopped')),
  CONSTRAINT mtc_readings_items CHECK (items IS NULL OR items >= 0)
);
CREATE INDEX mtc_readings_created_idx ON mtc_readings (created_at DESC);
CREATE TRIGGER mtc_readings_no_delete BEFORE DELETE ON mtc_readings FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

ALTER TABLE ai_usage ADD COLUMN mtc_reading_id uuid REFERENCES mtc_readings (id);
CREATE INDEX ai_usage_mtc_reading_idx ON ai_usage (mtc_reading_id) WHERE mtc_reading_id IS NOT NULL;
