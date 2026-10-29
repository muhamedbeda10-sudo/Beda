-- ============================================================================
-- 0088 — the warehouse role (§27).
--
-- The store's keepers receive deliveries against the purchase orders and send
-- them to quality receiving; what they may open and do is set in 0089 (a value
-- added to an enum is usable only once this migration has committed).
-- ============================================================================

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'warehouse';
