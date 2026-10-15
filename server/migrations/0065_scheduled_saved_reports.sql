-- ============================================================================
-- 0065 — a scheduled report that sends a saved report (My reports): the
-- schedule (ai_automations.schedule, json) names the report and the values
-- its inputs take on every run; nothing to change there. What each delivery
-- ran is kept with it: the saved report it was, and the values its inputs
-- took that day, as read ({label, value} each), so a delivery says what it
-- shows however the report or the schedule changes later.
-- ============================================================================

ALTER TABLE ai_report_deliveries
  ADD COLUMN report_id uuid REFERENCES ai_reports (id),
  ADD COLUMN inputs    json,
  ADD CONSTRAINT ai_report_deliveries_inputs_array CHECK (inputs IS NULL OR json_typeof(inputs) = 'array');
