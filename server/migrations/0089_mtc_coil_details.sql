-- ============================================================================
-- MTC — the coil register as the factory's sheet has it (Supplier, PO, Heat
-- number, Coil number, Coil/Sheet, Thickness, Width, Length, Grade, Type,
-- Delivery date, MTC No., Yield, Tensile, Elongation), the certificates kept
-- to open again, the delivery notes, and each coil's slitting.
--
--   • coils — heat_number, product_form (Coil | Sheet), length (a sheet's),
--     tensile and elongation as certified, mtc_number (the certificate's
--     number: until now written into notes as "MTC <number>", moved here),
--     mtc_document_id (the certificate itself, to open).
--     po_number, delivery_date, delivery_note_id: from the delivery note that
--     lists the coil (the latest live one), never typed — kept by triggers
--     whichever comes first, the note or the certificate.
--     std_* and the limits: the lab's grade (Lab → Setup) the coil's grade
--     and thickness find, worked out by the API (shared/lab gradeRows,
--     gradeFor) whenever a coil, a grade or a grade mapping changes; the
--     verdicts yield_ok, tensile_ok, elongation_ok are generated from them as
--     a lab test's are (green: within, red: outside, null: nothing to judge).
--   • welding_wires, mesh_wires — mtc_document_id too.
--   • mtc_documents — a certificate or delivery note as uploaded: its PDF,
--     the photos of its pages, or the mill's workbook, in the image store.
--   • delivery_notes, delivery_note_coils — the delivery note: its number,
--     day, PO and supplier, and the coils received. Read by Claude as a
--     certificate is, or typed.
--   • coil_slittings — a coil slit: the day and the strips' widths.
--   • record-slitting — who may record and remove slitting.
-- The assistant reads them as ai.coils (new columns at the end),
-- ai.delivery_notes, ai.delivery_note_coils and ai.coil_slittings.
-- ============================================================================

-- ---- Documents ---------------------------------------------------------------------

CREATE TABLE mtc_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name      text NOT NULL CHECK (btrim(file_name) <> '' AND length(file_name) <= 255),
  source         text NOT NULL CHECK (source IN ('pdf', 'images', 'sheet')),
  -- One key for a PDF or a workbook; one per photo, in page order.
  storage_keys   text[] NOT NULL CHECK (cardinality(storage_keys) BETWEEN 1 AND 20),
  driver         image_driver NOT NULL,
  byte_size      bigint NOT NULL CHECK (byte_size >= 0),
  uploaded_by_id uuid REFERENCES users (id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mtc_documents_created_idx ON mtc_documents (created_at DESC);
CREATE TRIGGER mtc_documents_no_delete BEFORE DELETE ON mtc_documents FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

ALTER TABLE mtc_readings ADD COLUMN document_id uuid REFERENCES mtc_documents (id);
ALTER TABLE mtc_readings DROP CONSTRAINT mtc_readings_kind;
ALTER TABLE mtc_readings ADD CONSTRAINT mtc_readings_kind CHECK (kind IS NULL OR kind IN ('coils', 'welding-wire', 'mesh-wire', 'delivery-note'));

-- ---- Delivery notes ----------------------------------------------------------------

CREATE TABLE delivery_notes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_number      text CHECK (note_number IS NULL OR (btrim(note_number) <> '' AND length(note_number) <= 120)),
  delivery_date    date NOT NULL,
  po_number        text CHECK (po_number IS NULL OR length(po_number) <= 120),
  supplier         text CHECK (supplier IS NULL OR length(supplier) <= 200),
  notes            text CHECK (notes IS NULL OR length(notes) <= 1000),
  document_id      uuid REFERENCES mtc_documents (id),
  version          integer NOT NULL DEFAULT 1,
  created_by_id    uuid REFERENCES users (id),
  created_by_name  text NOT NULL DEFAULT '',
  updated_by_name  text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  deleted_by_id    uuid REFERENCES users (id)
);
-- A supplier numbers its own notes: the same number twice from one supplier is the same note.
CREATE UNIQUE INDEX delivery_notes_number_key ON delivery_notes (lower(COALESCE(btrim(supplier), '')), lower(btrim(note_number)))
  WHERE deleted_at IS NULL AND note_number IS NOT NULL;
CREATE INDEX delivery_notes_date_idx ON delivery_notes (delivery_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX delivery_notes_created_idx ON delivery_notes (created_at DESC);
CREATE INDEX delivery_notes_po_idx ON delivery_notes (lower(po_number) text_pattern_ops);
CREATE TRIGGER delivery_notes_updated_at BEFORE UPDATE ON delivery_notes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER delivery_notes_no_delete BEFORE DELETE ON delivery_notes FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

-- The coils a note lists. Replaced whole when the note is corrected (the note's audit trail keeps what it was).
CREATE TABLE delivery_note_coils (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_note_id uuid NOT NULL REFERENCES delivery_notes (id),
  position         integer NOT NULL CHECK (position >= 1),
  coil_number      text NOT NULL CHECK (btrim(coil_number) <> '' AND length(coil_number) <= 120),
  weight_kg        numeric(10, 3) CHECK (weight_kg IS NULL OR weight_kg >= 0)
);
CREATE UNIQUE INDEX delivery_note_coils_key ON delivery_note_coils (delivery_note_id, lower(coil_number));
CREATE INDEX delivery_note_coils_number_idx ON delivery_note_coils (lower(coil_number) text_pattern_ops);

-- ---- The coil register's new columns -------------------------------------------------

ALTER TABLE coils
  ADD COLUMN heat_number      text,
  ADD COLUMN product_form     text,
  ADD COLUMN length           numeric(10, 3),
  ADD COLUMN tensile          numeric(10, 3),
  ADD COLUMN elongation       numeric(10, 3),
  ADD COLUMN mtc_number       text,
  ADD COLUMN mtc_document_id  uuid REFERENCES mtc_documents (id),
  ADD COLUMN po_number        text,
  ADD COLUMN delivery_date    date,
  ADD COLUMN delivery_note_id uuid REFERENCES delivery_notes (id),
  ADD COLUMN std_grade        text,
  ADD COLUMN std_standard     text,
  ADD COLUMN yield_min        numeric(10, 2),
  ADD COLUMN yield_max        numeric(10, 2),
  ADD COLUMN tensile_min      numeric(10, 2),
  ADD COLUMN tensile_max      numeric(10, 2),
  ADD COLUMN elongation_min   numeric(6, 2),
  ADD CONSTRAINT coils_details_positive CHECK (
    (length IS NULL OR length >= 0) AND (tensile IS NULL OR tensile >= 0) AND (elongation IS NULL OR elongation >= 0));
ALTER TABLE coils
  ADD COLUMN yield_ok      boolean GENERATED ALWAYS AS (lab_within(yield, yield, yield_min, yield_max)) STORED,
  ADD COLUMN tensile_ok    boolean GENERATED ALWAYS AS (lab_within(tensile, tensile, tensile_min, tensile_max)) STORED,
  ADD COLUMN elongation_ok boolean GENERATED ALWAYS AS (lab_within(elongation, elongation, elongation_min, NULL)) STORED;

CREATE INDEX coils_heat_idx ON coils (lower(heat_number) text_pattern_ops);
CREATE INDEX coils_mtc_number_idx ON coils (lower(mtc_number) text_pattern_ops);
CREATE INDEX coils_po_idx ON coils (lower(po_number) text_pattern_ops);
CREATE INDEX coils_delivery_date_idx ON coils (delivery_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX coils_delivery_note_idx ON coils (delivery_note_id) WHERE delivery_note_id IS NOT NULL;

ALTER TABLE welding_wires ADD COLUMN mtc_document_id uuid REFERENCES mtc_documents (id);
ALTER TABLE mesh_wires ADD COLUMN mtc_document_id uuid REFERENCES mtc_documents (id);

-- The certificate's number had been written into the notes ("MTC 067711"): it has its column now.
UPDATE coils SET mtc_number = left(btrim(substring(notes FROM '^MTC (.+)$')), 120), notes = NULL
 WHERE notes ~ '^MTC \S';

-- ---- PO and delivery day, from the delivery notes -------------------------------------

/** The coils named (in lower case) take the PO and day of the latest live delivery note listing them; none, nothing. */
CREATE FUNCTION refresh_coil_deliveries(numbers text[]) RETURNS void LANGUAGE sql AS $$
  UPDATE coils c
     SET delivery_note_id = d.note_id, po_number = d.po_number, delivery_date = d.delivery_date
    FROM (SELECT DISTINCT x AS k FROM unnest(numbers) x WHERE x IS NOT NULL) w
    LEFT JOIN LATERAL (
      SELECT n.id AS note_id, NULLIF(btrim(n.po_number), '') AS po_number, n.delivery_date
        FROM delivery_note_coils l
        JOIN delivery_notes n ON n.id = l.delivery_note_id AND n.deleted_at IS NULL
       WHERE lower(l.coil_number) = w.k
       ORDER BY n.delivery_date DESC, n.created_at DESC
       LIMIT 1) d ON true
   WHERE lower(c.coil_number) = w.k
     AND (c.delivery_note_id, c.po_number, c.delivery_date) IS DISTINCT FROM (d.note_id, d.po_number, d.delivery_date);
$$;

CREATE FUNCTION coil_deliveries_after_lines() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE numbers text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT lower(coil_number)) INTO numbers FROM new_rows;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT lower(coil_number)) INTO numbers FROM old_rows;
  ELSE
    SELECT array_agg(DISTINCT k) INTO numbers FROM (SELECT lower(coil_number) AS k FROM new_rows UNION SELECT lower(coil_number) FROM old_rows) u;
  END IF;
  IF numbers IS NOT NULL THEN PERFORM refresh_coil_deliveries(numbers); END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER delivery_note_coils_deliveries_ins AFTER INSERT ON delivery_note_coils REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION coil_deliveries_after_lines();
CREATE TRIGGER delivery_note_coils_deliveries_upd AFTER UPDATE ON delivery_note_coils REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION coil_deliveries_after_lines();
CREATE TRIGGER delivery_note_coils_deliveries_del AFTER DELETE ON delivery_note_coils REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION coil_deliveries_after_lines();

/** A note's day, PO or removal reaches its coils. */
CREATE FUNCTION coil_deliveries_after_notes() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE numbers text[];
BEGIN
  SELECT array_agg(DISTINCT lower(l.coil_number)) INTO numbers
    FROM new_rows n JOIN old_rows o ON o.id = n.id JOIN delivery_note_coils l ON l.delivery_note_id = n.id
   WHERE n.delivery_date IS DISTINCT FROM o.delivery_date OR n.po_number IS DISTINCT FROM o.po_number OR n.deleted_at IS DISTINCT FROM o.deleted_at;
  IF numbers IS NOT NULL THEN PERFORM refresh_coil_deliveries(numbers); END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER delivery_notes_deliveries_upd AFTER UPDATE ON delivery_notes REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION coil_deliveries_after_notes();

/** A coil registered after its delivery note (or renamed) finds it at once. */
CREATE FUNCTION coil_delivery_on_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT n.id, NULLIF(btrim(n.po_number), ''), n.delivery_date INTO NEW.delivery_note_id, NEW.po_number, NEW.delivery_date
    FROM delivery_note_coils l
    JOIN delivery_notes n ON n.id = l.delivery_note_id AND n.deleted_at IS NULL
   WHERE lower(l.coil_number) = lower(NEW.coil_number)
   ORDER BY n.delivery_date DESC, n.created_at DESC
   LIMIT 1;
  IF NOT FOUND THEN
    NEW.delivery_note_id := NULL; NEW.po_number := NULL; NEW.delivery_date := NULL;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER coils_delivery_ins BEFORE INSERT ON coils FOR EACH ROW EXECUTE FUNCTION coil_delivery_on_write();
CREATE TRIGGER coils_delivery_upd BEFORE UPDATE OF coil_number ON coils FOR EACH ROW EXECUTE FUNCTION coil_delivery_on_write();

-- ---- Slitting ------------------------------------------------------------------------------

/** The sum of an array's values: a slitting's strips laid side by side. */
CREATE FUNCTION numeric_array_sum(xs numeric[]) RETURNS numeric LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT sum(x) FROM unnest(xs) x
$$;

CREATE TABLE coil_slittings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coil_id         uuid NOT NULL REFERENCES coils (id),
  slit_date       date NOT NULL,
  -- The strips' widths after slitting, mm, as they lie across the coil.
  widths          numeric(10, 3)[] NOT NULL CHECK (cardinality(widths) BETWEEN 1 AND 50 AND 0 < ALL (widths) AND array_position(widths, NULL) IS NULL),
  total_width     numeric GENERATED ALWAYS AS (numeric_array_sum(widths)) STORED,
  notes           text CHECK (notes IS NULL OR length(notes) <= 1000),
  created_by_id   uuid REFERENCES users (id),
  created_by_name text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  deleted_by_id   uuid REFERENCES users (id)
);
CREATE INDEX coil_slittings_coil_idx ON coil_slittings (coil_id) WHERE deleted_at IS NULL;
CREATE INDEX coil_slittings_date_idx ON coil_slittings (slit_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX coil_slittings_created_idx ON coil_slittings (created_at DESC);
CREATE TRIGGER coil_slittings_updated_at BEFORE UPDATE ON coil_slittings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER coil_slittings_no_delete BEFORE DELETE ON coil_slittings FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

INSERT INTO permissions (id) VALUES ('record-slitting');
INSERT INTO role_permissions (role, permission) VALUES
  ('admin', 'record-slitting'), ('supervisor', 'record-slitting'), ('inspector', 'record-slitting')
ON CONFLICT DO NOTHING;

-- ---- The assistant's views ------------------------------------------------------------------

CREATE OR REPLACE VIEW ai.coils AS
SELECT c.id                         AS coil_id,
       c.coil_number,
       NULLIF(btrim(c.grade), '')   AS grade,
       ai.material_kind(c.grade)    AS material_kind,
       NULLIF(btrim(c.sm_type), '') AS sm_type,
       NULLIF(btrim(c.supplier), '') AS supplier,
       c.thickness                  AS thickness_mm,
       c.width                      AS width_mm,
       c.yield                      AS yield_strength,
       c.notes,
       c.created_at                 AS registered_at,
       c.updated_at,
       (SELECT count(*) FROM sample_coils sc
          JOIN inspection_samples x ON x.id = sc.sample_id AND x.deleted_at IS NULL
          JOIN inspection_sessions s ON s.id = x.session_id AND s.deleted_at IS NULL
         WHERE sc.deleted_at IS NULL AND lower(sc.coil_number) = lower(c.coil_number))::int AS samples_used_in,
       (SELECT max(x.created_at) FROM sample_coils sc
          JOIN inspection_samples x ON x.id = sc.sample_id AND x.deleted_at IS NULL
          JOIN inspection_sessions s ON s.id = x.session_id AND s.deleted_at IS NULL
         WHERE sc.deleted_at IS NULL AND lower(sc.coil_number) = lower(c.coil_number)) AS last_used_at,
       NULLIF(btrim(c.heat_number), '') AS heat_number,
       NULLIF(btrim(c.product_form), '') AS product_form,
       c.length                     AS length_mm,
       c.tensile                    AS tensile_strength,
       c.elongation                 AS elongation_pct,
       NULLIF(btrim(c.mtc_number), '') AS mtc_number,
       c.po_number,
       c.delivery_date,
       c.delivery_note_id,
       c.std_grade,
       c.std_standard,
       c.yield_min::float8          AS yield_min,
       c.yield_max::float8          AS yield_max,
       c.tensile_min::float8        AS tensile_min,
       c.tensile_max::float8        AS tensile_max,
       c.elongation_min::float8     AS elongation_min,
       c.yield_ok,
       c.tensile_ok,
       c.elongation_ok,
       c.mtc_document_id IS NOT NULL AS has_certificate_file
  FROM coils c
 WHERE c.deleted_at IS NULL;
COMMENT ON COLUMN ai.coils.sm_type IS 'The coil''s type: HR = black (hot-rolled, pickled), GI = galvanized, PP = pre-painted. Older rows may hold other codes.';
COMMENT ON COLUMN ai.coils.notes IS 'Free notes. The certificate''s number is in mtc_number (older coils had it here as "MTC <number>"; moved).';
COMMENT ON COLUMN ai.coils.heat_number IS 'The heat (cast) number the certificate gives the coil (indexed, lower(heat_number)).';
COMMENT ON COLUMN ai.coils.product_form IS 'Coil | Sheet: whether it came as a coil or as cut sheets.';
COMMENT ON COLUMN ai.coils.length_mm IS 'A sheet''s length, mm; null for a coil.';
COMMENT ON COLUMN ai.coils.tensile_strength IS 'Tensile strength (Rm) the supplier''s certificate states, N/mm² = MPa.';
COMMENT ON COLUMN ai.coils.elongation_pct IS 'Elongation after fracture (A) the supplier''s certificate states, %.';
COMMENT ON COLUMN ai.coils.mtc_number IS 'The mill test certificate''s number the coil came with (indexed, lower(mtc_number)). Compare with ai.lab_tests.certificate.';
COMMENT ON COLUMN ai.coils.po_number IS 'The purchase order, from the latest delivery note that lists the coil (ai.delivery_note_coils); null when no note lists it. Kept as notes are saved: no join needed.';
COMMENT ON COLUMN ai.coils.delivery_date IS 'The day the coil was delivered, from that delivery note (indexed: filter deliveries on it). Null when no note lists it.';
COMMENT ON COLUMN ai.coils.delivery_note_id IS 'That delivery note = ai.delivery_notes.delivery_note_id.';
COMMENT ON COLUMN ai.coils.std_grade IS 'The lab''s grade (ai.lab_grade_limits, family sheet) the coil''s grade and thickness are judged by; null when Lab → Setup has none for it.';
COMMENT ON COLUMN ai.coils.std_standard IS 'That grade''s standard (EN 10149-2, EN 10346).';
COMMENT ON COLUMN ai.coils.yield_min IS 'Minimum yield strength of the grade''s thickness band, N/mm².';
COMMENT ON COLUMN ai.coils.yield_max IS 'Maximum yield strength, N/mm²; null when none.';
COMMENT ON COLUMN ai.coils.tensile_min IS 'Lowest tensile strength allowed, N/mm².';
COMMENT ON COLUMN ai.coils.tensile_max IS 'Highest tensile strength allowed, N/mm²; null when only a minimum.';
COMMENT ON COLUMN ai.coils.elongation_min IS 'Minimum elongation, %.';
COMMENT ON COLUMN ai.coils.yield_ok IS 'The certificate''s yield within the grade''s limits (the screen''s green; false is its red alert); null with no value or no limit.';
COMMENT ON COLUMN ai.coils.tensile_ok IS 'The certificate''s tensile strength within the limits; null with no value or no limit.';
COMMENT ON COLUMN ai.coils.elongation_ok IS 'The certificate''s elongation at least the minimum; null with no value or no limit.';
COMMENT ON COLUMN ai.coils.has_certificate_file IS 'The certificate itself is kept and opens from the MTC tab.';

CREATE OR REPLACE VIEW ai.delivery_notes AS
SELECT n.id                         AS delivery_note_id,
       n.note_number,
       n.delivery_date,
       NULLIF(btrim(n.po_number), '') AS po_number,
       NULLIF(btrim(n.supplier), '') AS supplier,
       n.notes,
       (SELECT count(*) FROM delivery_note_coils l WHERE l.delivery_note_id = n.id)::int AS coils,
       n.document_id IS NOT NULL    AS has_file,
       n.created_by_name            AS recorded_by,
       n.created_at                 AS recorded_at,
       n.updated_at
  FROM delivery_notes n
 WHERE n.deleted_at IS NULL;
COMMENT ON VIEW ai.delivery_notes IS 'Delivery notes of material received (coils), one row per note: its number, day, PO and supplier. Its coils: ai.delivery_note_coils. Filter periods on delivery_date.';
COMMENT ON COLUMN ai.delivery_notes.delivery_note_id IS 'The note''s id = ai.delivery_note_coils.delivery_note_id = ai.coils.delivery_note_id.';
COMMENT ON COLUMN ai.delivery_notes.note_number IS 'The note''s number as the supplier printed it; null when it had none.';
COMMENT ON COLUMN ai.delivery_notes.delivery_date IS 'The day of delivery (indexed).';
COMMENT ON COLUMN ai.delivery_notes.po_number IS 'The factory''s purchase order the delivery is against.';
COMMENT ON COLUMN ai.delivery_notes.supplier IS 'Who delivered (the mill, by its short name as the coil register spells it).';
COMMENT ON COLUMN ai.delivery_notes.notes IS 'Free notes.';
COMMENT ON COLUMN ai.delivery_notes.coils IS 'Coils the note lists.';
COMMENT ON COLUMN ai.delivery_notes.has_file IS 'The note itself is kept and opens from the MTC tab.';
COMMENT ON COLUMN ai.delivery_notes.recorded_by IS 'Who entered it.';
COMMENT ON COLUMN ai.delivery_notes.recorded_at IS 'When it was entered (indexed).';
COMMENT ON COLUMN ai.delivery_notes.updated_at IS 'When it was last changed.';

CREATE OR REPLACE VIEW ai.delivery_note_coils AS
SELECT l.delivery_note_id,
       n.note_number,
       n.delivery_date,
       NULLIF(btrim(n.po_number), '') AS po_number,
       NULLIF(btrim(n.supplier), '') AS supplier,
       l.position,
       l.coil_number,
       l.weight_kg::float8          AS weight_kg,
       c.id                         AS coil_id,
       c.id IS NOT NULL             AS in_register,
       n.created_at                 AS recorded_at
  FROM delivery_note_coils l
  JOIN delivery_notes n ON n.id = l.delivery_note_id AND n.deleted_at IS NULL
  LEFT JOIN coils c ON lower(c.coil_number) = lower(l.coil_number) AND c.deleted_at IS NULL;
COMMENT ON VIEW ai.delivery_note_coils IS 'Each coil a delivery note lists (the coils received), with its note''s day, PO and supplier. in_register = false: delivered with no certificate registered for it yet.';
COMMENT ON COLUMN ai.delivery_note_coils.delivery_note_id IS 'Its note = ai.delivery_notes.delivery_note_id.';
COMMENT ON COLUMN ai.delivery_note_coils.note_number IS 'Its note''s number.';
COMMENT ON COLUMN ai.delivery_note_coils.delivery_date IS 'Its note''s day of delivery.';
COMMENT ON COLUMN ai.delivery_note_coils.po_number IS 'Its note''s purchase order.';
COMMENT ON COLUMN ai.delivery_note_coils.supplier IS 'Its note''s supplier.';
COMMENT ON COLUMN ai.delivery_note_coils.position IS 'Its line on the note, from 1.';
COMMENT ON COLUMN ai.delivery_note_coils.coil_number IS 'The coil number as the note gives it (join ai.coils on coil_id, or on lower(coil_number)).';
COMMENT ON COLUMN ai.delivery_note_coils.weight_kg IS 'The weight delivered, kg.';
COMMENT ON COLUMN ai.delivery_note_coils.coil_id IS 'The coil register''s coil = ai.coils.coil_id; null when it is not registered.';
COMMENT ON COLUMN ai.delivery_note_coils.in_register IS 'The coil register holds this coil (its certificate was read).';
COMMENT ON COLUMN ai.delivery_note_coils.recorded_at IS 'When its note was entered (indexed).';

CREATE OR REPLACE VIEW ai.coil_slittings AS
SELECT s.id                         AS slitting_id,
       s.coil_id,
       c.coil_number,
       s.slit_date,
       c.width                      AS coil_width_mm,
       s.widths::float8[]           AS widths_mm,
       cardinality(s.widths)        AS strips,
       s.total_width::float8        AS total_width_mm,
       (c.width - s.total_width)::float8 AS trim_mm,
       s.notes,
       s.created_by_name            AS recorded_by,
       s.created_at                 AS recorded_at
  FROM coil_slittings s
  JOIN coils c ON c.id = s.coil_id AND c.deleted_at IS NULL
 WHERE s.deleted_at IS NULL;
COMMENT ON VIEW ai.coil_slittings IS 'Each slitting of a coil: the day and the widths of the strips it was slit into. Join ai.coils on coil_id. Filter periods on slit_date.';
COMMENT ON COLUMN ai.coil_slittings.slitting_id IS 'The slitting''s id.';
COMMENT ON COLUMN ai.coil_slittings.coil_id IS 'The coil = ai.coils.coil_id.';
COMMENT ON COLUMN ai.coil_slittings.coil_number IS 'The coil''s number.';
COMMENT ON COLUMN ai.coil_slittings.slit_date IS 'The day it was slit (indexed).';
COMMENT ON COLUMN ai.coil_slittings.coil_width_mm IS 'The coil''s width before slitting, mm.';
COMMENT ON COLUMN ai.coil_slittings.widths_mm IS 'The strips'' widths after slitting, mm, across the coil (unnest() for one row per strip).';
COMMENT ON COLUMN ai.coil_slittings.strips IS 'How many strips.';
COMMENT ON COLUMN ai.coil_slittings.total_width_mm IS 'The strips'' widths added up, mm.';
COMMENT ON COLUMN ai.coil_slittings.trim_mm IS 'The coil''s width less the strips'', mm: the edge trim; null when the coil''s width is not registered.';
COMMENT ON COLUMN ai.coil_slittings.notes IS 'Free notes.';
COMMENT ON COLUMN ai.coil_slittings.recorded_by IS 'Who recorded it.';
COMMENT ON COLUMN ai.coil_slittings.recorded_at IS 'When it was recorded (indexed).';

-- The materials domain holds them, with the coil register (0033).
DO $$
DECLARE
  role text := current_database() || '_ai_materials';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role) THEN
    EXECUTE format('GRANT SELECT ON ai.coils, ai.delivery_notes, ai.delivery_note_coils, ai.coil_slittings TO %I', role);
  END IF;
END $$;
