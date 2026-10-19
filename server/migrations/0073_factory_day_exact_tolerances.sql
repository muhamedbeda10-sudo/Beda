-- ============================================================================
-- 0073 — the factory day, and dimension verdicts decided exactly.
--
-- The factory day. A factory (production) day runs 08:00 → 08:00 in the
-- factory's time zone: the morning shift opens it and the night shift
-- (19:00–08:00) closes it, wholly, so a sample at 02:00 on the 20th belongs
-- to the 19th. Until now every day here was the calendar date, which split
-- each night shift across two days.
--   • ai.factory_day(at, tz) is the one definition in the database, the same
--     rule as factoryDay in shared/src/rules.ts. Immutable, so an index may
--     be built on it with a zone written out. ai.factory_day_start(day, tz)
--     is where a day begins, the bound a period is filtered by on an indexed
--     *_at column; ai.factory_month(at, tz) is the month of the factory day.
--     The one-argument forms read the session's time zone, which the
--     assistant's query runner sets to the factory's.
--   • The assistant's *_day and *_month columns become factory days: same
--     names, same types, every other column as it was (CREATE OR REPLACE),
--     their comments saying so. order_lines.order_day (an ERP date) and
--     audit_log.day (when a person acted) stay calendar dates.
--   • The API's own queries (the dashboard, History, PDI) call the same
--     functions with FACTORY_TIMEZONE.
--   • Saved and scheduled reports: a timestamp their period bounds with
--     {{from}} / {{to}} is bounded at 08:00 on those days from now on.
--
-- Dimension verdicts. dimensionStatus compared limits worked out in floating
-- point: 50.15 +0.05 put the upper limit at 50.199999999999996, so a reading
-- of exactly 50.2 failed, and the 10% warning band missed its own edge the
-- same way. The rule now decides in exact decimals at the stored precision;
-- the verdicts already stored are decided again here, with numeric
-- arithmetic, and only a row whose verdict differs is changed: its status,
-- its version (an open correction dialog then reloads it), and one audit
-- entry by the system account, "System — exact tolerance check", old → new.
-- The rollups follow by their own statement triggers (0067).
-- ============================================================================

-- ---- The factory day ---------------------------------------------------------------

CREATE OR REPLACE FUNCTION ai.factory_day(at timestamptz, tz text) RETURNS date
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT (($1 AT TIME ZONE $2) - interval '8 hours')::date
$$;
COMMENT ON FUNCTION ai.factory_day(timestamptz, text) IS 'The factory day of a moment in time zone tz: a factory day runs from 08:00 to 08:00 the next morning, so before 08:00 is still the day before. ai.factory_day(at) uses the factory''s zone.';

CREATE OR REPLACE FUNCTION ai.factory_day(at timestamptz) RETURNS date
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT ai.factory_day($1, current_setting('TimeZone'))
$$;
COMMENT ON FUNCTION ai.factory_day(timestamptz) IS 'The factory day of a moment (what every *_day column holds): a factory day runs from 08:00 to 08:00 the next morning, factory time, so 02:00 on the 20th is the 19th and the night shift (19:00-08:00) belongs wholly to the day it started.';

CREATE OR REPLACE FUNCTION ai.factory_day_start(day date, tz text) RETURNS timestamptz
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ($1 + time '08:00') AT TIME ZONE $2
$$;
COMMENT ON FUNCTION ai.factory_day_start(date, text) IS 'The moment a factory day begins (08:00 that day) in time zone tz. ai.factory_day_start(day) uses the factory''s zone.';

CREATE OR REPLACE FUNCTION ai.factory_day_start(day date) RETURNS timestamptz
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT ai.factory_day_start($1, current_setting('TimeZone'))
$$;
COMMENT ON FUNCTION ai.factory_day_start(date) IS 'The moment a factory day begins: 08:00 on that day, factory time. A period of factory days on an indexed *_at column: x_at >= ai.factory_day_start(first day) AND x_at < ai.factory_day_start(last day + 1).';

CREATE OR REPLACE FUNCTION ai.factory_month(at timestamptz, tz text) RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT to_char(ai.factory_day($1, $2)::timestamp, 'YYYY-MM')
$$;
COMMENT ON FUNCTION ai.factory_month(timestamptz, text) IS 'The month (YYYY-MM) of a moment''s factory day in time zone tz: what every *_month column holds.';

-- Functions are everyone's unless revoked (a default set for one schema cannot
-- take that away): the readers get them through the base role, as the views
-- that call them need.
REVOKE EXECUTE ON FUNCTION ai.factory_day(timestamptz, text), ai.factory_day(timestamptz), ai.factory_day_start(date, text),
  ai.factory_day_start(date), ai.factory_month(timestamptz, text) FROM PUBLIC;
DO $$
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION ai.factory_day(timestamptz, text), ai.factory_day(timestamptz), ai.factory_day_start(date, text), ai.factory_day_start(date), ai.factory_month(timestamptz, text) TO %I',
                 current_database() || '_ai_base');
END $$;

COMMENT ON SCHEMA ai IS 'Read-only views of the QC inspection records for the AI assistant. Soft-deleted rows are excluded everywhere. Days and months are factory days: 08:00 to 08:00 in the factory''s time zone (ai.factory_day).';

-- ---- The assistant's days ------------------------------------------------------------
-- Every view as it stands (its last definition, 0067/0068), with its days
-- worked out by ai.factory_day.

CREATE OR REPLACE VIEW ai.inspection_sessions AS
 SELECT session_id,
    session_no,
    status,
    order_line_id,
    order_number,
    is_stock,
    order_line_key,
    item_code,
    item,
    customer,
    expected_grade,
    erp_status,
    order_line_retired,
    machine_code,
    machine,
    factory,
    process,
    counts_on_dashboard,
    opened_by_id,
    opened_by,
    sample_inspectors,
    started_at,
    started_day,
    closed_at,
    closed_day,
    closed_by,
    rejected_before_release,
    rejected_before_release_by,
    first_part_clean,
    final_qty,
    produced_qty_stock,
    universal_kind,
    stages,
    top_stage,
    samples,
    pieces_inspected,
    defect_records,
    defect_pieces,
    hold_records,
    hold_pieces,
    disposition_rejected_pieces,
    disposition_repair_pieces,
    disposition_used_elsewhere_pieces,
    disposition_concession_pieces,
    dimension_fails,
    pt_lengths_tested,
    pt_lengths_rejected,
    notes,
    prior_defects_elsewhere,
        CASE
            WHEN status = 'Closed'::text AND final_qty > 0::double precision THEN round((defect_pieces / final_qty * 100::double precision)::numeric, 1)
            ELSE NULL::numeric
        END AS defect_rate_pct,
        CASE
            WHEN pieces_inspected > 0::double precision THEN round((defect_pieces / pieces_inspected * 100::double precision)::numeric, 1)
            ELSE NULL::numeric
        END AS inspected_defect_pct,
        CASE
            WHEN process = 'welding'::text AND status = 'Closed'::text AND final_qty IS NOT NULL THEN
            CASE
                WHEN final_qty <= 0::double precision THEN 0
                ELSE ceil(final_qty * 5::double precision / 100.0::double precision - 0.000000001::double precision)::integer
            END
            ELSE NULL::integer
        END AS pt_lengths_required
   FROM ( SELECT s.id AS session_id,
            s.seq AS session_no,
            s.status::text AS status,
            s.order_id AS order_line_id,
            btrim(o.order_number) AS order_number,
            upper(btrim(o.order_number)) = 'STOCK'::text AS is_stock,
            o.line_key AS order_line_key,
            btrim(o.item_code) AS item_code,
            btrim(o.item) AS item,
            btrim(o.customer) AS customer,
            btrim(o.expected_grade) AS expected_grade,
            btrim(o.erp_status) AS erp_status,
            o.deleted_at IS NOT NULL AS order_line_retired,
            s.work_center_code AS machine_code,
            COALESCE(NULLIF(btrim(m.display_name), ''::text), 'Machine '::text || s.work_center_code) AS machine,
            COALESCE(m.factory, ''::text) AS factory,
            COALESCE(m.process, 'universal'::text) AS process,
            m.on_dashboard IS NOT FALSE AS counts_on_dashboard,
            s.inspector_id AS opened_by_id,
            s.inspector_name AS opened_by,
            sr.sample_inspectors,
            s.started_at,
            ai.factory_day(s.started_at, current_setting('TimeZone'::text)) AS started_day,
            s.closed_at,
            ai.factory_day(s.closed_at, current_setting('TimeZone'::text)) AS closed_day,
                CASE
                    WHEN s.closed_at IS NULL THEN NULL::text
                    ELSE COALESCE(( SELECT u.name
                       FROM users u
                      WHERE u.id = s.closed_by_id), 'Unknown'::text)
                END AS closed_by,
                CASE
                    WHEN s.start_qty_at IS NOT NULL AND s.start_qty_by_id IS NOT NULL THEN s.start_qty
                    ELSE NULL::numeric
                END::double precision AS rejected_before_release,
            s.start_qty_by_name AS rejected_before_release_by,
            COALESCE(s.start_qty, 0::numeric) = 0::numeric AS first_part_clean,
            s.final_qty::double precision AS final_qty,
                CASE
                    WHEN upper(btrim(o.order_number)) = 'STOCK'::text THEN s.produced_qty
                    ELSE NULL::numeric
                END::double precision AS produced_qty_stock,
            s.universal_kind,
            sr.stages,
            sr.top_stage,
            COALESCE(sr.samples, 0) AS samples,
            COALESCE(sr.pieces_inspected, 0::numeric)::double precision AS pieces_inspected,
            COALESCE(sr.defect_records, 0) AS defect_records,
            COALESCE(sr.defect_pieces, 0::numeric)::double precision AS defect_pieces,
            COALESCE(sr.hold_records, 0) AS hold_records,
            COALESCE(sr.hold_pieces, 0::numeric)::double precision AS hold_pieces,
            COALESCE(sr.rejected_pieces, 0::numeric)::double precision AS disposition_rejected_pieces,
            COALESCE(sr.repair_pieces, 0::numeric)::double precision AS disposition_repair_pieces,
            COALESCE(sr.used_elsewhere_pieces, 0::numeric)::double precision AS disposition_used_elsewhere_pieces,
            COALESCE(sr.concession_pieces, 0::numeric)::double precision AS disposition_concession_pieces,
            COALESCE(sr.dimension_fails, 0) AS dimension_fails,
            COALESCE(sr.pt_lengths_tested, 0) AS pt_lengths_tested,
            COALESCE(sr.pt_lengths_rejected, 0) AS pt_lengths_rejected,
            COALESCE(sr.notes, 0) AS notes,
            (EXISTS ( SELECT 1
                   FROM production_orders o1
                     JOIN production_orders o2 ON lower(o2.order_number) = lower(o1.order_number) AND lower(o2.item_code) = lower(o1.item_code) AND lower(btrim(o2.item)) = lower(btrim(o1.item))
                     JOIN inspection_sessions s2 ON s2.order_id = o2.id AND s2.id <> s.id AND s2.deleted_at IS NULL
                     JOIN inspection_samples x2 ON x2.session_id = s2.id AND x2.deleted_at IS NULL
                     JOIN defect_results d2 ON d2.sample_id = x2.id AND d2.deleted_at IS NULL
                  WHERE o1.id = s.order_id AND btrim(o1.item_code) <> ''::text AND (lower(s2.work_center_code) <> lower(s.work_center_code) OR s2.started_at < s.started_at))) AS prior_defects_elsewhere
           FROM inspection_sessions s
             JOIN production_orders o ON o.id = s.order_id
             LEFT JOIN machines m ON lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL
             LEFT JOIN session_rollups sr ON sr.session_id = s.id
          WHERE s.deleted_at IS NULL) b;
COMMENT ON COLUMN ai.inspection_sessions.started_day IS 'Factory day the session started (sessions are counted by it): ai.factory_day(started_at), 08:00 to 08:00 factory time, so a session started at 02:00 belongs to the day before.';
COMMENT ON COLUMN ai.inspection_sessions.closed_day IS 'Factory day the session was (last) closed; production is counted by it. ai.factory_day(closed_at): 08:00 to 08:00 factory time.';

CREATE OR REPLACE VIEW ai.inspection_samples AS
 SELECT sample_id,
    session_id,
    session_no,
    sample_no,
    session_status,
    order_line_id,
    order_number,
    is_stock,
    item_code,
    item,
    customer,
    expected_grade,
    machine_code,
    machine,
    factory,
    process,
    counts_on_dashboard,
    inspector_id,
    inspector,
    recorded_at,
    recorded_day,
    shift,
    shift_name,
    sample_qty,
    drawing,
    drawing_alt,
    drawing_issue,
    dimension_rows,
    dimensions_measured,
    dimensions_pass,
    dimensions_warning,
    dimensions_fail,
    defect_records,
    defect_pieces,
    hold_records,
    coils,
    grade_mismatch_acknowledged,
    grade_ack_by,
    grade_ack_at,
    grade_ack_expected_grade,
    grade_ack_found_grades,
    grade_ack_coils,
    paint_notes,
    pt_verdict,
    last_changed_at,
    defect_pieces = 0::double precision AS first_pass,
    coil_material,
    material
   FROM ( SELECT x.id AS sample_id,
            x.session_id,
            s.seq AS session_no,
            x.index AS sample_no,
            s.status::text AS session_status,
            x.order_id AS order_line_id,
            btrim(o.order_number) AS order_number,
            upper(btrim(o.order_number)) = 'STOCK'::text AS is_stock,
            btrim(o.item_code) AS item_code,
            btrim(o.item) AS item,
            btrim(o.customer) AS customer,
            btrim(o.expected_grade) AS expected_grade,
            s.work_center_code AS machine_code,
            COALESCE(NULLIF(btrim(m.display_name), ''::text), 'Machine '::text || s.work_center_code) AS machine,
            COALESCE(m.factory, ''::text) AS factory,
            COALESCE(m.process, 'universal'::text) AS process,
            m.on_dashboard IS NOT FALSE AS counts_on_dashboard,
            x.inspector_id,
            x.inspector_name AS inspector,
            x.created_at AS recorded_at,
            ai.factory_day(x.created_at, current_setting('TimeZone'::text)) AS recorded_day,
            x.shift::text AS shift,
                CASE x.shift
                    WHEN 'A'::shift_letter THEN 'Morning'::text
                    WHEN 'B'::shift_letter THEN 'Afternoon'::text
                    ELSE 'Night'::text
                END AS shift_name,
            x.sample_qty::double precision AS sample_qty,
            x.drawing,
            x.drawing_alt,
            x.issue AS drawing_issue,
            COALESCE(sr.dimension_rows, 0) AS dimension_rows,
            COALESCE(sr.dimensions_measured, 0) AS dimensions_measured,
            COALESCE(sr.dimensions_pass, 0) AS dimensions_pass,
            COALESCE(sr.dimensions_warning, 0) AS dimensions_warning,
            COALESCE(sr.dimensions_fail, 0) AS dimensions_fail,
            COALESCE(sr.defect_records, 0) AS defect_records,
            COALESCE(sr.defect_pieces, 0::numeric)::double precision AS defect_pieces,
            COALESCE(sr.hold_records, 0) AS hold_records,
            sr.coils,
            x.grade_ack_at IS NOT NULL AS grade_mismatch_acknowledged,
            x.grade_ack_by_name AS grade_ack_by,
            x.grade_ack_at,
            x.grade_ack_expected_grade,
            array_to_string(x.grade_ack_found_grades, ', '::text) AS grade_ack_found_grades,
            array_to_string(x.grade_ack_coil_numbers, ', '::text) AS grade_ack_coils,
            ( SELECT p.notes
                   FROM paint_samples p
                  WHERE p.sample_id = x.id AND p.deleted_at IS NULL) AS paint_notes,
            ( SELECT p.accept_or_repair::text AS accept_or_repair
                   FROM pt_records p
                  WHERE p.sample_id = x.id AND p.deleted_at IS NULL) AS pt_verdict,
            x.updated_at AS last_changed_at,
            sr.coil_material,
            sr.material
           FROM inspection_samples x
             JOIN inspection_sessions s ON s.id = x.session_id AND s.deleted_at IS NULL
             JOIN production_orders o ON o.id = x.order_id
             LEFT JOIN machines m ON lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL
             LEFT JOIN sample_rollups sr ON sr.sample_id = x.id
          WHERE x.deleted_at IS NULL) b;
COMMENT ON COLUMN ai.inspection_samples.recorded_day IS 'Factory day the sample was recorded (samples are counted by it): ai.factory_day(recorded_at), 08:00 to 08:00 factory time, so the night shift (19:00-08:00) belongs wholly to the day it started.';

CREATE OR REPLACE VIEW ai.defects AS
 SELECT d.id AS defect_id,
    x.id AS sample_id,
    x.session_id,
    s.seq AS session_no,
    x.index AS sample_no,
    s.status::text AS session_status,
    x.order_id AS order_line_id,
    btrim(o.order_number) AS order_number,
    btrim(o.item_code) AS item_code,
    btrim(o.item) AS item,
    btrim(o.customer) AS customer,
    s.work_center_code AS machine_code,
    COALESCE(NULLIF(btrim(m.display_name), ''::text), 'Machine '::text || s.work_center_code) AS machine,
    COALESCE(m.factory, ''::text) AS factory,
    COALESCE(m.process, 'universal'::text) AS process,
    m.on_dashboard IS NOT FALSE AS counts_on_dashboard,
    x.inspector_name AS inspector,
    x.created_at AS recorded_at,
    ai.factory_day(x.created_at, current_setting('TimeZone'::text)) AS recorded_day,
    x.shift::text AS shift,
    d.defect_name,
    d.qty::double precision AS pieces,
    d.disposition::text AS disposition,
    d.notes,
    (( SELECT count(*) AS count
           FROM defect_images di
             JOIN images i ON i.id = di.image_id AND i.deleted_at IS NULL
          WHERE di.defect_id = d.id))::integer AS photos,
        CASE
            WHEN d.disposition = 'Hold'::disposition THEN floor(EXTRACT(epoch FROM now() - x.created_at) / 86400::numeric)::integer
            ELSE NULL::integer
        END AS hold_age_days,
    d.updated_at AS last_changed_at
   FROM defect_results d
     JOIN inspection_samples x ON x.id = d.sample_id AND x.deleted_at IS NULL
     JOIN inspection_sessions s ON s.id = x.session_id AND s.deleted_at IS NULL
     JOIN production_orders o ON o.id = x.order_id
     LEFT JOIN machines m ON lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL
  WHERE d.deleted_at IS NULL;
COMMENT ON COLUMN ai.defects.recorded_day IS 'Factory day the defect''s sample was recorded: ai.factory_day(recorded_at), 08:00 to 08:00 factory time.';

CREATE OR REPLACE VIEW ai.dimension_measurements AS
 SELECT r.id AS measurement_id,
    x.id AS sample_id,
    x.session_id,
    s.seq AS session_no,
    x.index AS sample_no,
    btrim(o.order_number) AS order_number,
    btrim(o.item_code) AS item_code,
    btrim(o.item) AS item,
    s.work_center_code AS machine_code,
    COALESCE(NULLIF(btrim(m.display_name), ''::text), 'Machine '::text || s.work_center_code) AS machine,
    COALESCE(m.factory, ''::text) AS factory,
    COALESCE(m.process, 'universal'::text) AS process,
    x.inspector_name AS inspector,
    x.created_at AS recorded_at,
    ai.factory_day(x.created_at, current_setting('TimeZone'::text)) AS recorded_day,
    x.shift::text AS shift,
    r.sequence,
    r.name AS dimension,
    r.nominal,
    r.tol_plus,
    r.tol_minus,
    r.nominal + abs(r.tol_plus) AS upper_limit,
    r.nominal - abs(r.tol_minus) AS lower_limit,
    r.actual,
    r.actual - r.nominal AS deviation,
    r.unit,
    r.status::text AS status,
    r.source::text AS spec_source,
    lower(btrim(r.name)) = 'paint thickness'::text AS is_paint_thickness,
    btrim(o.expected_grade) AS expected_grade,
    sr.coil_material,
    sr.material
   FROM dimension_results r
     JOIN inspection_samples x ON x.id = r.sample_id AND x.deleted_at IS NULL
     JOIN inspection_sessions s ON s.id = x.session_id AND s.deleted_at IS NULL
     JOIN production_orders o ON o.id = x.order_id
     LEFT JOIN machines m ON lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL
     LEFT JOIN sample_rollups sr ON sr.sample_id = x.id
  WHERE r.deleted_at IS NULL;
COMMENT ON COLUMN ai.dimension_measurements.recorded_day IS 'Factory day the measurement''s sample was recorded: ai.factory_day(recorded_at), 08:00 to 08:00 factory time.';

CREATE OR REPLACE VIEW ai.sample_coils AS
 SELECT c.id AS sample_coil_id,
    x.id AS sample_id,
    x.session_id,
    s.seq AS session_no,
    x.index AS sample_no,
    btrim(o.order_number) AS order_number,
    btrim(o.item_code) AS item_code,
    btrim(o.item) AS item,
    btrim(o.customer) AS customer,
    btrim(o.expected_grade) AS expected_grade,
    s.work_center_code AS machine_code,
    COALESCE(NULLIF(btrim(m.display_name), ''::text), 'Machine '::text || s.work_center_code) AS machine,
    COALESCE(m.factory, ''::text) AS factory,
    COALESCE(m.process, 'universal'::text) AS process,
    m.on_dashboard IS NOT FALSE AS counts_on_dashboard,
    x.inspector_name AS inspector,
    x.created_at AS recorded_at,
    ai.factory_day(x.created_at, current_setting('TimeZone'::text)) AS recorded_day,
    c.coil_number,
    c.coil_id IS NOT NULL AS picked_from_register,
    COALESCE(NULLIF(btrim(c.supplier), ''::text), NULLIF(btrim(r.supplier), ''::text)) AS supplier,
    COALESCE(NULLIF(btrim(c.grade), ''::text), NULLIF(btrim(r.grade), ''::text)) AS grade,
    ai.material_kind(COALESCE(NULLIF(btrim(c.grade), ''::text), NULLIF(btrim(r.grade), ''::text))) AS material_kind,
    COALESCE(c.thickness, r.thickness) AS thickness_mm,
    COALESCE(c.width, r.width) AS width_mm,
    COALESCE(c.yield, r.yield) AS yield_strength,
    COALESCE(NULLIF(btrim(c.sm_type), ''::text), NULLIF(btrim(r.sm_type), ''::text)) AS sm_type,
    c.notes,
    x.grade_ack_at IS NOT NULL AS grade_mismatch_acknowledged,
    x.sample_qty::double precision AS sample_qty,
    COALESCE(sr.defect_pieces, 0::numeric)::double precision AS sample_defect_pieces,
    COALESCE(NULLIF(btrim(c.supplier), ''::text), '(unknown supplier)'::text) AS dashboard_supplier,
    COALESCE(NULLIF(btrim(c.grade), ''::text), '—'::text) AS dashboard_grade
   FROM sample_coils c
     JOIN inspection_samples x ON x.id = c.sample_id AND x.deleted_at IS NULL
     JOIN inspection_sessions s ON s.id = x.session_id AND s.deleted_at IS NULL
     JOIN production_orders o ON o.id = x.order_id
     LEFT JOIN coils r ON lower(r.coil_number) = lower(c.coil_number) AND r.deleted_at IS NULL
     LEFT JOIN machines m ON lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL
     LEFT JOIN sample_rollups sr ON sr.sample_id = x.id
  WHERE c.deleted_at IS NULL;
COMMENT ON COLUMN ai.sample_coils.recorded_day IS 'Factory day the sample was recorded: ai.factory_day(recorded_at), 08:00 to 08:00 factory time.';

CREATE OR REPLACE VIEW ai.pt_records AS
 SELECT p.id AS pt_record_id,
    x.id AS sample_id,
    x.session_id,
    s.seq AS session_no,
    x.index AS sample_no,
    btrim(o.order_number) AS order_number,
    btrim(o.item_code) AS item_code,
    btrim(o.item) AS item,
    s.work_center_code AS machine_code,
    COALESCE(NULLIF(btrim(m.display_name), ''::text), 'Machine '::text || s.work_center_code) AS machine,
    COALESCE(m.factory, ''::text) AS factory,
    x.inspector_name AS inspector,
    x.created_at AS recorded_at,
    ai.factory_day(x.created_at, current_setting('TimeZone'::text)) AS recorded_day,
    p.accept_or_repair::text AS verdict,
    (( SELECT count(*) AS count
           FROM pt_tested_lengths l
          WHERE l.pt_record_id = p.id AND l.deleted_at IS NULL))::integer AS lengths_tested,
    (( SELECT count(*) AS count
           FROM pt_tested_lengths l
          WHERE l.pt_record_id = p.id AND l.deleted_at IS NULL AND l.verdict = 'Reject / Repair'::pt_verdict))::integer AS lengths_rejected,
    ( SELECT sum(l.length_mm) AS sum
           FROM pt_tested_lengths l
          WHERE l.pt_record_id = p.id AND l.deleted_at IS NULL) AS total_length_mm,
    ( SELECT string_agg((((l.seq || ': '::text) || trim_scale(l.length_mm)) || ' mm '::text) || l.verdict::text, '; '::text ORDER BY l.seq) AS string_agg
           FROM pt_tested_lengths l
          WHERE l.pt_record_id = p.id AND l.deleted_at IS NULL) AS tested_lengths,
    p.cleaner_lot,
    p.penetrant_lot,
    p.developer_lot,
    p.welding_wire_batch,
    p.indication_type,
    p.indication_size,
    p.final_result,
    p.notes,
    p.test_frequency_pct AS legacy_test_frequency_pct,
    p.connector_coil_number
   FROM pt_records p
     JOIN inspection_samples x ON x.id = p.sample_id AND x.deleted_at IS NULL
     JOIN inspection_sessions s ON s.id = x.session_id AND s.deleted_at IS NULL
     JOIN production_orders o ON o.id = x.order_id
     LEFT JOIN machines m ON lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL
  WHERE p.deleted_at IS NULL;
COMMENT ON COLUMN ai.pt_records.recorded_day IS 'Factory day of recorded_at: ai.factory_day(recorded_at), 08:00 to 08:00 factory time.';

CREATE OR REPLACE VIEW ai.session_notes AS
 SELECT n.id AS note_id,
    n.session_id,
    s.seq AS session_no,
    n.order_id AS order_line_id,
    btrim(o.order_number) AS order_number,
    btrim(o.item_code) AS item_code,
    btrim(o.item) AS item,
    s.work_center_code AS machine_code,
    COALESCE(NULLIF(btrim(m.display_name), ''::text), 'Machine '::text || s.work_center_code) AS machine,
    sm.index AS sample_no,
    n.text,
    n.author_name AS author,
    n.created_at AS written_at,
    ai.factory_day(n.created_at, current_setting('TimeZone'::text)) AS written_day,
    (( SELECT count(*) AS count
           FROM session_note_images i
          WHERE i.note_id = n.id))::integer AS photos
   FROM session_notes n
     JOIN inspection_sessions s ON s.id = n.session_id AND s.deleted_at IS NULL
     JOIN production_orders o ON o.id = n.order_id
     LEFT JOIN inspection_samples sm ON sm.id = n.sample_id
     LEFT JOIN machines m ON lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL
  WHERE n.deleted_at IS NULL;
COMMENT ON COLUMN ai.session_notes.written_day IS 'Factory day of written_at: ai.factory_day(written_at), 08:00 to 08:00 factory time.';

CREATE OR REPLACE VIEW ai.production_sessions AS
 SELECT s.id AS session_id,
    s.seq AS session_no,
    s.order_id AS order_line_id,
    s.work_center_code AS machine_code,
    COALESCE(NULLIF(btrim(m.display_name), ''::text), 'Machine '::text || s.work_center_code) AS machine,
    COALESCE(m.factory, ''::text) AS factory,
    COALESCE(m.process, 'universal'::text) AS process,
    btrim(o.order_number) AS order_number,
    btrim(o.item_code) AS item_code,
    btrim(o.item) AS item,
    btrim(o.customer) AS customer,
    s.closed_at,
    ai.factory_day(s.closed_at, current_setting('TimeZone'::text)) AS closed_day,
    ai.factory_month(s.closed_at, current_setting('TimeZone'::text)) AS closed_month,
    s.final_qty::double precision AS final_qty,
    s.universal_kind,
    COALESCE(m.process = 'universal'::text, false) AND upper(btrim(o.order_number)) <> 'STOCK'::text AND s.universal_kind IS DISTINCT FROM 'final'::text AS counted_once_per_line,
    COALESCE(o.finished_qty, 0::numeric)::double precision AS sheet_finished_qty,
    (( SELECT max(q.stage) AS max
           FROM session_stage_quantities q
          WHERE q.session_id = s.id AND q.deleted_at IS NULL))::integer AS top_stage,
    ( SELECT jsonb_object_agg(q.stage::text, q.qty) AS jsonb_object_agg
           FROM session_stage_quantities q
          WHERE q.session_id = s.id AND q.deleted_at IS NULL) AS stage_quantities,
    COALESCE(sr.defect_pieces, 0::numeric)::double precision AS defect_pieces,
    m.on_dashboard IS NOT FALSE AS counts_on_dashboard
   FROM inspection_sessions s
     JOIN production_orders o ON o.id = s.order_id
     LEFT JOIN machines m ON lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL
     LEFT JOIN session_rollups sr ON sr.session_id = s.id
  WHERE s.deleted_at IS NULL AND s.status = 'Closed'::session_status AND s.final_qty IS NOT NULL AND s.closed_at IS NOT NULL;
COMMENT ON COLUMN ai.production_sessions.closed_day IS 'Factory day of closed_at: ai.factory_day(closed_at), 08:00 to 08:00 factory time, so a session the night shift closes at 03:00 counts on the day the shift started.';
COMMENT ON COLUMN ai.production_sessions.closed_month IS 'Factory month (YYYY-MM) of closed_day: a month of factory days, from 08:00 on its 1st to 08:00 on the next month''s 1st.';

CREATE OR REPLACE VIEW ai.pdi_documents AS
 SELECT d.id AS pdi_id,
    d.created_at AS recorded_at,
    ai.factory_day(d.created_at, current_setting('TimeZone'::text)) AS recorded_day,
    d.created_by_name AS recorded_by,
    COALESCE(btrim(o.order_number), ''::text) AS order_number,
    COALESCE(btrim(o.customer), ''::text) AS customer,
    d.notes,
    (( SELECT count(*) AS count
           FROM pdi_images pi
          WHERE pi.pdi_id = d.id))::integer AS photos,
    (( SELECT count(*) AS count
           FROM pdi_lines pl
          WHERE pl.pdi_id = d.id))::integer AS lines_covered,
    COALESCE(( SELECT string_agg(t.item, ', '::text ORDER BY (lower(t.item))) AS string_agg
           FROM ( SELECT DISTINCT btrim(l.item) AS item
                   FROM pdi_lines pl
                     JOIN production_orders l ON l.id = pl.order_id
                  WHERE pl.pdi_id = d.id) t), ''::text) AS items,
    COALESCE(( SELECT string_agg(t.code, ', '::text ORDER BY (lower(t.code))) AS string_agg
           FROM ( SELECT DISTINCT btrim(l.item_code) AS code
                   FROM pdi_lines pl
                     JOIN production_orders l ON l.id = pl.order_id
                  WHERE pl.pdi_id = d.id AND btrim(l.item_code) <> ''::text) t), ''::text) AS item_codes
   FROM pdi_documents d
     LEFT JOIN production_orders o ON o.id = d.order_id
  WHERE d.deleted_at IS NULL;
COMMENT ON COLUMN ai.pdi_documents.recorded_day IS 'Factory day of recorded_at: ai.factory_day(recorded_at), 08:00 to 08:00 factory time.';

CREATE OR REPLACE VIEW ai.pdi_lines AS
 SELECT pl.pdi_id,
    d.created_at AS pdi_recorded_at,
    ai.factory_day(d.created_at, current_setting('TimeZone'::text)) AS pdi_recorded_day,
    d.created_by_name AS pdi_recorded_by,
    l.id AS order_line_id,
    btrim(l.line_key) AS line_key,
    btrim(l.order_number) AS order_number,
    btrim(l.item_code) AS item_code,
    btrim(l.item) AS item,
    btrim(l.work_center_code) AS machine_code,
    btrim(l.customer) AS customer,
    btrim(l.drawing) AS drawing,
    l.required_qty::double precision AS required_qty,
    l.finished_qty::double precision AS finished_qty,
    btrim(l.erp_status) AS erp_status,
    l.deleted_at IS NOT NULL AS order_line_retired
   FROM pdi_lines pl
     JOIN pdi_documents d ON d.id = pl.pdi_id AND d.deleted_at IS NULL
     JOIN production_orders l ON l.id = pl.order_id;
COMMENT ON COLUMN ai.pdi_lines.pdi_recorded_day IS 'Factory day of pdi_recorded_at: ai.factory_day(pdi_recorded_at), 08:00 to 08:00 factory time.';

CREATE OR REPLACE VIEW ai.inspection_photos AS
 SELECT i.id AS photo_id,
    'defect'::text AS photo_of,
    di."position" + 1 AS photo_no,
    d.id AS defect_id,
    d.defect_name,
    d.disposition::text AS disposition,
    NULL::uuid AS note_id,
    NULL::text AS note_text,
    NULL::uuid AS pt_record_id,
    x.id AS sample_id,
    x.session_id,
    s.seq AS session_no,
    x.index AS sample_no,
    x.order_id AS order_line_id,
    btrim(o.order_number) AS order_number,
    btrim(o.item_code) AS item_code,
    btrim(o.item) AS item,
    btrim(o.customer) AS customer,
    s.work_center_code AS machine_code,
    COALESCE(NULLIF(btrim(m.display_name), ''::text), 'Machine '::text || s.work_center_code) AS machine,
    COALESCE(m.factory, ''::text) AS factory,
    x.inspector_name AS recorded_by,
    x.shift::text AS shift,
    x.created_at AS recorded_at,
    ai.factory_day(x.created_at, current_setting('TimeZone'::text)) AS recorded_day,
    i.uploaded_at AS taken_at,
    i.uploaded_by_name AS taken_by
   FROM defect_images di
     JOIN images i ON i.id = di.image_id AND i.deleted_at IS NULL
     JOIN defect_results d ON d.id = di.defect_id AND d.deleted_at IS NULL
     JOIN inspection_samples x ON x.id = d.sample_id AND x.deleted_at IS NULL
     JOIN inspection_sessions s ON s.id = x.session_id AND s.deleted_at IS NULL
     JOIN production_orders o ON o.id = x.order_id
     LEFT JOIN machines m ON lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL
UNION ALL
 SELECT i.id AS photo_id,
    'note'::text AS photo_of,
    ni."position" + 1 AS photo_no,
    NULL::uuid AS defect_id,
    NULL::text AS defect_name,
    NULL::text AS disposition,
    n.id AS note_id,
    n.text AS note_text,
    NULL::uuid AS pt_record_id,
    sm.id AS sample_id,
    n.session_id,
    s.seq AS session_no,
    sm.index AS sample_no,
    n.order_id AS order_line_id,
    btrim(o.order_number) AS order_number,
    btrim(o.item_code) AS item_code,
    btrim(o.item) AS item,
    btrim(o.customer) AS customer,
    s.work_center_code AS machine_code,
    COALESCE(NULLIF(btrim(m.display_name), ''::text), 'Machine '::text || s.work_center_code) AS machine,
    COALESCE(m.factory, ''::text) AS factory,
    n.author_name AS recorded_by,
    sm.shift::text AS shift,
    n.created_at AS recorded_at,
    ai.factory_day(n.created_at, current_setting('TimeZone'::text)) AS recorded_day,
    i.uploaded_at AS taken_at,
    i.uploaded_by_name AS taken_by
   FROM session_note_images ni
     JOIN images i ON i.id = ni.image_id AND i.deleted_at IS NULL
     JOIN session_notes n ON n.id = ni.note_id AND n.deleted_at IS NULL
     JOIN inspection_sessions s ON s.id = n.session_id AND s.deleted_at IS NULL
     JOIN production_orders o ON o.id = n.order_id
     LEFT JOIN inspection_samples sm ON sm.id = n.sample_id AND sm.deleted_at IS NULL
     LEFT JOIN machines m ON lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL
UNION ALL
 SELECT i.id AS photo_id,
    'pt'::text AS photo_of,
    pi."position" + 1 AS photo_no,
    NULL::uuid AS defect_id,
    NULL::text AS defect_name,
    NULL::text AS disposition,
    NULL::uuid AS note_id,
    NULL::text AS note_text,
    p.id AS pt_record_id,
    x.id AS sample_id,
    x.session_id,
    s.seq AS session_no,
    x.index AS sample_no,
    x.order_id AS order_line_id,
    btrim(o.order_number) AS order_number,
    btrim(o.item_code) AS item_code,
    btrim(o.item) AS item,
    btrim(o.customer) AS customer,
    s.work_center_code AS machine_code,
    COALESCE(NULLIF(btrim(m.display_name), ''::text), 'Machine '::text || s.work_center_code) AS machine,
    COALESCE(m.factory, ''::text) AS factory,
    x.inspector_name AS recorded_by,
    x.shift::text AS shift,
    x.created_at AS recorded_at,
    ai.factory_day(x.created_at, current_setting('TimeZone'::text)) AS recorded_day,
    i.uploaded_at AS taken_at,
    i.uploaded_by_name AS taken_by
   FROM pt_record_images pi
     JOIN images i ON i.id = pi.image_id AND i.deleted_at IS NULL
     JOIN pt_records p ON p.id = pi.pt_record_id AND p.deleted_at IS NULL
     JOIN inspection_samples x ON x.id = p.sample_id AND x.deleted_at IS NULL
     JOIN inspection_sessions s ON s.id = x.session_id AND s.deleted_at IS NULL
     JOIN production_orders o ON o.id = x.order_id
     LEFT JOIN machines m ON lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL
UNION ALL
 SELECT i.id AS photo_id,
    'paint'::text AS photo_of,
    pi."position" + 1 AS photo_no,
    NULL::uuid AS defect_id,
    NULL::text AS defect_name,
    NULL::text AS disposition,
    NULL::uuid AS note_id,
    NULL::text AS note_text,
    NULL::uuid AS pt_record_id,
    x.id AS sample_id,
    x.session_id,
    s.seq AS session_no,
    x.index AS sample_no,
    x.order_id AS order_line_id,
    btrim(o.order_number) AS order_number,
    btrim(o.item_code) AS item_code,
    btrim(o.item) AS item,
    btrim(o.customer) AS customer,
    s.work_center_code AS machine_code,
    COALESCE(NULLIF(btrim(m.display_name), ''::text), 'Machine '::text || s.work_center_code) AS machine,
    COALESCE(m.factory, ''::text) AS factory,
    x.inspector_name AS recorded_by,
    x.shift::text AS shift,
    x.created_at AS recorded_at,
    ai.factory_day(x.created_at, current_setting('TimeZone'::text)) AS recorded_day,
    i.uploaded_at AS taken_at,
    i.uploaded_by_name AS taken_by
   FROM paint_sample_images pi
     JOIN images i ON i.id = pi.image_id AND i.deleted_at IS NULL
     JOIN paint_samples ps ON ps.id = pi.paint_sample_id AND ps.deleted_at IS NULL
     JOIN inspection_samples x ON x.id = ps.sample_id AND x.deleted_at IS NULL
     JOIN inspection_sessions s ON s.id = x.session_id AND s.deleted_at IS NULL
     JOIN production_orders o ON o.id = x.order_id
     LEFT JOIN machines m ON lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL;
COMMENT ON COLUMN ai.inspection_photos.recorded_day IS 'recorded_at''s factory day: ai.factory_day(recorded_at), 08:00 to 08:00 factory time.';

CREATE OR REPLACE VIEW ai.pdi_photos AS
 SELECT i.id AS photo_id,
    pi."position" + 1 AS photo_no,
    d.id AS pdi_id,
    COALESCE(btrim(o.order_number), ''::text) AS order_number,
    COALESCE(btrim(o.customer), ''::text) AS customer,
    d.created_by_name AS recorded_by,
    d.created_at AS recorded_at,
    ai.factory_day(d.created_at, current_setting('TimeZone'::text)) AS recorded_day,
    i.uploaded_at AS taken_at,
    i.uploaded_by_name AS taken_by
   FROM pdi_images pi
     JOIN images i ON i.id = pi.image_id AND i.deleted_at IS NULL
     JOIN pdi_documents d ON d.id = pi.pdi_id AND d.deleted_at IS NULL
     LEFT JOIN production_orders o ON o.id = d.order_id;
COMMENT ON COLUMN ai.pdi_photos.recorded_day IS 'recorded_at''s factory day: ai.factory_day(recorded_at), 08:00 to 08:00 factory time.';

-- An ERP date and a person's action keep the calendar.
COMMENT ON COLUMN ai.order_lines.order_day IS 'Calendar date of order_date in the factory''s time zone (an ERP date, not a factory day); the order list sorts and filters by it.';
COMMENT ON COLUMN ai.audit_log.day IS 'Calendar date of the change in the factory''s time zone.';

-- ---- Saved and scheduled reports: their periods are factory days --------------------
-- A report's period reaches its queries as {{from}} and {{to}}, two days. A
-- *_day column compared with them now reads factory days by itself; a
-- timestamp bounded by them ("recorded_at >= {{from}} AND recorded_at <
-- {{to}} + 1") still cut the period at midnight. Those two bounds become
-- 08:00 on the days (ai.factory_day_start), so "yesterday" is 08:00
-- yesterday to 08:00 today; nothing else in a query changes. Read and
-- written as the json text the column holds (its keys keep their order, a
-- line break in the SQL is "\n" there); the order of the lists (updated_at)
-- stays as it was, as this is no one's edit.

CREATE OR REPLACE FUNCTION pg_temp.factory_bounds(stored text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(
           regexp_replace($1,
             '([A-Za-z_][A-Za-z0-9_$]*_at)((?:\s|\\[ntr])*)>=((?:\s|\\[ntr])*)\{\{from\}\}',
             '\1\2>=\3ai.factory_day_start({{from}})', 'g'),
           '([A-Za-z_][A-Za-z0-9_$]*_at)((?:\s|\\[ntr])*)<((?:\s|\\[ntr])*)\{\{to\}\}(?:\s|\\[ntr])*\+(?:\s|\\[ntr])*1(?![0-9.])',
           '\1\2<\3ai.factory_day_start({{to}} + 1)', 'g')
$$;

ALTER TABLE ai_reports DISABLE TRIGGER ai_reports_updated_at;
UPDATE ai_reports SET sections = pg_temp.factory_bounds(sections::text)::json
 WHERE pg_temp.factory_bounds(sections::text) IS DISTINCT FROM sections::text;
ALTER TABLE ai_reports ENABLE TRIGGER ai_reports_updated_at;

ALTER TABLE ai_automations DISABLE TRIGGER ai_automations_updated_at;
UPDATE ai_automations SET schedule = pg_temp.factory_bounds(schedule::text)::json
 WHERE schedule IS NOT NULL AND pg_temp.factory_bounds(schedule::text) IS DISTINCT FROM schedule::text;
ALTER TABLE ai_automations ENABLE TRIGGER ai_automations_updated_at;

-- ---- Dimension verdicts, decided again in exact decimals -----------------------------
-- dimensionStatus (shared/src/rules.ts) over the stored numerics: Fail
-- outside nominal + |tol+| / nominal - |tol-|; Warning within a tenth of a
-- side's tolerance from its limit, the limit itself included; a side with no
-- tolerance is pass or fail. Only rows the rule judges (a reading and a full
-- specification); a row without them stays as it was recorded.

WITH judged AS (
  SELECT d.id, d.sample_id, d.status AS old_status,
         (CASE
            WHEN d.actual > d.nominal + abs(d.tol_plus) OR d.actual < d.nominal - abs(d.tol_minus) THEN 'Fail'
            WHEN d.actual >= d.nominal THEN
              CASE WHEN abs(d.tol_plus) = 0 THEN 'Pass'
                   WHEN (d.nominal + abs(d.tol_plus) - d.actual) * 10 <= abs(d.tol_plus) THEN 'Warning'
                   ELSE 'Pass' END
            ELSE
              CASE WHEN abs(d.tol_minus) = 0 THEN 'Pass'
                   WHEN (d.actual - (d.nominal - abs(d.tol_minus))) * 10 <= abs(d.tol_minus) THEN 'Warning'
                   ELSE 'Pass' END
          END)::dimension_status AS new_status
    FROM dimension_results d
   WHERE d.actual IS NOT NULL AND d.nominal IS NOT NULL AND d.tol_plus IS NOT NULL AND d.tol_minus IS NOT NULL
),
changed AS (
  UPDATE dimension_results d SET status = j.new_status, version = d.version + 1
    FROM judged j
   WHERE d.id = j.id AND d.status IS DISTINCT FROM j.new_status
  RETURNING d.id, d.sample_id, j.old_status, j.new_status
)
INSERT INTO audit_log (at, user_id, user_name, action, entity, entity_id, field, old_value, new_value,
                       order_number, item, work_center_code, session_id, sample_id)
SELECT now(), (SELECT u.id FROM users u WHERE u.is_system), 'System — exact tolerance check', 'update', 'DimensionResult', c.id::text,
       'status', c.old_status::text, c.new_status::text, o.order_number, o.item, s.work_center_code, s.id, c.sample_id
  FROM changed c
  JOIN inspection_samples x ON x.id = c.sample_id
  JOIN inspection_sessions s ON s.id = x.session_id
  LEFT JOIN production_orders o ON o.id = s.order_id
 ORDER BY s.id, c.sample_id, c.id;
