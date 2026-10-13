-- ============================================================================
-- 0053 — a saved table changed in place: its title, summary, description,
-- column notes or schedule, without computing it again (update_saved_table,
-- server/src/ai/savedTables.ts). Its rows and its version stay; the history
-- keeps what was changed as the change's definition. A change to its query
-- or its rows is still a replace, computed at once, the version one up.
-- ============================================================================

ALTER TABLE ai_saved_table_changes
  DROP CONSTRAINT ai_saved_table_changes_action_check,
  ADD CONSTRAINT ai_saved_table_changes_action_check CHECK (action IN ('create', 'replace', 'update', 'refresh', 'remove')),
  DROP CONSTRAINT ai_saved_table_changes_definition,
  ADD CONSTRAINT ai_saved_table_changes_definition CHECK ((action IN ('create', 'replace', 'update')) = (definition IS NOT NULL));
