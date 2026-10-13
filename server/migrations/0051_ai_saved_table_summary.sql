-- ============================================================================
-- 0051 — a saved table's summary: one or two plain sentences, in the
-- person's language, saying what the table shows. The Saved tables page leads
-- with it; the description keeps the full account (what a row is, where the
-- rows come from, the rules applied) under Details. Tables saved before this
-- have none until they are replaced: the page then shows the description's
-- first sentence.
-- ============================================================================

ALTER TABLE ai_saved_tables
  ADD COLUMN summary text NOT NULL DEFAULT '' CHECK (length(summary) <= 300);
