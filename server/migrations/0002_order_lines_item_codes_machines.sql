-- ============================================================================
-- 0002 — order lines, item codes and machine codes
--
-- The ERP export has one row per (order, item, machine), each with its own
-- "Order ID". Until now the order number was treated as unique and lines of
-- the same order collapsed into one row on import. From here on:
--
--   • production_orders  — a row is an ORDER LINE. `line_key` holds the ERP's
--                          Order ID and is the unique business key; the order
--                          number repeats across the lines of one order.
--   • machines           — `code` is the unique identity of a machine. Orders,
--                          defects and machine-specific dimensions refer to it
--                          (the column keeps its historical name
--                          work_center_code; the value is the machine code).
--   • item configuration — dimensions and reference images are keyed by the
--                          item CODE, not the item name. A dimension row may
--                          name a machine; a row without one applies to every
--                          machine, and a machine-specific row overrides the
--                          general one of the same name.
--   • sample_coils       — remember which catalogue coil was picked, so a
--                          coil typed by hand is distinguishable from one
--                          chosen from the register.
-- ============================================================================

-- ---- Production orders → order lines ---------------------------------------

ALTER TABLE production_orders ADD COLUMN line_key text;
-- Every existing row was unique on its order number, so that number is the
-- only line key it can have had. Re-importing the ERP file assigns the real
-- Order IDs and restores the lines that collapsed.
UPDATE production_orders SET line_key = order_number WHERE line_key IS NULL;
ALTER TABLE production_orders
  ALTER COLUMN line_key SET NOT NULL,
  ADD CONSTRAINT production_orders_line_key_not_blank CHECK (btrim(line_key) <> '');

DROP INDEX production_orders_number_key;
CREATE UNIQUE INDEX production_orders_line_key_key ON production_orders (lower(line_key) text_pattern_ops);
CREATE INDEX production_orders_number_idx ON production_orders (lower(order_number) text_pattern_ops);
-- The new-inspection screen lists the orders of one machine.
CREATE INDEX production_orders_machine_number_idx
  ON production_orders (work_center_code, lower(order_number)) WHERE deleted_at IS NULL;

-- ---- Machines: the code is the identity ------------------------------------

-- Two active machines sharing a code cannot both be "the machine" an order
-- names. Keep the earliest of each duplicate group; the machine sheet
-- re-import brings the register back in full with distinct codes.
UPDATE machines m SET deleted_at = now()
 WHERE m.deleted_at IS NULL
   AND EXISTS (
     SELECT 1 FROM machines o
      WHERE o.deleted_at IS NULL AND lower(o.code) = lower(m.code)
        AND (o.created_at < m.created_at OR (o.created_at = m.created_at AND o.id < m.id)));
CREATE UNIQUE INDEX machines_code_key ON machines (lower(code)) WHERE deleted_at IS NULL;

-- ---- Item configuration keyed by item code ----------------------------------

-- Best-effort backfill: an item name that maps to exactly one item code in the
-- order catalogue gets that code. Anything else keeps the name as its code so
-- no configuration row is lost; the item sheet re-import corrects it.
CREATE TEMP TABLE item_code_by_name AS
  SELECT lower(item) AS item_lc, min(item_code) AS item_code
    FROM production_orders
   WHERE item <> '' AND item_code <> ''
   GROUP BY lower(item)
  HAVING count(DISTINCT item_code) = 1;

ALTER TABLE item_dimension_order
  ADD COLUMN item_code text,
  ADD COLUMN work_center_code text;
UPDATE item_dimension_order d SET item_code = COALESCE(
  (SELECT m.item_code FROM item_code_by_name m WHERE m.item_lc = lower(d.item)), d.item);
ALTER TABLE item_dimension_order
  ALTER COLUMN item_code SET NOT NULL,
  ALTER COLUMN item SET DEFAULT '',
  DROP CONSTRAINT item_dimension_order_not_blank,
  ADD CONSTRAINT item_dimension_order_not_blank CHECK (btrim(item_code) <> '' AND btrim(dimension_name) <> ''),
  ADD CONSTRAINT item_dimension_order_machine_not_blank CHECK (work_center_code IS NULL OR btrim(work_center_code) <> '');
DROP INDEX item_dimension_order_key;
DROP INDEX item_dimension_order_item_idx;
CREATE UNIQUE INDEX item_dimension_order_key
  ON item_dimension_order (lower(item_code), lower(dimension_name), COALESCE(lower(work_center_code), ''))
  WHERE deleted_at IS NULL;
CREATE INDEX item_dimension_order_item_code_idx ON item_dimension_order (lower(item_code)) WHERE deleted_at IS NULL;

ALTER TABLE item_dimension_master ADD COLUMN item_code text;
UPDATE item_dimension_master d SET item_code = COALESCE(
  (SELECT m.item_code FROM item_code_by_name m WHERE m.item_lc = lower(d.item)), d.item);
ALTER TABLE item_dimension_master
  ALTER COLUMN item_code SET NOT NULL,
  ALTER COLUMN item SET DEFAULT '',
  DROP CONSTRAINT item_dimension_master_not_blank,
  ADD CONSTRAINT item_dimension_master_not_blank CHECK (btrim(item_code) <> '' AND btrim(dimension_name) <> '');
DROP INDEX item_dimension_master_key;
DROP INDEX item_dimension_master_item_idx;
CREATE UNIQUE INDEX item_dimension_master_key
  ON item_dimension_master (lower(item_code), lower(dimension_name)) WHERE deleted_at IS NULL;
CREATE INDEX item_dimension_master_item_code_idx ON item_dimension_master (lower(item_code)) WHERE deleted_at IS NULL;

ALTER TABLE item_reference_images ADD COLUMN item_code text;
UPDATE item_reference_images d SET item_code = COALESCE(
  (SELECT m.item_code FROM item_code_by_name m WHERE m.item_lc = lower(d.item)), d.item);
ALTER TABLE item_reference_images
  ALTER COLUMN item_code SET NOT NULL,
  ALTER COLUMN item SET DEFAULT '',
  DROP CONSTRAINT item_reference_images_not_blank,
  ADD CONSTRAINT item_reference_images_not_blank CHECK (btrim(item_code) <> '');
DROP INDEX item_reference_images_item_idx;
CREATE INDEX item_reference_images_item_code_idx ON item_reference_images (lower(item_code)) WHERE deleted_at IS NULL;

DROP TABLE item_code_by_name;

-- ---- Sample coils: link to the catalogue -------------------------------------

ALTER TABLE sample_coils ADD COLUMN coil_id uuid REFERENCES coils (id);
CREATE INDEX sample_coils_coil_idx ON sample_coils (coil_id) WHERE coil_id IS NOT NULL;
