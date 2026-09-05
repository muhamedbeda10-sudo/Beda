-- ============================================================================
-- 0005 — retire the master-dimension fallback
--
-- Item dimensions are configured once, per item code (optionally per
-- machine). A second, general list the wizard fell back to only made it
-- unclear where a number came from, so it goes.
-- ============================================================================

DROP TABLE item_dimension_master;
