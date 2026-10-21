-- ============================================================================
-- §25 — Planning (a trial): a delivery date for a customer. An item's weight
-- a piece is learnt beside its route (kg_per_piece), so an order not on the
-- sheet yet weighs what it will; the plans' events gain 'new-order' (an
-- order by its items), the settings three prices for the advice. Planning's
-- own tables only; the record is not touched.
-- ============================================================================

ALTER TABLE planning_learnt_routes ADD COLUMN kg_per_piece numeric(12, 3);

CREATE OR REPLACE VIEW ai.planning_item_routes AS
SELECT r.item_code,
       r.item,
       r.processes,
       r.steps,
       r.orders_seen,
       r.confidence_pct,
       r.learnt_at,
       r.kg_per_piece
  FROM planning_learnt_routes r;
COMMENT ON COLUMN ai.planning_item_routes.kg_per_piece IS 'The item''s weight a piece in kg, the median over its order lines that carry a weight; null when none does. An order''s weight = kg_per_piece × pieces.';

COMMENT ON COLUMN ai.planning_plans.events IS 'What the plan changes against the data, as a JSON array of events, each with a type: machine-down (machineKey, from, to), capacity (machineKey, fromDay, toDay, hoursPerDay), working-day (day, working, machineKey?), speed (machineKey, speedPct), move (lineKey, toMachineKey), priority (lineKey | orderNumber | customer), not-before (lineKey, at), material (lineKey | orderNumber, availableDay), exclude (lineKey | orderNumber), due (lineKey | orderNumber, dueDate), quantity (lineKey, remainingQty), add-order (orderNumber, item, customer, machineKey, qty, hours, dueDate), new-order (orderNumber, customer, dueDate, rush?, items: [{itemCode, qty, item?, weightKg?, steps?: [{machineKey, hours?}]}] — an order not on the sheet yet, planned through each item''s learnt route and pace). machineKey = ai.machine_key(machine code); lineKey = the line''s Order ID; times are the factory''s clock.';
COMMENT ON COLUMN ai.planning_plans.settings IS 'Settings the plan changes against the planners'' (JSON): sequenceRule (erp | due | fifo), timeSource (erp-first | actual-first), overlapPct, includeHold, materialGate, dependencies, processRank, horizonDays, optimise (off | light | full), objective (late-weight-days | late-lines | late-days), ignoreDueOlderThanDays (0 = off), costFridayMachineDay, costExtraMachineHour, costLateTonneDay (prices for the advice, 0 = not priced)…';
