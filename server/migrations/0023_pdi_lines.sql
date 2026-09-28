-- ============================================================================
-- 0023 — a PDI covers the items of an order it names (§4).
--
-- A pre-delivery inspection is done on a delivery: an order, or the part of
-- it that ships this time. Until now a PDI named one order line — one item
-- on one machine — so a delivery of several items needed several PDIs, and
-- the lines it covered were a guess. A PDI now names every line it covers;
-- the lines share one order number. `order_id` stays as the PDI's anchor
-- line: the first line it covers, for the customer and the photo links.
-- ============================================================================

CREATE TABLE pdi_lines (
  pdi_id   uuid NOT NULL REFERENCES pdi_documents (id),
  order_id uuid NOT NULL REFERENCES production_orders (id),
  PRIMARY KEY (pdi_id, order_id)
);
CREATE INDEX pdi_lines_order_idx ON pdi_lines (order_id);
CREATE TRIGGER pdi_lines_no_delete BEFORE DELETE ON pdi_lines FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

-- Every PDI recorded so far covered the one line it named.
INSERT INTO pdi_lines (pdi_id, order_id)
SELECT id, order_id FROM pdi_documents;

-- History lists PDIs newest first and walks back by date; the recent index
-- already serves that. Filtering by who recorded one is served here.
CREATE INDEX pdi_documents_created_by_idx ON pdi_documents (created_by_id) WHERE deleted_at IS NULL;
