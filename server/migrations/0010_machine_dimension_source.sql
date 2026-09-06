-- ============================================================================
-- 0010 — Whether a machine loads the configured item dimensions into the
-- wizard. On some machines the inspector measures whatever the part needs
-- and types nominal and tolerance once; those machines are switched off here
-- and the wizard starts from the previous sample's rows instead.
-- ============================================================================

ALTER TABLE machines ADD COLUMN uses_item_dimensions boolean NOT NULL DEFAULT true;
