-- ============================================================================
-- 0019 — PT coverage from production (§5.6).
--
-- The PT requirement is 5% of the session's final quantity, rounded up to a
-- whole piece, worked out when the session closes; nobody types a frequency
-- any more. The column stays for the records that carried one, nullable,
-- and its check (which refused exactly 5, against the rule) goes.
-- ============================================================================

ALTER TABLE pt_records ALTER COLUMN test_frequency_pct DROP NOT NULL;
ALTER TABLE pt_records DROP CONSTRAINT IF EXISTS pt_records_test_frequency_pct_check;
