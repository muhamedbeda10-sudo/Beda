-- ============================================================================
-- 0075 — Planning (§25), a trial module: the factory's plan worked out from
-- the order sheet, the production record and the open inspections, with
-- what-if scenarios, the factories' map and what the data lacks.
--
-- It READS production_orders, production_task_records, inspection_sessions
-- and machines and writes only the tables below: no row, column, trigger or
-- index of those tables is added or changed here, so the module can be tried
-- and taken away without touching the factory's record.
--
--   • planning_settings          — one row: what the planners set of the
--                                  engine's settings (the rest is learnt).
--   • planning_calendar          — the days that are not as the week would
--                                  have them: holidays (Egypt's fixed ones are
--                                  seeded) and Fridays worked. Friday is the
--                                  day off.
--   • planning_machine_capacity  — a machine's hours a day, efficiency and
--                                  Fridays, as a planner set them.
--   • planning_rates             — a machine's pace for a family, as set.
--   • planning_machine_layout    — where each machine stands on its factory's
--                                  map (a grid of 24 × 16 cells).
--   • planning_learnt_*          — what the record says (machines' days and
--                                  paces, items' routes, the processes' order,
--                                  what the ERP's duration covers), written
--                                  whole by each refresh: a snapshot with the
--                                  time it was learnt, never the record itself.
--   • planning_plans             — the plans: the automatic one (kept as
--                                  refreshed), drafts, scenarios, the one
--                                  published; each with its events, settings
--                                  and totals. One published at a time.
--   • planning_operations        — each plan's lines placed on machines.
--
-- Machines are named by ai.machine_key(code) throughout, as the assistant's
-- views compare them. The assistant reads it all as a sixth domain,
-- 'planning', through ai.planning_* (its own role, made as 0041 made the
-- fifth); the 31 five-bit combination roles give way to the API's 63.
-- Two new permissions groups the screen and its actions (§14).
-- ============================================================================

-- ---- Settings and the calendar -------------------------------------------------------

CREATE TABLE planning_settings (
  id               boolean PRIMARY KEY DEFAULT true CHECK (id),
  settings         jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(settings) = 'object'),
  updated_by_id    uuid REFERENCES users (id),
  updated_by_name  text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 0
);
INSERT INTO planning_settings DEFAULT VALUES;

CREATE TABLE planning_calendar (
  day              date PRIMARY KEY,
  working          boolean NOT NULL,
  name             text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 120),
  -- 'seeded' = put here by this migration (Egypt's fixed holidays); 'set' = by a planner.
  source           text NOT NULL DEFAULT 'set' CHECK (source IN ('set', 'seeded')),
  updated_by_id    uuid REFERENCES users (id),
  updated_by_name  text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Egypt's fixed public holidays. The moving ones (the Eids, the Islamic New
-- Year, the Prophet's birthday, Sham El-Nessim) follow the moon or the
-- Coptic calendar and are set by the planners each year; the government
-- also moves some of these to a Thursday, which they change here.
CREATE INDEX planning_calendar_updated_idx ON planning_calendar (updated_at);

INSERT INTO planning_calendar (day, working, name, source)
SELECT make_date(y, h.m, h.d), false, h.name, 'seeded'
  FROM generate_series(2026, 2028) y
 CROSS JOIN (VALUES (1, 7, 'Coptic Christmas'), (1, 25, 'Revolution Day (25 January)'), (4, 25, 'Sinai Liberation Day'), (5, 1, 'Labour Day'),
                    (6, 30, 'June 30 Revolution'), (7, 23, 'Revolution Day (23 July)'), (10, 6, 'Armed Forces Day')) AS h(m, d, name);

-- ---- What the planners set per machine ------------------------------------------------

CREATE TABLE planning_machine_capacity (
  machine_key      text PRIMARY KEY CHECK (btrim(machine_key) <> ''),
  hours_per_day    numeric(4, 2) NOT NULL CHECK (hours_per_day BETWEEN 0 AND 24),
  -- Planned ÷ actual hours (1 = the ERP's standard); NULL = learnt from the record.
  efficiency       numeric(4, 2) CHECK (efficiency IS NULL OR efficiency BETWEEN 0.1 AND 3),
  works_fridays    boolean NOT NULL DEFAULT false,
  note             text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  updated_by_id    uuid REFERENCES users (id),
  updated_by_name  text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE planning_rates (
  machine_key      text NOT NULL CHECK (btrim(machine_key) <> ''),
  -- '' = every family on the machine.
  item_family      text NOT NULL DEFAULT '' CHECK (length(item_family) <= 60),
  pieces_per_hour  numeric(12, 3) NOT NULL CHECK (pieces_per_hour > 0),
  note             text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  updated_by_id    uuid REFERENCES users (id),
  updated_by_name  text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (machine_key, item_family)
);
CREATE INDEX planning_rates_updated_idx ON planning_rates (updated_at);

CREATE TABLE planning_machine_layout (
  machine_key      text PRIMARY KEY CHECK (btrim(machine_key) <> ''),
  x                smallint NOT NULL CHECK (x BETWEEN 0 AND 23),
  y                smallint NOT NULL CHECK (y BETWEEN 0 AND 15),
  w                smallint NOT NULL CHECK (w BETWEEN 1 AND 24),
  h                smallint NOT NULL CHECK (h BETWEEN 1 AND 16),
  updated_by_id    uuid REFERENCES users (id),
  updated_by_name  text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT planning_machine_layout_on_grid CHECK (x + w <= 24 AND y + h <= 16)
);

-- ---- What the record says (snapshots, rewritten whole by each refresh) ------------------------

CREATE TABLE planning_learnt_machines (
  machine_key         text PRIMARY KEY,
  hours_per_day       numeric(5, 2),
  hours_from          text CHECK (hours_from IN ('actual', 'planned')),
  days_observed       integer NOT NULL,
  efficiency          numeric(4, 2),
  efficiency_samples  integer NOT NULL,
  works_fridays       boolean NOT NULL,
  fridays_worked      integer NOT NULL,
  last_work_day       date,
  shifts              text[] NOT NULL DEFAULT '{}',
  learnt_at           timestamptz NOT NULL
);
CREATE INDEX planning_learnt_machines_learnt_idx ON planning_learnt_machines (learnt_at);

CREATE TABLE planning_learnt_rates (
  machine_key      text NOT NULL,
  item_code        text NOT NULL,
  item_family      text NOT NULL,
  pieces_per_hour  numeric(14, 3) NOT NULL,
  samples          integer NOT NULL,
  learnt_at        timestamptz NOT NULL,
  PRIMARY KEY (machine_key, item_code, item_family)
);
CREATE INDEX planning_learnt_rates_learnt_idx ON planning_learnt_rates (learnt_at);

CREATE TABLE planning_learnt_routes (
  item_code        text PRIMARY KEY,
  item             text NOT NULL,
  processes        text[] NOT NULL,
  steps            jsonb NOT NULL,
  orders_seen      integer NOT NULL,
  confidence_pct   integer NOT NULL,
  learnt_at        timestamptz NOT NULL
);
CREATE INDEX planning_learnt_routes_processes_idx ON planning_learnt_routes USING gin (processes);
CREATE INDEX planning_learnt_routes_learnt_idx ON planning_learnt_routes (learnt_at);

CREATE TABLE planning_learnt (
  id               boolean PRIMARY KEY DEFAULT true CHECK (id),
  process_order    jsonb,
  erp_duration     jsonb,
  learnt_at        timestamptz
);
INSERT INTO planning_learnt DEFAULT VALUES;

-- ---- Plans --------------------------------------------------------------------------------------

CREATE TABLE planning_plans (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'auto' = the automatic plan as last refreshed (one row); 'plan' = a plan to publish; 'scenario' = a what-if.
  kind                   text NOT NULL CHECK (kind IN ('auto', 'plan', 'scenario')),
  name                   text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 120),
  description            text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  status                 text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'superseded', 'archived')),
  -- The plan it was made from: another plan's id, or 'auto'.
  base_id                text,
  events                 jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(events) = 'array'),
  settings               jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(settings) = 'object'),
  created_by_id          uuid REFERENCES users (id),
  created_by_name        text NOT NULL DEFAULT '',
  created_via            text NOT NULL DEFAULT 'app' CHECK (created_via IN ('app', 'assistant')),
  ai_conversation_id     uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  -- When its operations were worked out, and the moment they start from.
  computed_at            timestamptz,
  computed_from          timestamptz,
  lines                  integer,
  placed                 integer,
  late                   integer,
  on_time_pct            numeric(5, 1),
  late_weight_kg         numeric,
  max_late_days          integer,
  hours                  numeric,
  assumed_hours          numeric,
  excluded_count         integer,
  last_finish_at         timestamptz,
  excluded               jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(excluded) = 'array'),
  warnings               jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(warnings) = 'array'),
  published_at           timestamptz,
  published_by_id        uuid REFERENCES users (id),
  published_by_name      text,
  -- When it was archived: a published plan archived stops being in force then (plan against actual).
  archived_at            timestamptz,
  version                integer NOT NULL DEFAULT 0,
  deleted_at             timestamptz,
  deleted_by_id          uuid REFERENCES users (id),
  CONSTRAINT planning_plans_auto_is_auto CHECK (kind <> 'auto' OR status = 'draft'),
  CONSTRAINT planning_plans_published_has_when CHECK (status NOT IN ('published', 'superseded') OR published_at IS NOT NULL)
);
CREATE UNIQUE INDEX planning_plans_one_auto ON planning_plans ((true)) WHERE kind = 'auto' AND deleted_at IS NULL;
CREATE UNIQUE INDEX planning_plans_one_published ON planning_plans ((true)) WHERE status = 'published' AND deleted_at IS NULL;
CREATE INDEX planning_plans_updated_idx ON planning_plans (updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX planning_plans_published_at_idx ON planning_plans (published_at) WHERE published_at IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX planning_plans_created_at_idx ON planning_plans (created_at);
-- updated_at moves when someone changes the plan (each change bumps its version), not when its lines are worked out again.
CREATE FUNCTION planning_plans_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.version IS DISTINCT FROM OLD.version THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER planning_plans_updated_at BEFORE UPDATE ON planning_plans FOR EACH ROW EXECUTE FUNCTION planning_plans_touch();
CREATE TRIGGER planning_plans_no_delete BEFORE DELETE ON planning_plans FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

-- Worked out from its plan: a draft's are written again each time it is worked out; a published plan's are kept as published.
CREATE TABLE planning_operations (
  plan_id          uuid NOT NULL REFERENCES planning_plans (id),
  -- production_orders.id as text, or "event:<id>" for an order a scenario adds.
  line_id          text NOT NULL,
  order_line_id    uuid,
  line_key         text NOT NULL,
  order_number     text NOT NULL,
  item_code        text NOT NULL,
  item             text NOT NULL,
  customer         text NOT NULL,
  machine_key      text NOT NULL,
  seq              integer NOT NULL,
  qty              numeric NOT NULL,
  hours            numeric NOT NULL,
  duration_source  text NOT NULL,
  start_at         timestamptz,
  end_at           timestamptz,
  due_date         date,
  late_days        integer NOT NULL DEFAULT 0,
  depends_on       text[] NOT NULL DEFAULT '{}',
  weight_kg        numeric,
  flags            text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (plan_id, line_id)
);
CREATE INDEX planning_operations_machine_idx ON planning_operations (plan_id, machine_key, seq);
CREATE INDEX planning_operations_start_idx ON planning_operations (start_at);
CREATE INDEX planning_operations_end_idx ON planning_operations (end_at);
CREATE INDEX planning_operations_line_key_idx ON planning_operations (lower(line_key) text_pattern_ops);
CREATE INDEX planning_operations_order_line_idx ON planning_operations (order_line_id);

-- ---- Permissions (§14) ---------------------------------------------------------------------------
-- The screen and its actions; administrators hold them as they hold every permission. Nobody else does until given.

INSERT INTO permissions (id) VALUES ('view-planning'), ('edit-planning'), ('publish-plan'), ('manage-planning-setup');
INSERT INTO role_permissions (role, permission)
SELECT 'admin'::user_role, p FROM unnest(ARRAY['view-planning', 'edit-planning', 'publish-plan', 'manage-planning-setup']) AS p;

-- ---- The sixth domain ------------------------------------------------------------------------------
-- Rows already there keep the domains they have: nobody gets the new one silently.

ALTER TABLE ai_access DROP CONSTRAINT ai_access_domains;
ALTER TABLE ai_access ADD CONSTRAINT ai_access_domains CHECK (
  domains <@ ARRAY['inspection', 'orders', 'materials', 'audit', 'production', 'planning']::text[] AND array_position(domains, NULL) IS NULL
);

-- ---- What the assistant reads -------------------------------------------------------------------------
-- The machine of a key, once: the register's earliest active machine with that key (two codes such as "024" and
-- "24" are one machine), read whole once per query and joined by key.

CREATE OR REPLACE VIEW ai.planning_plans AS
SELECT p.id                          AS plan_id,
       p.kind,
       p.name,
       p.description,
       p.status,
       p.base_id,
       jsonb_array_length(p.events)  AS event_count,
       p.events,
       p.settings,
       p.created_by_name,
       p.created_via,
       p.created_at,
       p.updated_at,
       p.computed_at,
       p.computed_from,
       p.lines,
       p.placed,
       p.lines - p.placed            AS unplaced,
       p.late,
       p.on_time_pct::float8         AS on_time_pct,
       p.late_weight_kg::float8      AS late_weight_kg,
       p.max_late_days,
       p.hours::float8               AS hours,
       p.assumed_hours::float8       AS assumed_hours,
       p.excluded_count,
       p.last_finish_at,
       p.warnings,
       p.published_at,
       p.published_by_name,
       p.archived_at
  FROM planning_plans p
 WHERE p.deleted_at IS NULL;
COMMENT ON VIEW ai.planning_plans IS 'The planning module''s plans (a trial): one row per plan. kind auto = the automatic plan, worked out from the order sheet, the production record and the open inspections as they were at computed_at (refreshed every half hour; the latest projection of when each line will be made); plan = a plan planners make to publish; scenario = a what-if (its events say what it changes). status published = the factory''s plan now (at most one); superseded = published before; draft; archived. The lines of each are in ai.planning_operations (join on plan_id). Totals are as of computed_at.';
COMMENT ON COLUMN ai.planning_plans.plan_id IS 'The plan''s id = ai.planning_operations.plan_id.';
COMMENT ON COLUMN ai.planning_plans.kind IS 'auto | plan | scenario. For "when will order X be made" use the published plan if there is one, else the auto plan, and say which.';
COMMENT ON COLUMN ai.planning_plans.status IS 'draft | published (the factory''s plan now; at most one) | superseded (published before, replaced) | archived. The auto plan is always draft.';
COMMENT ON COLUMN ai.planning_plans.base_id IS 'The plan a scenario was made from: another plan_id, or ''auto''. Compare a scenario with it line by line through ai.planning_operations.';
COMMENT ON COLUMN ai.planning_plans.events IS 'What the plan changes against the data, as a JSON array of events, each with a type: machine-down (machineKey, from, to), capacity (machineKey, fromDay, toDay, hoursPerDay), working-day (day, working, machineKey?), speed (machineKey, speedPct), move (lineKey, toMachineKey), priority (lineKey | orderNumber | customer), not-before (lineKey, at), material (lineKey | orderNumber, availableDay), exclude (lineKey | orderNumber), due (lineKey | orderNumber, dueDate), quantity (lineKey, remainingQty), add-order (orderNumber, item, customer, machineKey, qty, hours, dueDate). machineKey = ai.machine_key(machine code); lineKey = the line''s Order ID; times are the factory''s clock.';
COMMENT ON COLUMN ai.planning_plans.settings IS 'Settings the plan changes against the planners'' (JSON): sequenceRule (erp | due | fifo), timeSource (erp-first | actual-first), overlapPct, includeHold, materialGate, dependencies, processRank…';
COMMENT ON COLUMN ai.planning_plans.created_via IS 'app = made by a person in the app; assistant = made by the AI assistant at someone''s word (a suggestion until a planner publishes it).';
COMMENT ON COLUMN ai.planning_plans.computed_at IS 'When its lines were last worked out; computed_from is the moment they start from (nothing is placed before it).';
COMMENT ON COLUMN ai.planning_plans.lines IS 'Order lines in the plan (open, not cancelled, not held unless settings say so); placed = given a time on a machine, unplaced = could not be (no working time in the horizon).';
COMMENT ON COLUMN ai.planning_plans.late IS 'Placed lines finishing after their due day (a factory day ends 08:00 the next morning); on_time_pct = on time ÷ placed lines with a due date × 100.';
COMMENT ON COLUMN ai.planning_plans.late_weight_kg IS 'Weight still to make of the late lines, kg.';
COMMENT ON COLUMN ai.planning_plans.hours IS 'Machine hours of all its lines; assumed_hours = of them, hours of lines with no duration to go by (the default was used).';
COMMENT ON COLUMN ai.planning_plans.excluded_count IS 'Open lines left out (held, no machine, left out by an event).';
COMMENT ON COLUMN ai.planning_plans.last_finish_at IS 'When its last line finishes.';
COMMENT ON COLUMN ai.planning_plans.name IS 'The plan''s name as its maker gave it ("Automatic plan" for the auto one).';
COMMENT ON COLUMN ai.planning_plans.description IS 'What it is for, in its maker''s words; for one the assistant kept, what it tries and found.';
COMMENT ON COLUMN ai.planning_plans.event_count IS 'How many changes (events) it makes against the data.';
COMMENT ON COLUMN ai.planning_plans.created_by_name IS 'Who made it (the person the assistant made it for, when created_via = assistant).';
COMMENT ON COLUMN ai.planning_plans.created_at IS 'When it was made.';
COMMENT ON COLUMN ai.planning_plans.updated_at IS 'When someone last changed it (its name, events, settings or state); working its lines out again does not move it.';
COMMENT ON COLUMN ai.planning_plans.computed_from IS 'The moment its lines start from: nothing is placed before it.';
COMMENT ON COLUMN ai.planning_plans.placed IS 'Lines given a time on a machine.';
COMMENT ON COLUMN ai.planning_plans.unplaced IS 'Lines it could not place (no working time in the horizon).';
COMMENT ON COLUMN ai.planning_plans.on_time_pct IS 'On-time lines ÷ placed lines with a due date × 100; NULL when none has a due date.';
COMMENT ON COLUMN ai.planning_plans.max_late_days IS 'The most days any of its lines is late.';
COMMENT ON COLUMN ai.planning_plans.assumed_hours IS 'Machine hours of lines with no duration to go by (the default hours were used).';
COMMENT ON COLUMN ai.planning_plans.published_at IS 'When it was published (published and superseded plans). It was the factory''s plan from then until the next publish or its archived_at.';
COMMENT ON COLUMN ai.planning_plans.published_by_name IS 'Who published it.';
COMMENT ON COLUMN ai.planning_plans.archived_at IS 'When it was archived; NULL if never.';
COMMENT ON COLUMN ai.planning_plans.warnings IS 'What the engine could not use (an event naming a line it does not know…), as a JSON array of sentences.';

CREATE OR REPLACE VIEW ai.planning_operations AS
SELECT o.plan_id,
       p.kind                             AS plan_kind,
       p.status                           AS plan_status,
       p.name                             AS plan_name,
       o.order_line_id,
       o.line_key,
       o.order_number,
       o.item_code,
       o.item,
       o.customer,
       COALESCE(m.code, o.machine_key)    AS machine_code,
       COALESCE(NULLIF(btrim(m.display_name), ''), 'Machine ' || o.machine_key) AS machine,
       COALESCE(btrim(m.factory), '')     AS factory,
       m.process,
       o.seq,
       o.qty::float8                      AS qty,
       o.hours::float8                    AS hours,
       o.duration_source,
       o.start_at,
       o.end_at,
       ai.factory_day(o.start_at)         AS start_day,
       ai.factory_day(o.end_at)           AS end_day,
       o.due_date,
       o.late_days,
       o.late_days > 0                    AS is_late,
       o.start_at IS NOT NULL             AS is_placed,
       o.depends_on,
       o.weight_kg::float8                AS weight_kg,
       o.flags
  FROM planning_operations o
  JOIN planning_plans p ON p.id = o.plan_id AND p.deleted_at IS NULL
  LEFT JOIN (SELECT DISTINCT ON (ai.machine_key(x.code)) ai.machine_key(x.code) AS key, x.code, x.display_name, x.factory, x.process
               FROM machines x WHERE x.deleted_at IS NULL
              ORDER BY ai.machine_key(x.code), x.created_at) m ON m.key = o.machine_key;
COMMENT ON VIEW ai.planning_operations IS 'Each plan''s order lines placed on machines: one row per (plan, order line). Filter on plan_id (or plan_kind / plan_status) first: the same line is in every plan. The line runs on its machine from start_at to end_at, pausing outside working time (a machine works its hours a day from 08:00, not on Fridays or holidays: ai.planning_calendar, ai.planning_machines); seq is its place in the machine''s queue. Order lines join ai.order_lines on order_line_id (or line_key) when you can read it.';
COMMENT ON COLUMN ai.planning_operations.plan_id IS 'The plan it belongs to = ai.planning_plans.plan_id. Filter on it first.';
COMMENT ON COLUMN ai.planning_operations.plan_kind IS 'The plan''s kind: auto | plan | scenario.';
COMMENT ON COLUMN ai.planning_operations.plan_status IS 'The plan''s state: draft | published | superseded | archived.';
COMMENT ON COLUMN ai.planning_operations.plan_name IS 'The plan''s name.';
COMMENT ON COLUMN ai.planning_operations.order_number IS 'The order number; it repeats across the order''s lines.';
COMMENT ON COLUMN ai.planning_operations.item_code IS 'The item''s code ('''' for an order a scenario adds).';
COMMENT ON COLUMN ai.planning_operations.item IS 'The item''s name.';
COMMENT ON COLUMN ai.planning_operations.customer IS 'The customer.';
COMMENT ON COLUMN ai.planning_operations.machine IS 'The machine''s display name from the register, else "Machine <code>".';
COMMENT ON COLUMN ai.planning_operations.factory IS 'The machine''s factory from the register; '''' when not known.';
COMMENT ON COLUMN ai.planning_operations.seq IS 'Its place in the machine''s queue in this plan (1 = first).';
COMMENT ON COLUMN ai.planning_operations.duration_source IS 'Where hours came from: running | erp | rate-item | rate-family | rate-machine | set-rate | event | assumed.';
COMMENT ON COLUMN ai.planning_operations.end_at IS 'When it finishes; NULL when not placed.';
COMMENT ON COLUMN ai.planning_operations.end_day IS 'The factory day it finishes on.';
COMMENT ON COLUMN ai.planning_operations.is_late IS 'late_days > 0.';
COMMENT ON COLUMN ai.planning_operations.is_placed IS 'It was given a time (start_at is not NULL).';
COMMENT ON COLUMN ai.planning_operations.order_line_id IS 'ai.order_lines.order_line_id of the line; NULL for an order a scenario adds (line_key "NEW-…").';
COMMENT ON COLUMN ai.planning_operations.line_key IS 'The line''s Order ID (ai.order_lines.line_key).';
COMMENT ON COLUMN ai.planning_operations.machine_code IS 'The machine''s code (= ai.machines.machine_code); in a scenario, the machine a line was moved to.';
COMMENT ON COLUMN ai.planning_operations.process IS 'The machine''s process (forming | welding | paint | universal | mast | other); NULL when the machine is not in the register.';
COMMENT ON COLUMN ai.planning_operations.qty IS 'Pieces it still has to make (what is left of the line when the plan was worked out).';
COMMENT ON COLUMN ai.planning_operations.hours IS 'Machine hours the plan gives it; duration_source says where they came from: running (on the machine now), erp (the ERP''s part duration), rate-item / rate-family / rate-machine (the machine''s pace on the production record), set-rate (a pace a planner set), event (a scenario''s own), assumed (nothing to go by: the default).';
COMMENT ON COLUMN ai.planning_operations.start_at IS 'When it starts; NULL when the plan could not place it (flags say why). Filter periods on start_at / end_at (indexed).';
COMMENT ON COLUMN ai.planning_operations.start_day IS 'The factory day it starts on; end_day the one it finishes on.';
COMMENT ON COLUMN ai.planning_operations.due_date IS 'Its due day (the ERP''s, or a scenario''s).';
COMMENT ON COLUMN ai.planning_operations.late_days IS 'Whole days it finishes after its due day ends (08:00 the next morning); 0 = on time or no due day. is_late = late_days > 0.';
COMMENT ON COLUMN ai.planning_operations.depends_on IS 'The lines (line keys) it waits for: an earlier process of the same item in the same order, or the lines whose parent it is.';
COMMENT ON COLUMN ai.planning_operations.weight_kg IS 'The weight it still has to make, kg.';
COMMENT ON COLUMN ai.planning_operations.flags IS 'running (on its machine now, by an open inspection), rushed, moved, hypothetical (added by a scenario), waits-material (waits for its raw material''s promise day), assumed-hours, unknown-machine, cycle, no-capacity / beyond-horizon (not placed).';

CREATE OR REPLACE VIEW ai.planning_calendar AS
SELECT c.day,
       c.working,
       c.name,
       c.source,
       extract(isodow FROM c.day)::int = 5 AS is_friday,
       c.updated_by_name,
       c.updated_at
  FROM planning_calendar c;
COMMENT ON COLUMN ai.planning_calendar.day IS 'The day (a date).';
COMMENT ON COLUMN ai.planning_calendar.working IS 'true = worked (a Friday worked); false = a holiday.';
COMMENT ON COLUMN ai.planning_calendar.name IS 'What the day is ("Labour Day", "Friday worked for order 24105").';
COMMENT ON COLUMN ai.planning_calendar.source IS 'seeded = Egypt''s fixed holidays, put in with the module; set = by a planner.';
COMMENT ON COLUMN ai.planning_calendar.is_friday IS 'The day is a Friday (the weekly day off).';
COMMENT ON COLUMN ai.planning_calendar.updated_by_name IS 'Who set it; NULL for a seeded one.';
COMMENT ON COLUMN ai.planning_calendar.updated_at IS 'When it was set.';
COMMENT ON VIEW ai.planning_calendar IS 'The planning calendar''s exceptions: every day not listed is a working day except Friday, the day off. working = false: a holiday (Egypt''s fixed ones are seeded, source seeded; the moving ones are set by the planners); working = true on a Friday: a Friday worked.';

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
       y.x IS NOT NULL                         AS on_map
  FROM machines m
  CROSS JOIN planning_settings s
  LEFT JOIN planning_machine_capacity c ON c.machine_key = ai.machine_key(m.code)
  LEFT JOIN planning_learnt_machines l ON l.machine_key = ai.machine_key(m.code)
  LEFT JOIN planning_machine_layout y ON y.machine_key = ai.machine_key(m.code)
 WHERE m.deleted_at IS NULL;
COMMENT ON VIEW ai.planning_machines IS 'Each machine of the register as planning sees it: the hours it works in a working day (from 08:00) and where that figure comes from - set by a planner, learnt from the production record (the median of the hours its rows add up to on the days it worked, last 120 days), or the default.';
COMMENT ON COLUMN ai.planning_machines.machine_code IS 'The machine''s code = ai.machines.machine_code.';
COMMENT ON COLUMN ai.planning_machines.machine IS 'The machine''s display name.';
COMMENT ON COLUMN ai.planning_machines.factory IS 'Its factory ('''' when not set).';
COMMENT ON COLUMN ai.planning_machines.process IS 'Its process: forming | welding | paint | universal | mast | other.';
COMMENT ON COLUMN ai.planning_machines.hours_source IS 'set | learnt | default: where hours_per_day comes from.';
COMMENT ON COLUMN ai.planning_machines.set_hours_per_day IS 'Hours a day a planner set; NULL when none.';
COMMENT ON COLUMN ai.planning_machines.set_efficiency IS 'Efficiency a planner set (planned ÷ actual hours); NULL = learnt.';
COMMENT ON COLUMN ai.planning_machines.set_works_fridays IS 'A planner set it to work Fridays; NULL when nothing set.';
COMMENT ON COLUMN ai.planning_machines.set_note IS 'The planner''s note on what they set.';
COMMENT ON COLUMN ai.planning_machines.learnt_hours_per_day IS 'Hours a day learnt from the production record; NULL with fewer than 5 days.';
COMMENT ON COLUMN ai.planning_machines.learnt_hours_from IS 'actual = from actual_hours; planned = from planned hours where the actual were not recorded.';
COMMENT ON COLUMN ai.planning_machines.efficiency_samples IS 'Production rows the learnt efficiency rests on.';
COMMENT ON COLUMN ai.planning_machines.last_work_day IS 'Its last work_day on the production record.';
COMMENT ON COLUMN ai.planning_machines.learnt_at IS 'When this was learnt (every six hours).';
COMMENT ON COLUMN ai.planning_machines.hours_per_day IS 'Hours a working day the plan gives the machine: set_hours_per_day, else learnt_hours_per_day, else the default (hours_source says which).';
COMMENT ON COLUMN ai.planning_machines.learnt_efficiency IS 'Planned ÷ actual hours on its production rows (1 = it works at the ERP''s standard; 0.8 = it takes a quarter longer). NULL with fewer than 5 rows.';
COMMENT ON COLUMN ai.planning_machines.learnt_works_fridays IS 'It worked at least half the Fridays of the span (and four or more): the plan then works it on Fridays.';
COMMENT ON COLUMN ai.planning_machines.days_observed IS 'Days it worked in the last 120, on the production record.';
COMMENT ON COLUMN ai.planning_machines.shifts IS 'Shift names on its production rows, most used first.';
COMMENT ON COLUMN ai.planning_machines.on_map IS 'It has been placed on its factory''s map.';

CREATE OR REPLACE VIEW ai.planning_rates AS
SELECT COALESCE(m.code, r.machine_key) AS machine_code,
       COALESCE(NULLIF(btrim(m.display_name), ''), 'Machine ' || r.machine_key) AS machine,
       r.item_code,
       r.item_family,
       r.pieces_per_hour::float8 AS pieces_per_hour,
       r.samples,
       r.source,
       r.note,
       r.at
  FROM (SELECT machine_key, item_code, item_family, pieces_per_hour, samples, 'learnt'::text AS source, ''::text AS note, learnt_at AS at FROM planning_learnt_rates
        UNION ALL
        SELECT machine_key, '', item_family, pieces_per_hour, 0, 'set', note, updated_at FROM planning_rates) r
  LEFT JOIN (SELECT DISTINCT ON (ai.machine_key(x.code)) ai.machine_key(x.code) AS key, x.code, x.display_name
               FROM machines x WHERE x.deleted_at IS NULL
              ORDER BY ai.machine_key(x.code), x.created_at) m ON m.key = r.machine_key;
COMMENT ON VIEW ai.planning_rates IS 'Pieces an hour each machine makes: learnt from the production record (source learnt: the median of its rows'' produced_qty ÷ actual_hours, by item_code, by item_family, or for the machine when both are '''') or set by a planner for a family (source set, item_code ''''). A set rate wins; then, as the settings say, the ERP''s duration or the learnt rate.';
COMMENT ON COLUMN ai.planning_rates.machine_code IS 'The machine''s code = ai.machines.machine_code.';
COMMENT ON COLUMN ai.planning_rates.machine IS 'The machine''s display name.';
COMMENT ON COLUMN ai.planning_rates.item_code IS 'The item the pace is for (lower case); '''' = a family''s or the machine''s pace.';
COMMENT ON COLUMN ai.planning_rates.item_family IS 'The family the pace is for (lower case); '''' = the item''s or the machine''s pace.';
COMMENT ON COLUMN ai.planning_rates.pieces_per_hour IS 'Finished pieces an hour.';
COMMENT ON COLUMN ai.planning_rates.source IS 'learnt (from the production record) | set (by a planner).';
COMMENT ON COLUMN ai.planning_rates.note IS 'The planner''s note on a set pace.';
COMMENT ON COLUMN ai.planning_rates.samples IS 'Production rows the learnt rate rests on (0 for a set one).';
COMMENT ON COLUMN ai.planning_rates.at IS 'When it was learnt or set (each part is indexed underneath; the table is small).';

CREATE OR REPLACE VIEW ai.planning_item_routes AS
SELECT r.item_code,
       r.item,
       r.processes,
       r.steps,
       r.orders_seen,
       r.confidence_pct,
       r.learnt_at
  FROM planning_learnt_routes r;
COMMENT ON VIEW ai.planning_item_routes IS 'Each item''s way through the factory, learnt from the order sheet: the processes its order lines run on, in the order the factory works them (processes), with the machines seen at each (steps, JSON: [{process, machines: [{machineKey, lines}]}]). confidence_pct = share of its orders on which it took these processes. Filter processes with @> (e.g. processes @> ARRAY[''paint'']).';

COMMENT ON COLUMN ai.planning_item_routes.item_code IS 'The item''s code (lower case) = lower(ai.order_lines.item_code).';
COMMENT ON COLUMN ai.planning_item_routes.item IS 'The item''s name.';
COMMENT ON COLUMN ai.planning_item_routes.processes IS 'Its processes in the order the factory works them, e.g. {forming,welding,paint}.';
COMMENT ON COLUMN ai.planning_item_routes.steps IS 'JSON: [{process, machines: [{machineKey, lines}]}], each step''s machines most used first (machineKey = ai.machine_key(code)).';
COMMENT ON COLUMN ai.planning_item_routes.orders_seen IS 'Orders the item was seen on.';
COMMENT ON COLUMN ai.planning_item_routes.confidence_pct IS 'Share of those orders on which it took its usual processes.';
COMMENT ON COLUMN ai.planning_item_routes.learnt_at IS 'When it was learnt.';

-- ---- The domain role, and the retirement of the five-bit combinations ----------------------------------
-- As 0041: one role without LOGIN holding exactly the domain's views. The
-- combinations the API signs in as are its own to make at start, so the
-- thirty-one five-bit ones are taken back and dropped here.

DO $$
DECLARE
  db   text := current_database();
  role text := current_database() || '_ai_planning';
  old  text;
  i    int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role) THEN
    BEGIN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', role);
    EXCEPTION WHEN duplicate_object THEN
      NULL; -- another instance created it a moment ago
    END;
  END IF;
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA ai FROM %I', role);
  EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ai FROM %I', role);
  EXECUTE format('REVOKE ALL ON SCHEMA ai FROM %I', role);
  EXECUTE format('GRANT SELECT ON ai.planning_plans, ai.planning_operations, ai.planning_calendar, ai.planning_machines, ai.planning_rates, ai.planning_item_routes TO %I', role);

  FOR i IN 1..31 LOOP
    old := db || '_ai_r_' || (i::bit(5))::text;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = old) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA ai FROM %I', old);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ai FROM %I', old);
      EXECUTE format('REVOKE ALL ON SCHEMA ai FROM %I', old);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA ai REVOKE ALL ON TABLES FROM %I', old);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA ai REVOKE ALL ON FUNCTIONS FROM %I', old);
      BEGIN
        EXECUTE format('DROP ROLE %I', old);
      EXCEPTION WHEN dependent_objects_still_exist THEN
        EXECUTE format('ALTER ROLE %I NOLOGIN', old);
        RAISE NOTICE 'Role % is still referenced; it was left without LOGIN.', old;
      END;
    END IF;
  END LOOP;
END $$;
