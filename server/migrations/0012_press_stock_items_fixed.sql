-- ============================================================================
-- 0012 — The make-to-stock press is not configured by an administrator: it
-- is one known machine making its two fixed items (right and left
-- connector), so the per-machine stock-item columns added in 0011 go. The
-- session's produced quantity stays.
-- ============================================================================

ALTER TABLE machines
  DROP CONSTRAINT machines_stock_item_pair,
  DROP COLUMN stock_item,
  DROP COLUMN stock_item_code;
