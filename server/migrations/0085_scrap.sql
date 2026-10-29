-- ============================================================================
-- Scrap: the weight of scrap a machine made, with a photo of its scrap card
-- and of its scrap box (both required). Recorded from Inspections, read in
-- History under Scrap. Factory, machine, type and inspector names are kept as
-- recorded, so later master-data changes never rewrite a record. Corrections
-- and deletions are audited; a deletion is soft.
-- ============================================================================

CREATE TABLE scrap_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 120),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX scrap_types_name_idx ON scrap_types (lower(btrim(name)));
INSERT INTO scrap_types (name) VALUES ('Coarse scrap'), ('Soft scrap');
CREATE TRIGGER scrap_types_no_delete BEFORE DELETE ON scrap_types FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

CREATE TABLE scrap_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL UNIQUE,
  request_hash text NOT NULL,
  date date NOT NULL,
  factory text NOT NULL CHECK (btrim(factory) <> '' AND length(factory) <= 120),
  machine_id uuid NOT NULL REFERENCES machines (id),
  machine_code text NOT NULL,
  machine_name text NOT NULL,
  scrap_type_id uuid NOT NULL REFERENCES scrap_types (id),
  scrap_type_name text NOT NULL,
  weight_kg numeric(12, 3) NOT NULL CHECK (weight_kg > 0 AND weight_kg <= 1000000),
  responsible_person text NOT NULL DEFAULT '' CHECK (length(responsible_person) <= 200),
  inspector_id uuid NOT NULL REFERENCES users (id),
  inspector_name text NOT NULL,
  card_image_id uuid NOT NULL REFERENCES images (id),
  box_image_id uuid NOT NULL REFERENCES images (id),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_id uuid NOT NULL REFERENCES users (id),
  created_by_name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_id uuid NOT NULL REFERENCES users (id),
  updated_by_name text NOT NULL,
  deleted_at timestamptz,
  deleted_by_id uuid REFERENCES users (id),
  CONSTRAINT scrap_records_two_photos CHECK (card_image_id <> box_image_id)
);
CREATE INDEX scrap_records_date_idx ON scrap_records (date DESC, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX scrap_records_created_idx ON scrap_records (created_at) WHERE deleted_at IS NULL;
CREATE INDEX scrap_records_machine_idx ON scrap_records (machine_id) WHERE deleted_at IS NULL;
-- The assistant filters a machine by its key (CLAUDE.md, rule 2).
CREATE INDEX scrap_records_machine_key_idx ON scrap_records (ai.machine_key(machine_code)) WHERE deleted_at IS NULL;
CREATE INDEX scrap_records_factory_idx ON scrap_records (factory) WHERE deleted_at IS NULL;
CREATE INDEX scrap_records_type_idx ON scrap_records (scrap_type_id) WHERE deleted_at IS NULL;
CREATE INDEX scrap_records_inspector_idx ON scrap_records (inspector_id);
CREATE INDEX scrap_records_creator_idx ON scrap_records (created_by_id);
CREATE INDEX scrap_records_updater_idx ON scrap_records (updated_by_id);
-- A photo is the evidence of one live record (the API also refuses a card photo reused as another's box photo).
CREATE UNIQUE INDEX scrap_records_card_image_idx ON scrap_records (card_image_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX scrap_records_box_image_idx ON scrap_records (box_image_id) WHERE deleted_at IS NULL;
CREATE TRIGGER scrap_records_no_delete BEFORE DELETE ON scrap_records FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

-- Recording starts with whoever records inspections; correcting or deleting
-- anyone's record with supervisors. Reading is History's.
INSERT INTO permissions (id) VALUES ('record-scrap'), ('edit-scrap');
INSERT INTO role_permissions (role, permission) VALUES
  ('inspector', 'record-scrap'), ('supervisor', 'record-scrap'), ('admin', 'record-scrap'),
  ('supervisor', 'edit-scrap'), ('admin', 'edit-scrap');

-- ---- The assistant (domain inspection) ------------------------------------------
-- Fast as CLAUDE.md asks: one row per record, no per-row subquery; the period
-- on recorded_at / scrap_day (indexed), the machine on ai.machine_key(machine_code).

CREATE VIEW ai.scrap_records AS
SELECT s.id AS scrap_id,
       s.date AS scrap_day,
       s.factory,
       s.machine_id,
       s.machine_code,
       s.machine_name AS machine,
       s.scrap_type_id,
       s.scrap_type_name AS scrap_type,
       s.weight_kg::float8 AS weight_kg,
       NULLIF(s.responsible_person, '') AS responsible_person,
       s.inspector_id,
       s.inspector_name AS inspector,
       s.created_by_name AS recorded_by,
       s.created_at AS recorded_at,
       s.updated_at,
       s.updated_by_name AS updated_by
  FROM scrap_records s
 WHERE s.deleted_at IS NULL;
COMMENT ON VIEW ai.scrap_records IS 'Scrap recorded by quality inspectors, one row per weighing: the day, factory, machine, scrap type (Coarse scrap, Soft scrap or another type added later) and weight in kg. Sum weight_kg over any grouping (machine, factory, scrap_type, day, week, month, inspector). Deleted records are left out. Photos of the scrap card and box are in ai.scrap_photos.';
COMMENT ON COLUMN ai.scrap_records.scrap_id IS 'The record. Join ai.scrap_photos on scrap_id.';
COMMENT ON COLUMN ai.scrap_records.scrap_day IS 'The day the scrap was recorded for (chosen by the inspector). Periods of scrap filter on it: scrap_day >= ''2026-10-01'' AND scrap_day < ''2026-11-01''; by month date_trunc(''month'', scrap_day).';
COMMENT ON COLUMN ai.scrap_records.factory IS 'The factory as recorded (for example LM2, LM3).';
COMMENT ON COLUMN ai.scrap_records.machine_id IS 'The machine in ai.machines (by id).';
COMMENT ON COLUMN ai.scrap_records.machine_code IS 'The machine''s code as recorded; filter a machine with ai.machine_key(machine_code) = ai.machine_key(''24'') (indexed).';
COMMENT ON COLUMN ai.scrap_records.machine IS 'The machine''s name as recorded (the work center).';
COMMENT ON COLUMN ai.scrap_records.scrap_type_id IS 'The scrap type''s id.';
COMMENT ON COLUMN ai.scrap_records.scrap_type IS 'The scrap type as recorded: Coarse scrap, Soft scrap, or a type added later.';
COMMENT ON COLUMN ai.scrap_records.weight_kg IS 'The scrap''s weight in kilograms (always above 0). Sum it; never count rows as weight.';
COMMENT ON COLUMN ai.scrap_records.responsible_person IS 'Who was responsible for the scrap, as typed (a production person); NULL when not given.';
COMMENT ON COLUMN ai.scrap_records.inspector_id IS 'The quality inspector''s account (ai.users).';
COMMENT ON COLUMN ai.scrap_records.inspector IS 'The quality inspector who checked the scrap, as recorded.';
COMMENT ON COLUMN ai.scrap_records.recorded_by IS 'Who entered the record in the app.';
COMMENT ON COLUMN ai.scrap_records.recorded_at IS 'When the record was entered (indexed); scrap_day is the day it belongs to.';
COMMENT ON COLUMN ai.scrap_records.updated_at IS 'When the record was last corrected (equal to recorded_at when never corrected); the changes are in ai.audit_log, entity ScrapRecord.';
COMMENT ON COLUMN ai.scrap_records.updated_by IS 'Who corrected it last.';

CREATE VIEW ai.scrap_photos AS
SELECT i.id AS photo_id,
       p.photo_of,
       s.id AS scrap_id,
       s.date AS scrap_day,
       s.factory,
       s.machine_code,
       s.machine_name AS machine,
       s.scrap_type_name AS scrap_type,
       s.weight_kg::float8 AS weight_kg,
       s.inspector_name AS inspector,
       s.created_at AS recorded_at
  FROM scrap_records s
 CROSS JOIN LATERAL (VALUES ('scrap card'::text, s.card_image_id), ('scrap box'::text, s.box_image_id)) p (photo_of, image_id)
  JOIN images i ON i.id = p.image_id AND i.deleted_at IS NULL
 WHERE s.deleted_at IS NULL;
COMMENT ON VIEW ai.scrap_photos IS 'The two photos of each scrap record (its scrap card and its scrap box), one row per photo. To SHOW them, return photo_id with a few columns that say what each one is (photo_of, machine, scrap_type, weight_kg, scrap_day): the app draws them as the photos, captioned by those columns. Filter on scrap_day or recorded_at for a period.';
COMMENT ON COLUMN ai.scrap_photos.photo_id IS 'The photo. A result with a column named photo_id is shown as the photos themselves, captioned by the row''s other columns; never quote the id in an answer.';
COMMENT ON COLUMN ai.scrap_photos.photo_of IS 'scrap card (the weighing card) or scrap box (the box or bin of scrap).';
COMMENT ON COLUMN ai.scrap_photos.scrap_id IS 'The record in ai.scrap_records.';
COMMENT ON COLUMN ai.scrap_photos.scrap_day IS 'The record''s day.';
COMMENT ON COLUMN ai.scrap_photos.factory IS 'The factory as recorded.';
COMMENT ON COLUMN ai.scrap_photos.machine_code IS 'The machine''s code; filter with ai.machine_key(machine_code).';
COMMENT ON COLUMN ai.scrap_photos.machine IS 'The machine''s name as recorded.';
COMMENT ON COLUMN ai.scrap_photos.scrap_type IS 'The scrap type as recorded.';
COMMENT ON COLUMN ai.scrap_photos.weight_kg IS 'The record''s weight in kilograms (the same on both of its photos: never sum it here, use ai.scrap_records).';
COMMENT ON COLUMN ai.scrap_photos.inspector IS 'The quality inspector, as recorded.';
COMMENT ON COLUMN ai.scrap_photos.recorded_at IS 'When the record was entered (indexed).';

DO $$
BEGIN
  EXECUTE format('GRANT SELECT ON ai.scrap_records, ai.scrap_photos TO %I', current_database() || '_ai_inspection');
END $$;
