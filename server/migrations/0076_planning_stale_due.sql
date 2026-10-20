-- ============================================================================
-- §25 — Planning (a trial): a setting to leave out lines whose due day is
-- long past (ignoreDueOlderThanDays, 0 = off), and a line's reason for being
-- left out can now be 'stale'. Settings are JSON, so no table changes: only
-- the assistant's data dictionary (the column comments) says the new words.
-- ============================================================================

COMMENT ON COLUMN ai.planning_plans.settings IS 'Settings the plan changes against the planners'' (JSON): sequenceRule (erp | due | fifo), timeSource (erp-first | actual-first), overlapPct, includeHold, materialGate, dependencies, processRank, horizonDays, optimise (off | light | full), objective (late-weight-days | late-lines | late-days), ignoreDueOlderThanDays (0 = off)…';
COMMENT ON COLUMN ai.planning_plans.excluded_count IS 'Open lines left out: done, cancelled, held (hold), a STOCK order, no machine (no-machine), left out by an event (excluded), or a due day older than the settings allow (stale).';
