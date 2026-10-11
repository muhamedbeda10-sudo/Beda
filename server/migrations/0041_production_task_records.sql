-- ============================================================================
-- 0041 — the ERP's production task record (§24): the production written
-- against the order sheet, and the assistant's fifth data domain.
--   • production_task_records — one row per DAY'S WORK (a shift, or a stage)
--     on one ORDER LINE, as the ERP's "Production Task Record" exports it; a
--     line often has two rows on the same day. The order sheet
--     (production_orders, planning's table: one row per order line with its
--     Order ID = line_key) is the MASTER; this record is its CHILD: the file's
--     ID column is that same Order ID, repeated on every row of the line,
--     and the two are joined on line_key, without regard to case,
--     as the sheet itself is matched. No foreign key: a record may arrive
--     before its line, or outlive a line removed from the sheet. The business
--     key is (line_key, erp_record_id): the ERP's record id alone repeats
--     across order lines. An administrator imports the export, in batches,
--     idempotently; nothing else in the app writes a row. A wrong import is
--     retired (soft delete, audited) and the file imported again, which
--     brings the retired rows back.
--   • ai_access may name the domain 'production'. No existing row gains it:
--     the owner grants it, person by person, themselves included.
--   • ai.production_task_records — the view the assistant reads, with the
--     order line it belongs to joined on, held by the new domain role
--     <database>_ai_production, made exactly as 0033 made the others.
--   • The combination roles the API signs in as become five-bit: the fifteen
--     four-bit ones (<database>_ai_r_0001 … _ai_r_1111) are retired here;
--     the API creates the thirty-one at start (server/src/ai/reader.ts).
-- ============================================================================

-- ---- The record ---------------------------------------------------------------------

CREATE TABLE production_task_records (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The order sheet's Order ID (production_orders.line_key): the column the two tables are joined on.
  line_key           text NOT NULL,
  -- The ERP's own record id; it repeats across order lines, so only the pair names a row.
  erp_record_id      text NOT NULL,
  -- The ERP's PLANNING week of the task as written ("01/2026" = week/year, the same on every row of
  -- the line, not the week of the work), and the two numbers when it parses.
  week               text NOT NULL DEFAULT '',
  week_no            smallint,
  week_year          smallint,
  order_number       text NOT NULL DEFAULT '',
  item               text NOT NULL DEFAULT '',
  colour             text NOT NULL DEFAULT '',
  -- Finished pieces made that day (0 on a stage row of a staged line). required_qty is the task's whole
  -- requirement, repeated on every row of the line.
  produced_qty       numeric(14, 3),
  required_qty       numeric(14, 3),
  -- Up to four people on the machine that day, as the ERP names them.
  worker_1           text NOT NULL DEFAULT '',
  worker_2           text NOT NULL DEFAULT '',
  worker_3           text NOT NULL DEFAULT '',
  worker_4           text NOT NULL DEFAULT '',
  -- "Day1", "Day2"… as a number (the ERP's numbering of the line's rows; two may share a day), and the
  -- day itself when the ERP wrote one.
  day_no             smallint,
  work_day           date,
  work_center_code   text NOT NULL DEFAULT '',
  -- Hours: the ERP's planned duration of the WHOLE task (repeated on every row of the line), its "Planned
  -- time" for this row (duration × produced_qty / required_qty), and the time taken (null = not recorded).
  duration_hours     numeric(10, 3),
  planned_hours      numeric(10, 3),
  actual_hours       numeric(10, 3),
  -- Staged (universal) lines: the stage and the pieces that passed it that day (such a row's produced_qty is 0);
  -- blank or 0 elsewhere.
  stage_no           smallint,
  stage_qty          numeric(14, 3),
  remarks            text NOT NULL DEFAULT '',
  length_mm          numeric(12, 3),
  width_mm           numeric(12, 3),
  thickness_mm       numeric(8, 3),
  shift              text NOT NULL DEFAULT '',
  -- The ERP's own name for the machine ("Roll Forming Line C2792015").
  resource           text NOT NULL DEFAULT '',
  -- The WHOLE task's weight (repeated on every row of the line), then what this day made: its weight and length.
  weight_kg          numeric(14, 3),
  produced_weight_kg numeric(14, 3),
  produced_length_m  numeric(14, 3),
  -- The last import that touched the row.
  imported_at        timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  deleted_by_id      uuid REFERENCES users (id),
  CONSTRAINT production_task_records_keys_not_blank CHECK (btrim(line_key) <> '' AND btrim(erp_record_id) <> ''),
  CONSTRAINT production_task_records_qty_nonnegative CHECK (
    (produced_qty IS NULL OR produced_qty >= 0) AND (required_qty IS NULL OR required_qty >= 0) AND (stage_qty IS NULL OR stage_qty >= 0)
  ),
  CONSTRAINT production_task_records_hours_nonnegative CHECK (
    (duration_hours IS NULL OR duration_hours >= 0) AND (planned_hours IS NULL OR planned_hours >= 0) AND (actual_hours IS NULL OR actual_hours >= 0)
  ),
  CONSTRAINT production_task_records_sizes_nonnegative CHECK (
    (length_mm IS NULL OR length_mm >= 0) AND (width_mm IS NULL OR width_mm >= 0) AND (thickness_mm IS NULL OR thickness_mm >= 0)
  ),
  CONSTRAINT production_task_records_weights_nonnegative CHECK (
    (weight_kg IS NULL OR weight_kg >= 0) AND (produced_weight_kg IS NULL OR produced_weight_kg >= 0) AND (produced_length_m IS NULL OR produced_length_m >= 0)
  ),
  CONSTRAINT production_task_records_day_no_nonnegative CHECK (day_no IS NULL OR day_no >= 0),
  CONSTRAINT production_task_records_stage_no_nonnegative CHECK (stage_no IS NULL OR stage_no >= 0)
);
-- The business key, matched without regard to case like the order sheet's line key (the import's ON CONFLICT target).
CREATE UNIQUE INDEX production_task_records_key ON production_task_records (lower(line_key), lower(erp_record_id));
-- The join to production_orders.line_key, which is indexed the same way (text_pattern_ops serves equality and prefixes alike).
CREATE INDEX production_task_records_line_key_idx ON production_task_records (lower(line_key) text_pattern_ops);
CREATE INDEX production_task_records_work_day_idx ON production_task_records (work_day);
CREATE INDEX production_task_records_machine_day_idx ON production_task_records (work_center_code, work_day);
CREATE INDEX production_task_records_order_number_idx ON production_task_records (lower(order_number));
CREATE TRIGGER production_task_records_updated_at BEFORE UPDATE ON production_task_records FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER production_task_records_no_delete BEFORE DELETE ON production_task_records FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

-- ---- The fifth domain ----------------------------------------------------------------
-- Rows already there keep the domains they have: nobody gets the new one silently.

ALTER TABLE ai_access DROP CONSTRAINT ai_access_domains;
ALTER TABLE ai_access ADD CONSTRAINT ai_access_domains CHECK (
  domains <@ ARRAY['inspection', 'orders', 'materials', 'audit', 'production']::text[] AND array_position(domains, NULL) IS NULL
);

-- ---- What the assistant reads --------------------------------------------------------
-- One row per live record, with the order line it belongs to (when the sheet
-- has it) and its machine (when the register has it): the machine is resolved
-- once, by ai.machine_key, and its name, factory, process and dashboard flag
-- all come from that one row. Numbers come out as float8, as in the other
-- views; the record's own workers as an array too.

CREATE OR REPLACE VIEW ai.production_task_records AS
SELECT btrim(r.line_key)                      AS line_key,
       btrim(r.erp_record_id)                 AS erp_record_id,
       o.id                                   AS order_line_id,
       o.id IS NOT NULL                       AS order_line_known,
       btrim(o.item_code)                     AS item_code,
       btrim(o.customer)                      AS customer,
       o.required_qty::float8                 AS order_required_qty,
       o.finished_qty::float8                 AS order_finished_qty,
       btrim(o.erp_status)                    AS erp_status,
       r.week,
       r.week_no,
       r.week_year,
       btrim(r.order_number)                  AS order_number,
       btrim(r.item)                          AS item,
       btrim(r.colour)                        AS colour,
       r.produced_qty::float8                 AS produced_qty,
       r.required_qty::float8                 AS required_qty,
       r.worker_1,
       r.worker_2,
       r.worker_3,
       r.worker_4,
       w.names                                AS workers,
       r.day_no,
       r.work_day,
       to_char(r.work_day, 'YYYY-MM')         AS work_month,
       btrim(r.work_center_code)              AS work_center_code,
       CASE WHEN btrim(r.work_center_code) = '' THEN ''
            ELSE COALESCE(NULLIF(btrim(m.display_name), ''), 'Machine ' || btrim(r.work_center_code)) END AS machine,
       COALESCE(btrim(m.factory), '')         AS factory,
       m.process,
       m.on_dashboard IS NOT FALSE            AS counts_on_dashboard,
       btrim(r.resource)                      AS resource,
       r.duration_hours::float8               AS duration_hours,
       r.planned_hours::float8                AS planned_hours,
       r.actual_hours::float8                 AS actual_hours,
       r.stage_no,
       r.stage_qty::float8                    AS stage_qty,
       btrim(r.remarks)                       AS remarks,
       r.length_mm::float8                    AS length_mm,
       r.width_mm::float8                     AS width_mm,
       r.thickness_mm::float8                 AS thickness_mm,
       btrim(r.shift)                         AS shift,
       r.weight_kg::float8                    AS weight_kg,
       r.produced_weight_kg::float8           AS produced_weight_kg,
       r.produced_length_m::float8            AS produced_length_m,
       r.imported_at
  FROM production_task_records r
  -- The line of the order sheet: its key is unique there whatever the case, so at most one row.
  LEFT JOIN production_orders o ON lower(o.line_key) = lower(r.line_key) AND o.deleted_at IS NULL
  LEFT JOIN LATERAL (
    SELECT m.display_name, m.factory, m.process, m.on_dashboard FROM machines m
     WHERE ai.machine_key(m.code) = ai.machine_key(r.work_center_code) AND m.deleted_at IS NULL
     ORDER BY m.created_at LIMIT 1) m ON true
  -- The four worker columns as one list: blanks left out, a name once, in their columns' order (shared workersOf).
  LEFT JOIN LATERAL (
    SELECT COALESCE(array_agg(x.name ORDER BY x.pos), '{}'::text[]) AS names
      FROM (SELECT DISTINCT ON (n.name) n.name, n.pos
              FROM (SELECT btrim(regexp_replace(u.raw, '\s+', ' ', 'g')) AS name, u.pos
                      FROM unnest(ARRAY[r.worker_1, r.worker_2, r.worker_3, r.worker_4]) WITH ORDINALITY AS u(raw, pos)) n
             WHERE n.name <> ''
             ORDER BY n.name, n.pos) x) w ON true
 WHERE r.deleted_at IS NULL;
COMMENT ON VIEW ai.production_task_records IS 'The ERP''s production task record: what each machine made per day. One row = one day''s work (a shift, or a stage) on one ORDER LINE (line_key), numbered day_no; a line often has two rows on the same work_day. The child of the order sheet: the line''s item_code, customer, order_required_qty, order_finished_qty and erp_status are carried here when the sheet has the line (order_line_known); for the rest join ai.order_lines on line_key when you can read it. Per row (this day''s work): produced_qty, planned_hours, actual_hours, produced_weight_kg, produced_length_m - sum them over any grouping (machine, work_day, work_month, worker, order). Per task, repeated on every row of the line: required_qty, duration_hours (the task''s planned hours) and weight_kg (the task''s weight) - take each once per line_key, never sum them across days. week is the task''s PLANNING week, not the week of the work: periods and weeks come from work_day. actual_hours NULL = not recorded. Imported by hand from the ERP (imported_at says how fresh, never when the work was done); retired rows are excluded.';
COMMENT ON COLUMN ai.production_task_records.line_key IS 'The ERP''s Order ID of the order line this row belongs to = ai.order_lines.line_key (matched without regard to case). Several rows per line: one per day''s work (shift or stage), two or more may share a work_day.';
COMMENT ON COLUMN ai.production_task_records.erp_record_id IS 'The ERP''s record id. It repeats across order lines; (line_key, erp_record_id) names a row.';
COMMENT ON COLUMN ai.production_task_records.order_line_id IS 'ai.order_lines.order_line_id of the line when the order sheet has it; NULL when it does not.';
COMMENT ON COLUMN ai.production_task_records.order_line_known IS 'true = the order sheet still has this line (ai.order_lines has a row with this line_key). false = the record arrived before its line, or the line was removed from the sheet.';
COMMENT ON COLUMN ai.production_task_records.item_code IS 'The line''s item code from the order sheet; NULL when the line is not known. The record''s own item name is item.';
COMMENT ON COLUMN ai.production_task_records.customer IS 'The line''s customer from the order sheet; NULL when the line is not known.';
COMMENT ON COLUMN ai.production_task_records.order_required_qty IS 'The line''s required_qty on the order sheet; NULL when the line is not known. The record''s own figure is required_qty.';
COMMENT ON COLUMN ai.production_task_records.order_finished_qty IS 'The line''s finished_qty on the order sheet (ERP); NULL when the line is not known.';
COMMENT ON COLUMN ai.production_task_records.erp_status IS 'The line''s status on the order sheet (Active | Hold | Stock | Cancel…); NULL when the line is not known.';
COMMENT ON COLUMN ai.production_task_records.week IS 'The ERP''s PLANNING week of the task, "week/year" as written (e.g. "01/2026"), the same on every row of the line: NOT the week the work was done (most lines were made weeks or months later). Production by week or "this week" comes from work_day (date_trunc(''week'', work_day)); kept as given, typos included.';
COMMENT ON COLUMN ai.production_task_records.week_no IS 'The week number of week (1–53) when it parses, week_year its year: the task''s planning week, not the work_day''s.';
COMMENT ON COLUMN ai.production_task_records.order_number IS 'The order number as the ERP wrote it on the record; an order_number repeats across its lines and days.';
COMMENT ON COLUMN ai.production_task_records.item IS 'The item as the ERP names it on the record ("Shuttle Rail : 218-RO-SP : 10800-LH-T1 : 27").';
COMMENT ON COLUMN ai.production_task_records.produced_qty IS 'Finished pieces made on this day. Sum it over any grouping for production; NULL when the ERP left it blank; 0 on a stage row of a staged line (its work is in stage_qty).';
COMMENT ON COLUMN ai.production_task_records.required_qty IS 'The task''s required pieces, repeated on EVERY row of the line: never sum it across days; take it once per line_key (max(required_qty) GROUP BY line_key).';
COMMENT ON COLUMN ai.production_task_records.worker_1 IS 'First of up to four people on the machine that day (worker_1 … worker_4, Arabic names, blank when fewer); workers has them as a list.';
COMMENT ON COLUMN ai.production_task_records.workers IS 'The people on the machine that day: the non-blank worker_1 … worker_4, each once, in order. unnest(workers) to count by person.';
COMMENT ON COLUMN ai.production_task_records.day_no IS 'Numbers the line''s rows in the ERP''s order (Day1, Day2 …); several may fall on the same work_day (another shift, a stage) and the order is not always by date. Count days with count(DISTINCT work_day), order by work_day.';
COMMENT ON COLUMN ai.production_task_records.work_day IS 'The day the work was done (a date, no time); NULL on a few rows the ERP wrote without one. Periods are filtered on it (work_day >= ''2026-09-01'' AND work_day < ''2026-10-01''), never on imported_at; group days by work_day, months by work_month.';
COMMENT ON COLUMN ai.production_task_records.work_month IS '''YYYY-MM'' of work_day; NULL when work_day is.';
COMMENT ON COLUMN ai.production_task_records.work_center_code IS 'The machine''s code as the ERP wrote it = machine_code of ai.machines and ai.order_lines where the register has it.';
COMMENT ON COLUMN ai.production_task_records.machine IS 'The machine''s display name from the register when the code is known, else "Machine <code>"; resource is the ERP''s own name for it.';
COMMENT ON COLUMN ai.production_task_records.factory IS 'The machine''s factory from the register; '''' when the code is not in the register.';
COMMENT ON COLUMN ai.production_task_records.process IS 'Process of the machine: forming | welding | paint | universal; NULL when the code is not in the register.';
COMMENT ON COLUMN ai.production_task_records.counts_on_dashboard IS 'false = the machine is left out of every dashboard figure (machines.on_dashboard).';
COMMENT ON COLUMN ai.production_task_records.resource IS 'The ERP''s name of the machine or line ("Roll Forming Line C2792015"); the only name when the code is not in the register.';
COMMENT ON COLUMN ai.production_task_records.duration_hours IS 'The ERP''s planned hours for the WHOLE task (its required_qty), repeated on every row of the line like required_qty: never sum it across days; take it once per line_key. planned_hours is this row''s share of it.';
COMMENT ON COLUMN ai.production_task_records.planned_hours IS 'The ERP''s "Planned time" for this row = duration_hours × produced_qty / required_qty, the planned hours of what this day made. Sum it over any grouping; compare it with actual_hours.';
COMMENT ON COLUMN ai.production_task_records.actual_hours IS 'Hours actually taken on this day; NULL = not recorded (the ERP writes a placeholder, read as nothing). Average or sum over the rows that have it.';
COMMENT ON COLUMN ai.production_task_records.stage_no IS 'Staged (universal) lines only: the stage this row''s work was for, with stage_qty the pieces that passed it that day; such a row has produced_qty 0 - the line''s finished pieces are on its last row (stage_no NULL). NULL on every other row (stage_qty 0 or NULL).';
COMMENT ON COLUMN ai.production_task_records.remarks IS 'Free text written on the record (mostly Arabic); '''' on most rows.';
COMMENT ON COLUMN ai.production_task_records.length_mm IS 'The item''s length in mm; width_mm and thickness_mm likewise (0 when the ERP has none).';
COMMENT ON COLUMN ai.production_task_records.shift IS 'The shift category as the ERP names it (Arabic: morning 8 h, morning overtime 3 h, extended morning 11 h, evening 8 h, extended evening 12 h); '''' when none.';
COMMENT ON COLUMN ai.production_task_records.weight_kg IS 'The WHOLE task''s weight in kg (required_qty × the piece weight), repeated on every row of the line: never sum it across days; take it once per line_key. produced_weight_kg is the weight of what this day made and produced_length_m its length in metres (≈ produced_qty × length_mm / 1000): sum those over any grouping.';
COMMENT ON COLUMN ai.production_task_records.imported_at IS 'When the last import touched this row: the record is imported by hand, so this says how fresh it is. Not the day of the work (work_day); never use it to pick a period.';

-- ---- The domain role, and the retirement of the four-bit combinations ----------------
-- As 0033: one role without LOGIN holding exactly the domain's views. The
-- combinations the API signs in as are its own to make at start, so the
-- fifteen four-bit ones are taken back and dropped here; one still held on
-- to is left without a grant and unable to sign in.

DO $$
DECLARE
  db   text := current_database();
  role text := current_database() || '_ai_production';
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
  -- Exactly what the domain holds, whatever an earlier run granted.
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA ai FROM %I', role);
  EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ai FROM %I', role);
  EXECUTE format('REVOKE ALL ON SCHEMA ai FROM %I', role);
  EXECUTE format('GRANT SELECT ON ai.production_task_records TO %I', role);

  FOR i IN 1..15 LOOP
    old := db || '_ai_r_' || (i::bit(4))::text;
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
