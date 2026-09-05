-- ============================================================================
-- 0003 — the ERP's access status on an order line
--
-- The order export carries a status per line: Active, Hold, Stock, Cancel.
-- A cancelled line must not be offered for inspection, so the status is
-- stored with the line and the new-inspection queries leave "Cancel" out.
-- ============================================================================

ALTER TABLE production_orders ADD COLUMN erp_status text NOT NULL DEFAULT '';
