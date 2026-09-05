-- ============================================================================
-- 0004 — a reference image may be specific to one machine
--
-- Like a dimension row, an item's reference photo either applies wherever
-- the item is produced (no machine) or only on one machine.
-- ============================================================================

ALTER TABLE item_reference_images ADD COLUMN work_center_code text;
ALTER TABLE item_reference_images
  ADD CONSTRAINT item_reference_images_machine_not_blank CHECK (work_center_code IS NULL OR btrim(work_center_code) <> '');
