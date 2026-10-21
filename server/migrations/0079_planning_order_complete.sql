-- ============================================================================
-- §25 — Planning (a trial): the optimiser's objective gains 'order-complete'
-- (each order as one delivery, late by its last line, weighed by its whole
-- weight). Settings are JSON: only the assistant's data dictionary changes.
-- ============================================================================

COMMENT ON COLUMN ai.planning_plans.settings IS 'Settings the plan changes against the planners'' (JSON): sequenceRule (erp | due | fifo), timeSource (erp-first | actual-first), overlapPct, includeHold, materialGate, dependencies, processRank, horizonDays, optimise (off | light | full), objective (late-weight-days | late-lines | late-days | order-complete: each order as one delivery, late by its last line, weighed by its whole weight), ignoreDueOlderThanDays (0 = off), costFridayMachineDay, costExtraMachineHour, costLateTonneDay (prices for the advice, 0 = not priced)…';
