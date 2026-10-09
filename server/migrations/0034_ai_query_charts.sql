-- ============================================================================
-- 0034 — a chart for a query of the AI assistant (§20, phase 4).
--   • ai_queries.chart — how the model asked for the result to be drawn
--     (AiChartSpec: type, x, y, series, title), as the API checked it against
--     the result's columns; null when none was asked for or it did not fit.
--     Conversations begun before phase 4 have none: their tool, stored with
--     them, never offered it.
-- Like the rest of ai_queries it is the assistant's own record, never granted
-- to the reader roles.
-- ============================================================================

ALTER TABLE ai_queries ADD COLUMN chart json;
