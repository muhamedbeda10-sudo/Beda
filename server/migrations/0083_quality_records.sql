-- NCR and customer complaint forms, with audited follow-up edits. The JSON
-- contains the fields of each supplied form, validated by the API. Master
-- names and document control are snapshots; updates never rewrite them.
CREATE TABLE quality_record_counters (
  kind text NOT NULL CHECK (kind IN ('ncr', 'customer-complaint')),
  year integer NOT NULL CHECK (year BETWEEN 1 AND 9999),
  last_number bigint NOT NULL CHECK (last_number > 0),
  PRIMARY KEY (kind, year)
);
CREATE TABLE quality_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('ncr', 'customer-complaint')),
  reference text NOT NULL CHECK (btrim(reference) <> '' AND length(reference) <= 120),
  date date NOT NULL,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object' AND data ? 'kind' AND data->>'kind' = kind),
  form jsonb NOT NULL CHECK (jsonb_typeof(form) = 'object'),
  submission_id uuid NOT NULL UNIQUE,
  request_hash text NOT NULL,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_id uuid NOT NULL REFERENCES users (id),
  created_by_name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_id uuid NOT NULL REFERENCES users (id),
  updated_by_name text NOT NULL,
  deleted_at timestamptz
);
CREATE UNIQUE INDEX quality_records_reference_idx ON quality_records (kind, lower(btrim(reference)));
CREATE INDEX quality_records_date_idx ON quality_records (kind, date DESC, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX quality_records_data_idx ON quality_records USING gin (data jsonb_path_ops) WHERE deleted_at IS NULL;
CREATE INDEX quality_records_created_by_idx ON quality_records (created_by_id);
CREATE INDEX quality_records_updated_by_idx ON quality_records (updated_by_id);
CREATE TRIGGER quality_records_no_delete BEFORE DELETE ON quality_records FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

CREATE TABLE quality_record_images (
  record_id uuid NOT NULL REFERENCES quality_records (id),
  image_id uuid NOT NULL REFERENCES images (id),
  position integer NOT NULL CHECK (position >= 0),
  removed_at timestamptz,
  PRIMARY KEY (record_id, image_id)
);
CREATE INDEX quality_record_images_image_idx ON quality_record_images (image_id) WHERE removed_at IS NULL;
CREATE TRIGGER quality_record_images_no_delete BEFORE DELETE ON quality_record_images FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

INSERT INTO permissions (id) VALUES ('view-ncr'), ('record-ncr'), ('view-customer-complaints'), ('record-customer-complaint');
INSERT INTO role_permissions (role, permission)
SELECT 'admin'::user_role, p FROM unnest(ARRAY['view-ncr', 'record-ncr', 'view-customer-complaints', 'record-customer-complaint']) AS p;
