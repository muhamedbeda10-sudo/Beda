-- ============================================================================
-- 0011 — Machines that produce for stock, not for an order. Such a machine
-- (the 400-ton press making connectors) names the one item it makes; a
-- session on it is started without picking an order — the API keeps one
-- fixed "STOCK" line per such machine so every screen and rule that hangs
-- off an order line keeps working — and records how many pairs came out.
-- ============================================================================

ALTER TABLE machines
  ADD COLUMN stock_item      text,
  ADD COLUMN stock_item_code text,
  ADD CONSTRAINT machines_stock_item_pair CHECK ((stock_item IS NULL) = (stock_item_code IS NULL));

ALTER TABLE inspection_sessions
  ADD COLUMN produced_qty numeric(14, 3),
  ADD CONSTRAINT inspection_sessions_produced_qty_nonnegative CHECK (produced_qty IS NULL OR produced_qty >= 0);
