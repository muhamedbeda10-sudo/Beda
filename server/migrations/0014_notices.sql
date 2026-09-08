-- ============================================================================
-- 0014 — Targeted notices (§16).
--   • notices — what an administrator wants the floor to read: a title, a
--     body, how serious it is, whether it must be acknowledged, and the days
--     it is shown. Withdrawn early by an administrator; never hard-deleted.
--   • notice_targets — who or what it is aimed at. Values of one kind are
--     alternatives; kinds combine. No rows: everyone, everywhere.
--   • notice_images / notice_files — photos through the image pipeline,
--     documents (PDF, Excel) in the document store.
--   • notice_acknowledgements — one row per reader: when they saw it and,
--     when required, when they acknowledged it, with where they were.
-- ============================================================================

CREATE TABLE notices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title             text NOT NULL,
  body              text NOT NULL DEFAULT '',
  severity          text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  requires_ack      boolean NOT NULL DEFAULT true,
  valid_from        date NOT NULL,
  valid_to          date,
  created_by_id     uuid REFERENCES users (id),
  created_by_name   text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  withdrawn_at      timestamptz,
  withdrawn_by_id   uuid REFERENCES users (id),
  withdrawn_by_name text,
  deleted_at        timestamptz,
  deleted_by_id     uuid REFERENCES users (id),
  CONSTRAINT notices_title_not_blank CHECK (btrim(title) <> ''),
  CONSTRAINT notices_valid_range CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE INDEX notices_active_idx ON notices (valid_from, valid_to) WHERE deleted_at IS NULL AND withdrawn_at IS NULL;
CREATE TRIGGER notices_updated_at BEFORE UPDATE ON notices FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER notices_no_delete BEFORE DELETE ON notices FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

CREATE TABLE notice_targets (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notice_id uuid NOT NULL REFERENCES notices (id),
  kind      text NOT NULL CHECK (kind IN ('factory', 'machine', 'process', 'order-number', 'order-line', 'item-code', 'customer', 'shift', 'user', 'role')),
  value     text NOT NULL,
  label     text NOT NULL DEFAULT '',
  CONSTRAINT notice_targets_value_not_blank CHECK (btrim(value) <> '')
);
CREATE INDEX notice_targets_notice_idx ON notice_targets (notice_id);

CREATE TABLE notice_images (
  notice_id uuid NOT NULL REFERENCES notices (id),
  image_id  uuid NOT NULL REFERENCES images (id),
  position  integer NOT NULL,
  PRIMARY KEY (notice_id, image_id)
);

CREATE TABLE notice_files (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notice_id         uuid REFERENCES notices (id),
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
CREATE INDEX notice_files_notice_idx ON notice_files (notice_id) WHERE deleted_at IS NULL;
CREATE TRIGGER notice_files_no_delete BEFORE DELETE ON notice_files FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

CREATE TABLE notice_acknowledgements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notice_id       uuid NOT NULL REFERENCES notices (id),
  user_id         uuid NOT NULL REFERENCES users (id),
  user_name       text NOT NULL,
  seen_at         timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  context         jsonb,
  UNIQUE (notice_id, user_id)
);
CREATE INDEX notice_acknowledgements_user_idx ON notice_acknowledgements (user_id);
CREATE TRIGGER notice_acknowledgements_no_delete BEFORE DELETE ON notice_acknowledgements FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();
