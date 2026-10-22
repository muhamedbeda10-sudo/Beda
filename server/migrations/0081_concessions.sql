-- Concessions are separate evidence, with the selected customer's item and
-- machine names kept as recorded, independent of later ERP/master changes.
CREATE TABLE concession_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 120),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX concession_categories_name_idx ON concession_categories (lower(btrim(name)));
INSERT INTO concession_categories (name) VALUES ('Material Change'), ('Dimension Concession'), ('Visual Concession');
CREATE TRIGGER concession_categories_no_delete BEFORE DELETE ON concession_categories
  FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

CREATE TABLE concessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL UNIQUE,
  request_hash text NOT NULL,
  date date NOT NULL,
  factories text[] NOT NULL CHECK (cardinality(factories) BETWEEN 1 AND 100 AND array_position(factories, NULL) IS NULL),
  customer text NOT NULL CHECK (btrim(customer) <> '' AND length(customer) <= 500),
  item_code text NOT NULL CHECK (length(item_code) <= 500),
  item text NOT NULL CHECK (btrim(item) <> '' AND length(item) <= 1000),
  description text NOT NULL CHECK (btrim(description) <> '' AND length(description) <= 4000),
  quantity text NOT NULL CHECK (btrim(quantity) <> '' AND length(quantity) <= 200),
  category_id uuid NOT NULL REFERENCES concession_categories (id),
  category_name text NOT NULL,
  concession_by text NOT NULL CHECK (btrim(concession_by) <> '' AND length(concession_by) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_id uuid NOT NULL REFERENCES users (id),
  created_by_name text NOT NULL,
  deleted_at timestamptz
);
CREATE INDEX concessions_date_idx ON concessions (date DESC, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX concessions_category_idx ON concessions (category_id) WHERE deleted_at IS NULL;
CREATE INDEX concessions_creator_idx ON concessions (created_by_id);
CREATE INDEX concessions_factories_idx ON concessions USING gin (factories) WHERE deleted_at IS NULL;
CREATE TRIGGER concessions_no_delete BEFORE DELETE ON concessions FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

CREATE TABLE concession_machines (
  concession_id uuid NOT NULL REFERENCES concessions (id),
  machine_id uuid NOT NULL REFERENCES machines (id),
  code text NOT NULL,
  display_name text NOT NULL,
  factory text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (concession_id, machine_id)
);
CREATE INDEX concession_machines_machine_idx ON concession_machines (machine_id);
CREATE TRIGGER concession_machines_no_delete BEFORE DELETE ON concession_machines FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

CREATE TABLE concession_images (
  concession_id uuid NOT NULL REFERENCES concessions (id),
  image_id uuid NOT NULL REFERENCES images (id),
  position integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (concession_id, image_id)
);
CREATE INDEX concession_images_image_idx ON concession_images (image_id);
CREATE TRIGGER concession_images_no_delete BEFORE DELETE ON concession_images FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

-- As with other new modules, administrators start with access; they grant
-- the screen and recording action under Users → Roles / person permissions.
INSERT INTO permissions (id) VALUES ('view-concessions'), ('record-concession');
INSERT INTO role_permissions (role, permission)
SELECT 'admin'::user_role, p FROM unnest(ARRAY['view-concessions', 'record-concession']) AS p;
