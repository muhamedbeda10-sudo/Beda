-- ============================================================================
-- 0040 — the field 0039 added is the connector's coil, not a welding wire:
-- "Connector coil number", required on every welding sample, typed on the
-- setup step under the welding wire batch. Renamed in place, so any value
-- already typed is kept:
--   • pt_records.connector_wire_batch → connector_coil_number
--   • ai.pt_records.connector_wire_batch → connector_coil_number (the view
--     follows the table's column by itself; its own column is renamed too)
-- ============================================================================

ALTER TABLE pt_records RENAME COLUMN connector_wire_batch TO connector_coil_number;
ALTER VIEW ai.pt_records RENAME COLUMN connector_wire_batch TO connector_coil_number;
COMMENT ON COLUMN ai.pt_records.connector_coil_number IS 'Coil number of the connector (required on welding samples from 0039 on; null on older ones); welding_wire_batch is the welding wire.';
