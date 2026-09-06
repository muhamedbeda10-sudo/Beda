-- ============================================================================
-- 0008 — A sample can be re-recorded from History: its paint and PT rows are
-- marked deleted and written afresh. One LIVE record per sample is still the
-- rule, so the plain unique constraints become partial unique indexes that
-- ignore retired rows.
-- ============================================================================

ALTER TABLE pt_records DROP CONSTRAINT pt_records_sample_id_key;
CREATE UNIQUE INDEX pt_records_sample_live ON pt_records (sample_id) WHERE deleted_at IS NULL;

ALTER TABLE paint_samples DROP CONSTRAINT paint_samples_sample_id_key;
CREATE UNIQUE INDEX paint_samples_sample_live ON paint_samples (sample_id) WHERE deleted_at IS NULL;
