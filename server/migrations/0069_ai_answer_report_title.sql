-- ============================================================================
-- §20 — the title an answer is printed under (server/src/ai/answerReportTitle.ts).
-- Named by the assistant the first time the person prints the answer, and kept
-- with it: printed again, it reads the same and costs nothing.
-- ============================================================================

ALTER TABLE ai_turns
  ADD COLUMN report_title text CHECK (report_title IS NULL OR (btrim(report_title) <> '' AND char_length(report_title) <= 100));
