-- ============================================================================
-- §25 — Planning (a trial): what the planners set besides hours and paces.
--
--   • planning_setup_times  — how long a machine (or every machine of a
--                             process, or every machine) stops between two
--                             item families: a changeover the engine counts.
--   • planning_maintenance  — preventive maintenance: a machine stops every
--                             so many days (or running hours) for so many
--                             hours; the engine plans around the stops.
--   • planning_learnt_machines gains the machine's pace of the last two
--     weeks against its usual one (speed_pct), to mark a machine running
--     slower than usual.
--   • planning_learnt keeps what the alerts last said (alerts_state), so a
--     condition is told once.
--
-- Planning's own tables only; nothing in the record is written.
-- ============================================================================

CREATE TABLE planning_setup_times (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_key      text CHECK (machine_key IS NULL OR btrim(machine_key) <> ''),
  process          text CHECK (process IS NULL OR process IN ('forming', 'universal', 'mast', 'welding', 'paint', 'other')),
  from_family      text NOT NULL DEFAULT '' CHECK (length(from_family) <= 60),
  to_family        text NOT NULL DEFAULT '' CHECK (length(to_family) <= 60),
  minutes          integer NOT NULL CHECK (minutes BETWEEN 0 AND 1440),
  note             text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  updated_by_id    uuid,
  updated_by_name  text NOT NULL DEFAULT '',
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT planning_setup_times_scope CHECK (machine_key IS NULL OR process IS NULL)
);
CREATE UNIQUE INDEX planning_setup_times_rule_idx ON planning_setup_times (COALESCE(machine_key, ''), COALESCE(process, ''), lower(from_family), lower(to_family));
CREATE INDEX planning_setup_times_updated_idx ON planning_setup_times (updated_at);

CREATE TABLE planning_maintenance (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_key      text NOT NULL CHECK (btrim(machine_key) <> ''),
  name             text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 120),
  every_days       integer CHECK (every_days IS NULL OR every_days BETWEEN 1 AND 3650),
  every_run_hours  numeric(8, 1) CHECK (every_run_hours IS NULL OR every_run_hours > 0),
  duration_hours   numeric(6, 2) NOT NULL CHECK (duration_hours > 0 AND duration_hours <= 240),
  last_done        date,
  start_time       text CHECK (start_time IS NULL OR start_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  note             text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  updated_by_id    uuid,
  updated_by_name  text NOT NULL DEFAULT '',
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT planning_maintenance_every CHECK (every_days IS NOT NULL OR every_run_hours IS NOT NULL)
);
CREATE INDEX planning_maintenance_machine_idx ON planning_maintenance (machine_key);
CREATE INDEX planning_maintenance_updated_idx ON planning_maintenance (updated_at);

ALTER TABLE planning_learnt_machines
  ADD COLUMN recent_pieces_per_hour numeric(14, 3),
  ADD COLUMN recent_days integer NOT NULL DEFAULT 0,
  ADD COLUMN speed_pct integer;

ALTER TABLE planning_learnt ADD COLUMN alerts_state jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(alerts_state) = 'object');

-- ---- The assistant's views -------------------------------------------------------------------------

CREATE OR REPLACE VIEW ai.planning_setup_times AS
SELECT s.id,
       s.machine_key,
       s.process,
       s.from_family,
       s.to_family,
       s.minutes,
       s.note,
       s.updated_by_name,
       s.updated_at
  FROM planning_setup_times s;
COMMENT ON VIEW ai.planning_setup_times IS 'Changeovers the plan counts: how long a machine (machine_key set), every machine of a process (process set), or every machine (both null) stops between two item families; '''' = any family. The most specific rule wins. Set by the planners under Planning → Routes & paces → Changeovers.';
COMMENT ON COLUMN ai.planning_setup_times.id IS 'The rule''s id.';
COMMENT ON COLUMN ai.planning_setup_times.machine_key IS 'The machine the rule is for, as the plans name machines (ai.machine_key(code); its name in ai.planning_machines); null for a process''s or everyone''s rule.';
COMMENT ON COLUMN ai.planning_setup_times.process IS 'The process the rule covers (forming | universal | mast | welding | paint | other); null for one machine''s or everyone''s rule.';
COMMENT ON COLUMN ai.planning_setup_times.from_family IS 'The item family the machine comes from; '''' = any.';
COMMENT ON COLUMN ai.planning_setup_times.to_family IS 'The item family it changes to; '''' = any.';
COMMENT ON COLUMN ai.planning_setup_times.minutes IS 'How long the changeover stops the machine.';
COMMENT ON COLUMN ai.planning_setup_times.note IS 'The planner''s note.';
COMMENT ON COLUMN ai.planning_setup_times.updated_by_name IS 'Who set it last.';
COMMENT ON COLUMN ai.planning_setup_times.updated_at IS 'When it was set last (indexed).';

CREATE OR REPLACE VIEW ai.planning_maintenance AS
SELECT p.id,
       p.machine_key,
       p.name,
       p.every_days,
       p.every_run_hours::float8 AS every_run_hours,
       p.duration_hours::float8 AS duration_hours,
       p.last_done,
       p.start_time,
       p.note,
       p.updated_by_name,
       p.updated_at
  FROM planning_maintenance p;
COMMENT ON VIEW ai.planning_maintenance IS 'Preventive maintenance the plan stops machines for: every so many days (every_days), or every so many running hours read as days of the machine''s own work (every_run_hours), for duration_hours, from last_done (from today when never done; one due before today is done today). Set under Planning → Calendar → Maintenance.';
COMMENT ON COLUMN ai.planning_maintenance.id IS 'The rule''s id.';
COMMENT ON COLUMN ai.planning_maintenance.machine_key IS 'The machine, as the plans name machines (ai.machine_key(code); its name in ai.planning_machines).';
COMMENT ON COLUMN ai.planning_maintenance.name IS 'What the maintenance is.';
COMMENT ON COLUMN ai.planning_maintenance.every_days IS 'Every so many days; null when by running hours.';
COMMENT ON COLUMN ai.planning_maintenance.every_run_hours IS 'Every so many running hours; null when by days.';
COMMENT ON COLUMN ai.planning_maintenance.duration_hours IS 'How long the machine stops.';
COMMENT ON COLUMN ai.planning_maintenance.last_done IS 'When it was last done; null when never.';
COMMENT ON COLUMN ai.planning_maintenance.start_time IS 'The time of day it starts, HH:MM on the factory clock; 08:00 when null.';
COMMENT ON COLUMN ai.planning_maintenance.note IS 'The planner''s note.';
COMMENT ON COLUMN ai.planning_maintenance.updated_by_name IS 'Who set it last.';
COMMENT ON COLUMN ai.planning_maintenance.updated_at IS 'When it was set last (indexed).';

-- The machines' view keeps every column it had; the recent pace comes last.
CREATE OR REPLACE VIEW ai.planning_machines AS
SELECT m.code                                  AS machine_code,
       COALESCE(NULLIF(btrim(m.display_name), ''), 'Machine ' || m.code) AS machine,
       COALESCE(btrim(m.factory), '')          AS factory,
       m.process,
       COALESCE(c.hours_per_day, l.hours_per_day, COALESCE((s.settings ->> 'defaultHoursPerDay')::numeric, 16))::float8 AS hours_per_day,
       CASE WHEN c.machine_key IS NOT NULL THEN 'set' WHEN l.hours_per_day IS NOT NULL THEN 'learnt' ELSE 'default' END AS hours_source,
       c.hours_per_day::float8                 AS set_hours_per_day,
       c.efficiency::float8                    AS set_efficiency,
       c.works_fridays                         AS set_works_fridays,
       c.note                                  AS set_note,
       l.hours_per_day::float8                 AS learnt_hours_per_day,
       l.hours_from                            AS learnt_hours_from,
       l.days_observed,
       l.efficiency::float8                    AS learnt_efficiency,
       l.efficiency_samples,
       l.works_fridays                         AS learnt_works_fridays,
       l.last_work_day,
       l.shifts,
       l.learnt_at,
       y.x IS NOT NULL                         AS on_map,
       l.recent_pieces_per_hour::float8        AS recent_pieces_per_hour,
       l.recent_days,
       l.speed_pct
  FROM machines m
  CROSS JOIN planning_settings s
  LEFT JOIN planning_machine_capacity c ON c.machine_key = ai.machine_key(m.code)
  LEFT JOIN planning_learnt_machines l ON l.machine_key = ai.machine_key(m.code)
  LEFT JOIN planning_machine_layout y ON y.machine_key = ai.machine_key(m.code)
 WHERE m.deleted_at IS NULL;
COMMENT ON COLUMN ai.planning_machines.recent_pieces_per_hour IS 'The machine''s pace over the last 14 days of the production record (median pieces an hour over its rows, any item); null with too little record.';
COMMENT ON COLUMN ai.planning_machines.recent_days IS 'Days of the last 14 the machine worked on the record.';
COMMENT ON COLUMN ai.planning_machines.speed_pct IS 'Its recent pace as a share of its usual (the last year''s): 80 = a fifth slower than usual. Null with fewer than 3 recent days. Under 80 the app marks the machine as running slower than usual.';

-- ---- The bell -----------------------------------------------------------------------

-- 'planning-alert': the automatic plan's late lines rose, or a machine is loaded past its hours (server/src/planning/alerts.ts).
ALTER TABLE user_notifications DROP CONSTRAINT user_notifications_kind;
ALTER TABLE user_notifications ADD CONSTRAINT user_notifications_kind CHECK (kind IN (
  'automation-case', 'automation-digest', 'automation-report', 'automation-stopped',
  'follow-up-assigned', 'follow-up-overdue', 'follow-up-updated',
  'task-assigned', 'task-updated', 'task-done', 'task-reopened',
  'ai-answer', 'report-shared', 'planning-alert'));

-- ---- What a kept plan remembers of the changeovers and the orders ----------------------------

ALTER TABLE planning_operations ADD COLUMN setup_minutes integer;
ALTER TABLE planning_plans ADD COLUMN orders integer, ADD COLUMN late_orders integer, ADD COLUMN setup_hours numeric(10,1);

-- The assistant's views: the new columns at the end, the contracts unchanged.
CREATE OR REPLACE VIEW ai.planning_operations AS
 SELECT o.plan_id,
    p.kind AS plan_kind,
    p.status AS plan_status,
    p.name AS plan_name,
    o.order_line_id,
    o.line_key,
    o.order_number,
    o.item_code,
    o.item,
    o.customer,
    COALESCE(m.code, o.machine_key) AS machine_code,
    COALESCE(NULLIF(btrim(m.display_name), ''), 'Machine ' || o.machine_key) AS machine,
    COALESCE(btrim(m.factory), '') AS factory,
    m.process,
    o.seq,
    o.qty::float8 AS qty,
    o.hours::float8 AS hours,
    o.duration_source,
    o.start_at,
    o.end_at,
    ai.factory_day(o.start_at) AS start_day,
    ai.factory_day(o.end_at) AS end_day,
    o.due_date,
    o.late_days,
    o.late_days > 0 AS is_late,
    o.start_at IS NOT NULL AS is_placed,
    o.depends_on,
    o.weight_kg::float8 AS weight_kg,
    o.flags,
    o.setup_minutes
   FROM planning_operations o
   JOIN planning_plans p ON p.id = o.plan_id AND p.deleted_at IS NULL
   LEFT JOIN (SELECT DISTINCT ON (ai.machine_key(x.code)) ai.machine_key(x.code) AS key, x.code, x.display_name, x.factory, x.process
                FROM machines x WHERE x.deleted_at IS NULL ORDER BY ai.machine_key(x.code), x.created_at) m ON m.key = o.machine_key;
COMMENT ON COLUMN ai.planning_operations.setup_minutes IS 'Changeover minutes counted in front of the line''s work (hours includes them), from a rule under Planning → Routes & paces → Changeovers; NULL when none. Filter on flags @> ARRAY[''changeover''] or setup_minutes > 0.';
COMMENT ON COLUMN ai.planning_operations.flags IS 'running (on its machine now, by an open inspection), rushed, moved, hypothetical (added by a scenario), changeover (set-up time counted in front of it: another family ran before it), waits-material (waits for its raw material''s promise day), assumed-hours, unknown-machine, cycle, no-capacity / beyond-horizon (not placed).';

CREATE OR REPLACE VIEW ai.planning_plans AS
 SELECT id AS plan_id,
    kind,
    name,
    description,
    status,
    base_id,
    jsonb_array_length(events) AS event_count,
    events,
    settings,
    created_by_name,
    created_via,
    created_at,
    updated_at,
    computed_at,
    computed_from,
    lines,
    placed,
    lines - placed AS unplaced,
    late,
    on_time_pct::float8 AS on_time_pct,
    late_weight_kg::float8 AS late_weight_kg,
    max_late_days,
    hours::float8 AS hours,
    assumed_hours::float8 AS assumed_hours,
    excluded_count,
    last_finish_at,
    warnings,
    published_at,
    published_by_name,
    archived_at,
    orders,
    late_orders,
    setup_hours::float8 AS setup_hours
   FROM planning_plans p
  WHERE deleted_at IS NULL;
COMMENT ON COLUMN ai.planning_plans.orders IS 'Orders the plan has lines of (each order one delivery).';
COMMENT ON COLUMN ai.planning_plans.late_orders IS 'Orders delivered late: an order ships when its last line is done, so it is late when that day falls after a due day of its lines.';
COMMENT ON COLUMN ai.planning_plans.setup_hours IS 'Hours of changeovers the plan counts (the sum of its lines'' setup_minutes).';
COMMENT ON COLUMN ai.planning_plans.settings IS 'Settings the plan changes against the planners'' (JSON): sequenceRule (erp | due | fifo), timeSource (erp-first | actual-first), overlapPct, includeHold, materialGate, dependencies, processRank, horizonDays, optimise (off | light | full), objective (late-weight-days | late-lines | late-days | order-complete: each order as one delivery, late by the day its last line is done against its lines'' due days, weighed by its whole weight), ignoreDueOlderThanDays (0 = off), costFridayMachineDay, costExtraMachineHour, costLateTonneDay (prices for the advice, 0 = not priced), useRecentSpeed (plan slow machines at their pace of the last two weeks), alertLateRise and alertOverloadPct (when the bell tells the planners; 0 = never)…';

-- The planning domain's role reads the two new views, as it reads the others of its domain (0075).
DO $$
BEGIN
  EXECUTE format('GRANT SELECT ON ai.planning_setup_times, ai.planning_maintenance TO %I', current_database() || '_ai_planning');
END $$;
