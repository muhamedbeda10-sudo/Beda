-- ============================================================================
-- MTC — the welding wire and mesh wire registers, filled from the suppliers'
-- certificates as the coil register is (the MTC tab).
--
--   • welding_wires — one row per batch, identified by its batch number (the
--     number the PT step's "Welding wire batch number" names). The deposited
--     metal's yield and tensile strength as certified, the weight delivered.
--   • mesh_wires — one row per cast and diameter: a cast is often drawn to
--     several diameters, each certified on its own line.
--
-- Both as the coil register: soft delete only (removed rows keep their key,
-- so a certificate can bring them back), updated_at kept by the trigger, every
-- change written to the audit log by the API, measurements numeric(10, 3).
-- The PT step still takes any batch typed by hand: the register suggests,
-- it does not refuse.
-- ============================================================================

CREATE TABLE welding_wires (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_number    text NOT NULL,
  classification  text,
  wire_type       text,
  diameter        numeric(10, 3),
  supplier        text,
  weight_kg       numeric(10, 3),
  yield           numeric(10, 3),
  tensile         numeric(10, 3),
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  deleted_by_id   uuid REFERENCES users (id),
  CONSTRAINT welding_wires_batch_not_blank CHECK (btrim(batch_number) <> ''),
  CONSTRAINT welding_wires_measures_positive CHECK (
    (diameter IS NULL OR diameter >= 0) AND (weight_kg IS NULL OR weight_kg >= 0)
    AND (yield IS NULL OR yield >= 0) AND (tensile IS NULL OR tensile >= 0))
);
CREATE UNIQUE INDEX welding_wires_batch_key ON welding_wires (lower(batch_number) text_pattern_ops);
CREATE INDEX welding_wires_supplier_idx ON welding_wires (lower(supplier));
CREATE INDEX welding_wires_created_idx ON welding_wires (created_at DESC) WHERE deleted_at IS NULL;
CREATE TRIGGER welding_wires_updated_at BEFORE UPDATE ON welding_wires FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER welding_wires_no_delete BEFORE DELETE ON welding_wires FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

CREATE TABLE mesh_wires (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cast_number     text NOT NULL,
  diameter        numeric(10, 3) NOT NULL,
  product         text,
  grade           text,
  supplier        text,
  tensile         numeric(10, 3),
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  deleted_by_id   uuid REFERENCES users (id),
  CONSTRAINT mesh_wires_cast_not_blank CHECK (btrim(cast_number) <> ''),
  CONSTRAINT mesh_wires_diameter_positive CHECK (diameter > 0),
  CONSTRAINT mesh_wires_tensile_positive CHECK (tensile IS NULL OR tensile >= 0)
);
CREATE UNIQUE INDEX mesh_wires_cast_diameter_key ON mesh_wires (lower(cast_number) text_pattern_ops, diameter);
CREATE INDEX mesh_wires_supplier_idx ON mesh_wires (lower(supplier));
CREATE INDEX mesh_wires_created_idx ON mesh_wires (created_at DESC) WHERE deleted_at IS NULL;
CREATE TRIGGER mesh_wires_updated_at BEFORE UPDATE ON mesh_wires FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER mesh_wires_no_delete BEFORE DELETE ON mesh_wires FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();
