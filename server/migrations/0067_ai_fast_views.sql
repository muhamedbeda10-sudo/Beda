-- ============================================================================
-- §20 — the assistant's views, fast on any question.
--
-- The assistant writes its own queries over the views in schema ai, whatever
-- is asked. What made a question slow was never the question: it was the
-- views working out the same figures again on every read — a sample's
-- dimension and defect counts, a session's totals, its coils' material —
-- one subquery per row, per column, over the whole record. A question over
-- all of it, or one filtering on such a figure, paid that for every row.
--
-- Now those figures are kept as the record is written (the floor's way:
-- worked out once, at the save), and the views read them like any column:
--
--   • sample_rollups — per sample: its dimension rows (measured, pass,
--     warning, fail), its defects (records, pieces, by disposition), its PT
--     lengths (tested, rejected), its coils (as listed, and their material:
--     black, galvanized or mixed), and the sample's material (its coils',
--     else its order's expected grade's).
--   • session_rollups — per session: its samples and pieces, inspectors,
--     defects and dispositions, dimension fails, PT lengths, notes, stages.
--
-- Kept by statement triggers on every table they are worked out from, each
-- working the affected rows out again whole (never adding or subtracting, so
-- they cannot drift), under a row lock on the rollup so two saves of one
-- session cannot cross. The views keep every column, name and type as they
-- were (saved reports and automations run unchanged), and add:
--   • inspection_samples, dimension_measurements: coil_material, material;
--     dimension_measurements also expected_grade.
-- An index on the machine's key (ai.machine_key) lets a question about one
-- machine read only that machine's sessions.
--
-- Every figure is checked against its old definition by the tests
-- (aiRollups.test.ts); aiViewsPerf.test.ts holds every view to a time on a
-- factory's worth of rows.
-- ============================================================================

CREATE TABLE sample_rollups (
  sample_id             uuid PRIMARY KEY REFERENCES inspection_samples (id) ON DELETE CASCADE,
  dimension_rows        integer NOT NULL DEFAULT 0,
  dimensions_measured   integer NOT NULL DEFAULT 0,
  dimensions_pass       integer NOT NULL DEFAULT 0,
  dimensions_warning    integer NOT NULL DEFAULT 0,
  dimensions_fail       integer NOT NULL DEFAULT 0,
  defect_records        integer NOT NULL DEFAULT 0,
  defect_pieces         numeric NOT NULL DEFAULT 0,
  hold_records          integer NOT NULL DEFAULT 0,
  hold_pieces           numeric NOT NULL DEFAULT 0,
  rejected_pieces       numeric NOT NULL DEFAULT 0,
  repair_pieces         numeric NOT NULL DEFAULT 0,
  used_elsewhere_pieces numeric NOT NULL DEFAULT 0,
  concession_pieces     numeric NOT NULL DEFAULT 0,
  pt_lengths_tested     integer NOT NULL DEFAULT 0,
  pt_lengths_rejected   integer NOT NULL DEFAULT 0,
  coils                 text,
  coil_material         text CHECK (coil_material IN ('black', 'galvanized', 'mixed')),
  material              text
);

CREATE TABLE session_rollups (
  session_id            uuid PRIMARY KEY REFERENCES inspection_sessions (id) ON DELETE CASCADE,
  samples               integer NOT NULL DEFAULT 0,
  pieces_inspected      numeric NOT NULL DEFAULT 0,
  sample_inspectors     text,
  defect_records        integer NOT NULL DEFAULT 0,
  defect_pieces         numeric NOT NULL DEFAULT 0,
  hold_records          integer NOT NULL DEFAULT 0,
  hold_pieces           numeric NOT NULL DEFAULT 0,
  rejected_pieces       numeric NOT NULL DEFAULT 0,
  repair_pieces         numeric NOT NULL DEFAULT 0,
  used_elsewhere_pieces numeric NOT NULL DEFAULT 0,
  concession_pieces     numeric NOT NULL DEFAULT 0,
  dimension_fails       integer NOT NULL DEFAULT 0,
  pt_lengths_tested     integer NOT NULL DEFAULT 0,
  pt_lengths_rejected   integer NOT NULL DEFAULT 0,
  notes                 integer NOT NULL DEFAULT 0,
  stages                text,
  top_stage             integer
);

-- ---- Working them out ------------------------------------------------------------

/** A session's figures, worked out again whole from its samples' rollups and its own rows. */
CREATE FUNCTION refresh_session_rollups(ids uuid[]) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ids IS NULL OR cardinality(ids) = 0 THEN RETURN; END IF;
  INSERT INTO session_rollups (session_id)
  SELECT s.id FROM inspection_sessions s WHERE s.id = ANY (ids) ORDER BY s.id
  ON CONFLICT (session_id) DO NOTHING;
  -- One save at a time per session: the next works its figures out after this one is committed.
  PERFORM 1 FROM session_rollups WHERE session_id = ANY (ids) ORDER BY session_id FOR UPDATE;
  UPDATE session_rollups r SET
    samples = a.samples, pieces_inspected = a.pieces_inspected, sample_inspectors = a.sample_inspectors,
    defect_records = a.defect_records, defect_pieces = a.defect_pieces, hold_records = a.hold_records, hold_pieces = a.hold_pieces,
    rejected_pieces = a.rejected_pieces, repair_pieces = a.repair_pieces, used_elsewhere_pieces = a.used_elsewhere_pieces,
    concession_pieces = a.concession_pieces, dimension_fails = a.dimension_fails,
    pt_lengths_tested = a.pt_lengths_tested, pt_lengths_rejected = a.pt_lengths_rejected,
    notes = n.notes, stages = q.stages, top_stage = q.top_stage
  FROM inspection_sessions s
  CROSS JOIN LATERAL (
    SELECT count(*)::integer AS samples,
           COALESCE(sum(x.sample_qty), 0) AS pieces_inspected,
           string_agg(DISTINCT x.inspector_name, ', ') AS sample_inspectors,
           COALESCE(sum(sr.defect_records), 0)::integer AS defect_records,
           COALESCE(sum(sr.defect_pieces), 0) AS defect_pieces,
           COALESCE(sum(sr.hold_records), 0)::integer AS hold_records,
           COALESCE(sum(sr.hold_pieces), 0) AS hold_pieces,
           COALESCE(sum(sr.rejected_pieces), 0) AS rejected_pieces,
           COALESCE(sum(sr.repair_pieces), 0) AS repair_pieces,
           COALESCE(sum(sr.used_elsewhere_pieces), 0) AS used_elsewhere_pieces,
           COALESCE(sum(sr.concession_pieces), 0) AS concession_pieces,
           COALESCE(sum(sr.dimensions_fail), 0)::integer AS dimension_fails,
           COALESCE(sum(sr.pt_lengths_tested), 0)::integer AS pt_lengths_tested,
           COALESCE(sum(sr.pt_lengths_rejected), 0)::integer AS pt_lengths_rejected
      FROM inspection_samples x
      LEFT JOIN sample_rollups sr ON sr.sample_id = x.id
     WHERE x.session_id = s.id AND x.deleted_at IS NULL
  ) a
  CROSS JOIN LATERAL (
    SELECT count(*)::integer AS notes FROM session_notes sn WHERE sn.session_id = s.id AND sn.deleted_at IS NULL
  ) n
  CROSS JOIN LATERAL (
    SELECT string_agg((q.stage || ': ') || trim_scale(q.qty), ' · ' ORDER BY q.stage) AS stages, max(q.stage)::integer AS top_stage
      FROM session_stage_quantities q WHERE q.session_id = s.id AND q.deleted_at IS NULL
  ) q
  WHERE s.id = r.session_id AND r.session_id = ANY (ids);
END
$$;

/** A sample's figures, worked out again whole from its rows; then its session's. */
CREATE FUNCTION refresh_sample_rollups(ids uuid[]) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ids IS NULL OR cardinality(ids) = 0 THEN RETURN; END IF;
  INSERT INTO sample_rollups (sample_id)
  SELECT x.id FROM inspection_samples x WHERE x.id = ANY (ids) ORDER BY x.id
  ON CONFLICT (sample_id) DO NOTHING;
  PERFORM 1 FROM sample_rollups WHERE sample_id = ANY (ids) ORDER BY sample_id FOR UPDATE;
  UPDATE sample_rollups r SET
    dimension_rows = d.dimension_rows, dimensions_measured = d.dimensions_measured, dimensions_pass = d.dimensions_pass,
    dimensions_warning = d.dimensions_warning, dimensions_fail = d.dimensions_fail,
    defect_records = f.defect_records, defect_pieces = f.defect_pieces, hold_records = f.hold_records, hold_pieces = f.hold_pieces,
    rejected_pieces = f.rejected_pieces, repair_pieces = f.repair_pieces, used_elsewhere_pieces = f.used_elsewhere_pieces,
    concession_pieces = f.concession_pieces,
    pt_lengths_tested = t.tested, pt_lengths_rejected = t.rejected,
    coils = c.coils, coil_material = c.coil_material,
    material = CASE WHEN c.coil_material IN ('black', 'galvanized') THEN c.coil_material ELSE ai.material_kind(o.expected_grade) END
  FROM inspection_samples x
  JOIN production_orders o ON o.id = x.order_id
  CROSS JOIN LATERAL (
    SELECT count(*)::integer AS dimension_rows,
           count(*) FILTER (WHERE dr.actual IS NOT NULL)::integer AS dimensions_measured,
           count(*) FILTER (WHERE dr.actual IS NOT NULL AND dr.status = 'Pass')::integer AS dimensions_pass,
           count(*) FILTER (WHERE dr.actual IS NOT NULL AND dr.status = 'Warning')::integer AS dimensions_warning,
           count(*) FILTER (WHERE dr.status = 'Fail')::integer AS dimensions_fail
      FROM dimension_results dr WHERE dr.sample_id = x.id AND dr.deleted_at IS NULL
  ) d
  CROSS JOIN LATERAL (
    SELECT count(*)::integer AS defect_records,
           COALESCE(sum(df.qty), 0) AS defect_pieces,
           count(*) FILTER (WHERE df.disposition = 'Hold')::integer AS hold_records,
           COALESCE(sum(df.qty) FILTER (WHERE df.disposition = 'Hold'), 0) AS hold_pieces,
           COALESCE(sum(df.qty) FILTER (WHERE df.disposition = 'Rejected'), 0) AS rejected_pieces,
           COALESCE(sum(df.qty) FILTER (WHERE df.disposition = 'Repair'), 0) AS repair_pieces,
           COALESCE(sum(df.qty) FILTER (WHERE df.disposition = 'Used in another order'), 0) AS used_elsewhere_pieces,
           COALESCE(sum(df.qty) FILTER (WHERE df.disposition = 'Accept with concession'), 0) AS concession_pieces
      FROM defect_results df WHERE df.sample_id = x.id AND df.deleted_at IS NULL
  ) f
  CROSS JOIN LATERAL (
    SELECT count(*)::integer AS tested, count(*) FILTER (WHERE l.verdict = 'Reject / Repair')::integer AS rejected
      FROM pt_tested_lengths l JOIN pt_records pr ON pr.id = l.pt_record_id
     WHERE pr.sample_id = x.id AND pr.deleted_at IS NULL AND l.deleted_at IS NULL
  ) t
  CROSS JOIN LATERAL (
    SELECT string_agg(sc.coil_number, ', ' ORDER BY sc.coil_number) AS coils,
           CASE count(DISTINCT k.kind) FILTER (WHERE k.kind IN ('black', 'galvanized'))
             WHEN 0 THEN NULL
             WHEN 1 THEN max(k.kind) FILTER (WHERE k.kind IN ('black', 'galvanized'))
             ELSE 'mixed' END AS coil_material
      FROM sample_coils sc
      LEFT JOIN coils reg ON lower(reg.coil_number) = lower(sc.coil_number) AND reg.deleted_at IS NULL
      CROSS JOIN LATERAL (SELECT ai.material_kind(COALESCE(NULLIF(btrim(sc.grade), ''), NULLIF(btrim(reg.grade), ''))) AS kind) k
     WHERE sc.sample_id = x.id AND sc.deleted_at IS NULL
  ) c
  WHERE x.id = r.sample_id AND r.sample_id = ANY (ids);
  PERFORM refresh_session_rollups(ARRAY(SELECT DISTINCT x.session_id FROM inspection_samples x WHERE x.id = ANY (ids)));
END
$$;

-- ---- Kept as the record is written -------------------------------------------------
-- One trigger per table and event (transition tables allow no more); each passes the
-- rows' keys to the function above. TG_ARGV: the column naming the sample or session,
-- and which ('sample' or 'session').

CREATE FUNCTION rollups_after_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ids uuid[];
  col text := TG_ARGV[0];
BEGIN
  IF TG_OP = 'INSERT' THEN
    EXECUTE format('SELECT array_agg(DISTINCT %I) FROM new_rows', col) INTO ids;
  ELSIF TG_OP = 'DELETE' THEN
    EXECUTE format('SELECT array_agg(DISTINCT %I) FROM old_rows', col) INTO ids;
  ELSE
    EXECUTE format('SELECT array_agg(DISTINCT k) FROM (SELECT %1$I AS k FROM new_rows UNION SELECT %1$I FROM old_rows) u', col) INTO ids;
  END IF;
  ids := array_remove(ids, NULL);
  IF TG_ARGV[1] = 'session' THEN PERFORM refresh_session_rollups(ids); ELSE PERFORM refresh_sample_rollups(ids); END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION rollups_watch(tbl regclass, col text, target text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  name text := replace(tbl::text, '.', '_') || '_' || col;
BEGIN
  EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON %s REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION rollups_after_change(%L, %L)',
                 name || '_rollups_ins', tbl, col, target);
  EXECUTE format('CREATE TRIGGER %I AFTER UPDATE ON %s REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION rollups_after_change(%L, %L)',
                 name || '_rollups_upd', tbl, col, target);
  EXECUTE format('CREATE TRIGGER %I AFTER DELETE ON %s REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION rollups_after_change(%L, %L)',
                 name || '_rollups_del', tbl, col, target);
END
$$;

SELECT rollups_watch('dimension_results', 'sample_id', 'sample');
SELECT rollups_watch('defect_results', 'sample_id', 'sample');
SELECT rollups_watch('sample_coils', 'sample_id', 'sample');
SELECT rollups_watch('pt_records', 'sample_id', 'sample');
SELECT rollups_watch('session_notes', 'session_id', 'session');
SELECT rollups_watch('session_stage_quantities', 'session_id', 'session');
-- A sample: its own figures (made, moved to another order, deleted) and its sessions', the one it left too.
SELECT rollups_watch('inspection_samples', 'id', 'sample');
SELECT rollups_watch('inspection_samples', 'session_id', 'session');
-- A session made, or deleted and restored: its row.
SELECT rollups_watch('inspection_sessions', 'id', 'session');

/** PT lengths name their PT record, not the sample. */
CREATE FUNCTION rollups_after_pt_lengths() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ids uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT pr.sample_id) INTO ids FROM new_rows l JOIN pt_records pr ON pr.id = l.pt_record_id;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT pr.sample_id) INTO ids FROM old_rows l JOIN pt_records pr ON pr.id = l.pt_record_id;
  ELSE
    SELECT array_agg(DISTINCT pr.sample_id) INTO ids
      FROM (SELECT pt_record_id FROM new_rows UNION SELECT pt_record_id FROM old_rows) l JOIN pt_records pr ON pr.id = l.pt_record_id;
  END IF;
  PERFORM refresh_sample_rollups(ids);
  RETURN NULL;
END
$$;
CREATE TRIGGER pt_tested_lengths_rollups_ins AFTER INSERT ON pt_tested_lengths REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION rollups_after_pt_lengths();
CREATE TRIGGER pt_tested_lengths_rollups_upd AFTER UPDATE ON pt_tested_lengths REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION rollups_after_pt_lengths();
CREATE TRIGGER pt_tested_lengths_rollups_del AFTER DELETE ON pt_tested_lengths REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION rollups_after_pt_lengths();

/** The coil register: a coil's grade (and so its material) reaches the samples it was used in. Only a change that matters. */
CREATE FUNCTION rollups_after_coils() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE numbers text[]; ids uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT lower(coil_number)) INTO numbers FROM new_rows;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT lower(coil_number)) INTO numbers FROM old_rows;
  ELSE
    SELECT array_agg(DISTINCT k) INTO numbers FROM (
      SELECT lower(n.coil_number) AS k FROM new_rows n JOIN old_rows o ON o.id = n.id
       WHERE n.coil_number IS DISTINCT FROM o.coil_number OR n.grade IS DISTINCT FROM o.grade OR n.deleted_at IS DISTINCT FROM o.deleted_at
      UNION
      SELECT lower(o.coil_number) FROM new_rows n JOIN old_rows o ON o.id = n.id
       WHERE n.coil_number IS DISTINCT FROM o.coil_number OR n.grade IS DISTINCT FROM o.grade OR n.deleted_at IS DISTINCT FROM o.deleted_at) u;
  END IF;
  IF numbers IS NULL THEN RETURN NULL; END IF;
  SELECT array_agg(DISTINCT sc.sample_id) INTO ids FROM sample_coils sc WHERE lower(sc.coil_number) = ANY (numbers);
  PERFORM refresh_sample_rollups(ids);
  RETURN NULL;
END
$$;
CREATE TRIGGER coils_rollups_ins AFTER INSERT ON coils REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION rollups_after_coils();
CREATE TRIGGER coils_rollups_upd AFTER UPDATE ON coils REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION rollups_after_coils();
CREATE TRIGGER coils_rollups_del AFTER DELETE ON coils REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION rollups_after_coils();

/** An order line's expected grade (the ERP sync changes it) reaches its samples' material. Only that change. */
CREATE FUNCTION rollups_after_orders() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ids uuid[];
BEGIN
  SELECT array_agg(x.id) INTO ids
    FROM new_rows n JOIN old_rows o ON o.id = n.id JOIN inspection_samples x ON x.order_id = n.id
   WHERE n.expected_grade IS DISTINCT FROM o.expected_grade;
  PERFORM refresh_sample_rollups(ids);
  RETURN NULL;
END
$$;
CREATE TRIGGER production_orders_rollups_upd AFTER UPDATE ON production_orders REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION rollups_after_orders();

-- The app's alone: nobody else (the assistant's readers included) calls them.
REVOKE EXECUTE ON FUNCTION refresh_session_rollups(uuid[]), refresh_sample_rollups(uuid[]), rollups_watch(regclass, text, text),
  rollups_after_change(), rollups_after_pt_lengths(), rollups_after_coils(), rollups_after_orders() FROM PUBLIC;

-- ---- What is there already ---------------------------------------------------------------

SELECT refresh_sample_rollups(ARRAY(SELECT id FROM inspection_samples));
-- Sessions without samples too.
SELECT refresh_session_rollups(ARRAY(SELECT id FROM inspection_sessions));

-- ---- One machine's sessions, found by its key ------------------------------------------------

CREATE INDEX inspection_sessions_machine_key_idx ON inspection_sessions (ai.machine_key(work_center_code), started_at) WHERE deleted_at IS NULL;

-- ---- The views ---------------------------------------------------------------------------------

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
    (defect_pieces = (0)::double precision) AS first_pass,
    coil_material,
    material
   FROM ( SELECT x.id AS sample_id,
            x.session_id,
            s.seq AS session_no,
            x.index AS sample_no,
            (s.status)::text AS session_status,
            x.order_id AS order_line_id,
            btrim(o.order_number) AS order_number,
            (upper(btrim(o.order_number)) = 'STOCK'::text) AS is_stock,
            btrim(o.item_code) AS item_code,
            btrim(o.item) AS item,
            btrim(o.customer) AS customer,
            btrim(o.expected_grade) AS expected_grade,
            s.work_center_code AS machine_code,
            COALESCE(NULLIF(btrim(m.display_name), ''::text), ('Machine '::text || s.work_center_code)) AS machine,
            COALESCE(m.factory, ''::text) AS factory,
            COALESCE(m.process, 'universal'::text) AS process,
            (m.on_dashboard IS NOT FALSE) AS counts_on_dashboard,
            x.inspector_id,
            x.inspector_name AS inspector,
            x.created_at AS recorded_at,
            ((x.created_at AT TIME ZONE current_setting('TimeZone'::text)))::date AS recorded_day,
            (x.shift)::text AS shift,
                CASE x.shift
                    WHEN 'A'::shift_letter THEN 'Morning'::text
                    WHEN 'B'::shift_letter THEN 'Afternoon'::text
                    ELSE 'Night'::text
                END AS shift_name,
            (x.sample_qty)::double precision AS sample_qty,
            x.drawing,
            x.drawing_alt,
            x.issue AS drawing_issue,
            COALESCE(sr.dimension_rows, 0) AS dimension_rows,
            COALESCE(sr.dimensions_measured, 0) AS dimensions_measured,
            COALESCE(sr.dimensions_pass, 0) AS dimensions_pass,
            COALESCE(sr.dimensions_warning, 0) AS dimensions_warning,
            COALESCE(sr.dimensions_fail, 0) AS dimensions_fail,
            COALESCE(sr.defect_records, 0) AS defect_records,
            (COALESCE(sr.defect_pieces, (0)::numeric))::double precision AS defect_pieces,
            COALESCE(sr.hold_records, 0) AS hold_records,
            sr.coils,
            (x.grade_ack_at IS NOT NULL) AS grade_mismatch_acknowledged,
            x.grade_ack_by_name AS grade_ack_by,
            x.grade_ack_at,
            x.grade_ack_expected_grade,
            array_to_string(x.grade_ack_found_grades, ', '::text) AS grade_ack_found_grades,
            array_to_string(x.grade_ack_coil_numbers, ', '::text) AS grade_ack_coils,
            ( SELECT p.notes
                   FROM paint_samples p
                  WHERE ((p.sample_id = x.id) AND (p.deleted_at IS NULL))) AS paint_notes,
            ( SELECT (p.accept_or_repair)::text AS accept_or_repair
                   FROM pt_records p
                  WHERE ((p.sample_id = x.id) AND (p.deleted_at IS NULL))) AS pt_verdict,
            x.updated_at AS last_changed_at,
            sr.coil_material,
            sr.material
           FROM ((((inspection_samples x
             JOIN inspection_sessions s ON (((s.id = x.session_id) AND (s.deleted_at IS NULL))))
             JOIN production_orders o ON ((o.id = x.order_id)))
             LEFT JOIN machines m ON (((lower(m.code) = lower(s.work_center_code)) AND (m.deleted_at IS NULL))))
             LEFT JOIN sample_rollups sr ON ((sr.sample_id = x.id)))
          WHERE (x.deleted_at IS NULL)) b;

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
            WHEN ((status = 'Closed'::text) AND (final_qty > (0)::double precision)) THEN round((((defect_pieces / final_qty) * (100)::double precision))::numeric, 1)
            ELSE NULL::numeric
        END AS defect_rate_pct,
        CASE
            WHEN (pieces_inspected > (0)::double precision) THEN round((((defect_pieces / pieces_inspected) * (100)::double precision))::numeric, 1)
            ELSE NULL::numeric
        END AS inspected_defect_pct,
        CASE
            WHEN ((process = 'welding'::text) AND (status = 'Closed'::text) AND (final_qty IS NOT NULL)) THEN
            CASE
                WHEN (final_qty <= (0)::double precision) THEN 0
                ELSE (ceil((((final_qty * (5)::double precision) / (100.0)::double precision) - (0.000000001)::double precision)))::integer
            END
            ELSE NULL::integer
        END AS pt_lengths_required
   FROM ( SELECT s.id AS session_id,
            s.seq AS session_no,
            (s.status)::text AS status,
            s.order_id AS order_line_id,
            btrim(o.order_number) AS order_number,
            (upper(btrim(o.order_number)) = 'STOCK'::text) AS is_stock,
            o.line_key AS order_line_key,
            btrim(o.item_code) AS item_code,
            btrim(o.item) AS item,
            btrim(o.customer) AS customer,
            btrim(o.expected_grade) AS expected_grade,
            btrim(o.erp_status) AS erp_status,
            (o.deleted_at IS NOT NULL) AS order_line_retired,
            s.work_center_code AS machine_code,
            COALESCE(NULLIF(btrim(m.display_name), ''::text), ('Machine '::text || s.work_center_code)) AS machine,
            COALESCE(m.factory, ''::text) AS factory,
            COALESCE(m.process, 'universal'::text) AS process,
            (m.on_dashboard IS NOT FALSE) AS counts_on_dashboard,
            s.inspector_id AS opened_by_id,
            s.inspector_name AS opened_by,
            sr.sample_inspectors,
            s.started_at,
            ((s.started_at AT TIME ZONE current_setting('TimeZone'::text)))::date AS started_day,
            s.closed_at,
            ((s.closed_at AT TIME ZONE current_setting('TimeZone'::text)))::date AS closed_day,
                CASE
                    WHEN (s.closed_at IS NULL) THEN NULL::text
                    ELSE COALESCE(( SELECT u.name
                       FROM users u
                      WHERE (u.id = s.closed_by_id)), 'Unknown'::text)
                END AS closed_by,
            (
                CASE
                    WHEN ((s.start_qty_at IS NOT NULL) AND (s.start_qty_by_id IS NOT NULL)) THEN s.start_qty
                    ELSE NULL::numeric
                END)::double precision AS rejected_before_release,
            s.start_qty_by_name AS rejected_before_release_by,
            (COALESCE(s.start_qty, (0)::numeric) = (0)::numeric) AS first_part_clean,
            (s.final_qty)::double precision AS final_qty,
            (
                CASE
                    WHEN (upper(btrim(o.order_number)) = 'STOCK'::text) THEN s.produced_qty
                    ELSE NULL::numeric
                END)::double precision AS produced_qty_stock,
            s.universal_kind,
            sr.stages,
            sr.top_stage,
            COALESCE(sr.samples, 0) AS samples,
            (COALESCE(sr.pieces_inspected, (0)::numeric))::double precision AS pieces_inspected,
            COALESCE(sr.defect_records, 0) AS defect_records,
            (COALESCE(sr.defect_pieces, (0)::numeric))::double precision AS defect_pieces,
            COALESCE(sr.hold_records, 0) AS hold_records,
            (COALESCE(sr.hold_pieces, (0)::numeric))::double precision AS hold_pieces,
            (COALESCE(sr.rejected_pieces, (0)::numeric))::double precision AS disposition_rejected_pieces,
            (COALESCE(sr.repair_pieces, (0)::numeric))::double precision AS disposition_repair_pieces,
            (COALESCE(sr.used_elsewhere_pieces, (0)::numeric))::double precision AS disposition_used_elsewhere_pieces,
            (COALESCE(sr.concession_pieces, (0)::numeric))::double precision AS disposition_concession_pieces,
            COALESCE(sr.dimension_fails, 0) AS dimension_fails,
            COALESCE(sr.pt_lengths_tested, 0) AS pt_lengths_tested,
            COALESCE(sr.pt_lengths_rejected, 0) AS pt_lengths_rejected,
            COALESCE(sr.notes, 0) AS notes,
            (EXISTS ( SELECT 1
                   FROM ((((production_orders o1
                     JOIN production_orders o2 ON (((lower(o2.order_number) = lower(o1.order_number)) AND (lower(o2.item_code) = lower(o1.item_code)) AND (lower(btrim(o2.item)) = lower(btrim(o1.item))))))
                     JOIN inspection_sessions s2 ON (((s2.order_id = o2.id) AND (s2.id <> s.id) AND (s2.deleted_at IS NULL))))
                     JOIN inspection_samples x2 ON (((x2.session_id = s2.id) AND (x2.deleted_at IS NULL))))
                     JOIN defect_results d2 ON (((d2.sample_id = x2.id) AND (d2.deleted_at IS NULL))))
                  WHERE ((o1.id = s.order_id) AND (btrim(o1.item_code) <> ''::text) AND ((lower(s2.work_center_code) <> lower(s.work_center_code)) OR (s2.started_at < s.started_at))))) AS prior_defects_elsewhere
           FROM (((inspection_sessions s
             JOIN production_orders o ON ((o.id = s.order_id)))
             LEFT JOIN machines m ON (((lower(m.code) = lower(s.work_center_code)) AND (m.deleted_at IS NULL))))
             LEFT JOIN session_rollups sr ON ((sr.session_id = s.id)))
          WHERE (s.deleted_at IS NULL)) b;

CREATE OR REPLACE VIEW ai.production_sessions AS
SELECT s.id AS session_id,
    s.seq AS session_no,
    s.order_id AS order_line_id,
    s.work_center_code AS machine_code,
    COALESCE(NULLIF(btrim(m.display_name), ''::text), ('Machine '::text || s.work_center_code)) AS machine,
    COALESCE(m.factory, ''::text) AS factory,
    COALESCE(m.process, 'universal'::text) AS process,
    btrim(o.order_number) AS order_number,
    btrim(o.item_code) AS item_code,
    btrim(o.item) AS item,
    btrim(o.customer) AS customer,
    s.closed_at,
    ((s.closed_at AT TIME ZONE current_setting('TimeZone'::text)))::date AS closed_day,
    to_char((s.closed_at AT TIME ZONE current_setting('TimeZone'::text)), 'YYYY-MM'::text) AS closed_month,
    (s.final_qty)::double precision AS final_qty,
    s.universal_kind,
    (COALESCE((m.process = 'universal'::text), false) AND (upper(btrim(o.order_number)) <> 'STOCK'::text) AND (s.universal_kind IS DISTINCT FROM 'final'::text)) AS counted_once_per_line,
    (COALESCE(o.finished_qty, (0)::numeric))::double precision AS sheet_finished_qty,
    (( SELECT max(q.stage) AS max
           FROM session_stage_quantities q
          WHERE ((q.session_id = s.id) AND (q.deleted_at IS NULL))))::integer AS top_stage,
    ( SELECT jsonb_object_agg((q.stage)::text, q.qty) AS jsonb_object_agg
           FROM session_stage_quantities q
          WHERE ((q.session_id = s.id) AND (q.deleted_at IS NULL))) AS stage_quantities,
    (COALESCE(sr.defect_pieces, (0)::numeric))::double precision AS defect_pieces,
    (m.on_dashboard IS NOT FALSE) AS counts_on_dashboard
   FROM (((inspection_sessions s
     JOIN production_orders o ON ((o.id = s.order_id)))
     LEFT JOIN machines m ON (((lower(m.code) = lower(s.work_center_code)) AND (m.deleted_at IS NULL))))
     LEFT JOIN session_rollups sr ON ((sr.session_id = s.id)))
  WHERE ((s.deleted_at IS NULL) AND (s.status = 'Closed'::session_status) AND (s.final_qty IS NOT NULL) AND (s.closed_at IS NOT NULL));

CREATE OR REPLACE VIEW ai.order_lines AS
SELECT o.id AS order_line_id,
    btrim(o.line_key) AS line_key,
    btrim(o.order_number) AS order_number,
    btrim(o.item_code) AS item_code,
    btrim(o.item) AS item,
    btrim(o.work_center_code) AS machine_code,
        CASE
            WHEN (btrim(o.work_center_code) = ''::text) THEN ''::text
            ELSE COALESCE(NULLIF(btrim(m.display_name), ''::text), ('Machine '::text || btrim(o.work_center_code)))
        END AS machine,
    COALESCE(btrim(m.factory), ''::text) AS factory,
    m.process,
    (NOT (EXISTS ( SELECT 1
           FROM machines d
          WHERE ((lower(d.code) = lower(o.work_center_code)) AND (d.deleted_at IS NULL) AND (d.on_dashboard = false))))) AS counts_on_dashboard,
    btrim(o.erp_status) AS erp_status,
    ((lower(btrim(o.erp_status)) ~~ 'cancel%'::text) OR (o.erp_status ~~ '%ملغ%'::text) OR (o.erp_status ~~ '%لغاء%'::text)) AS is_cancelled,
    (upper(btrim(o.order_number)) = 'STOCK'::text) AS is_stock_line,
    (o.required_qty)::double precision AS required_qty,
    (o.finished_qty)::double precision AS finished_qty,
    (GREATEST((0)::numeric, (o.required_qty - o.finished_qty)))::double precision AS remaining_qty,
    btrim(o.customer) AS customer,
    btrim(o.expected_grade) AS expected_grade,
    btrim(o.material) AS material,
    btrim(o.drawing) AS drawing,
    NULLIF(btrim(o.drawing_alt), ''::text) AS drawing_alt,
    NULLIF(btrim(o.issue), ''::text) AS drawing_issue,
    btrim(o.type) AS order_type,
    btrim(o.colour) AS colour,
    o.order_date,
    ((o.order_date AT TIME ZONE current_setting('TimeZone'::text)))::date AS order_day,
    (( SELECT count(*) AS count
           FROM inspection_sessions s
          WHERE ((s.order_id = o.id) AND (s.deleted_at IS NULL))))::integer AS sessions,
    (( SELECT count(*) AS count
           FROM inspection_sessions s
          WHERE ((s.order_id = o.id) AND (s.deleted_at IS NULL) AND (s.status = 'Open'::session_status))))::integer AS open_sessions,
    (( SELECT count(*) AS count
           FROM (inspection_samples x
             JOIN inspection_sessions s ON (((s.id = x.session_id) AND (s.deleted_at IS NULL))))
          WHERE ((x.order_id = o.id) AND (x.deleted_at IS NULL))))::integer AS samples,
    (( SELECT COALESCE(sum(sr.defect_pieces), (0)::numeric) AS "coalesce"
           FROM ((inspection_samples x
             JOIN inspection_sessions s ON (((s.id = x.session_id) AND (s.deleted_at IS NULL))))
             JOIN sample_rollups sr ON ((sr.sample_id = x.id)))
          WHERE ((x.order_id = o.id) AND (x.deleted_at IS NULL))))::double precision AS defect_pieces,
    ( SELECT max(x.created_at) AS max
           FROM (inspection_samples x
             JOIN inspection_sessions s ON (((s.id = x.session_id) AND (s.deleted_at IS NULL))))
          WHERE ((x.order_id = o.id) AND (x.deleted_at IS NULL))) AS last_inspected_at,
    (( SELECT count(*) AS count
           FROM (pdi_lines pl
             JOIN pdi_documents d ON (((d.id = pl.pdi_id) AND (d.deleted_at IS NULL))))
          WHERE (pl.order_id = o.id)))::integer AS pdi_count,
    ( SELECT COALESCE(r.finished_at, r.started_at) AS "coalesce"
           FROM order_sync_runs r
          WHERE (r.id = o.last_sync_run_id)) AS last_seen_by_sync_at,
    o.updated_at AS last_changed_at,
    o.due_date,
    o.refined_date,
    NULLIF(btrim(o.planning_week), ''::text) AS planning_week,
        CASE
            WHEN (o.planning_week ~ '^\s*(0?[1-9]|[1-4][0-9]|5[0-3])\s*/\s*[0-9]{4}\s*$'::text) THEN ("substring"(o.planning_week, '^\s*([0-9]{1,2})'::text))::integer
            ELSE NULL::integer
        END AS planning_week_no,
        CASE
            WHEN (o.planning_week ~ '^\s*(0?[1-9]|[1-4][0-9]|5[0-3])\s*/\s*[0-9]{4}\s*$'::text) THEN ("substring"(o.planning_week, '([0-9]{4})\s*$'::text))::integer
            ELSE NULL::integer
        END AS planning_week_year,
    (o.erp_remaining_qty)::double precision AS erp_remaining_qty,
    (o.cancelled_qty)::double precision AS cancelled_qty,
    (o.accepted_qty)::double precision AS accepted_qty,
    (o.stock_qty)::double precision AS stock_qty,
    (o.length_mm)::double precision AS length_mm,
    (o.width_mm)::double precision AS width_mm,
    (o.thickness_mm)::double precision AS thickness_mm,
    (o.weight_kg)::double precision AS weight_kg,
    NULLIF(btrim(o.stage), ''::text) AS stage,
    NULLIF(btrim(o.qc_category), ''::text) AS qc_category,
    NULLIF(btrim(o.version_parent_id), ''::text) AS version_parent_id,
    NULLIF(btrim(o.parent_id), ''::text) AS parent_id,
    (o.part_duration_hours)::double precision AS part_duration_hours,
    NULLIF(btrim(o.model_group_id), ''::text) AS model_group_id,
    (o.total_area_m2)::double precision AS total_area_m2,
    (o.total_powder_kg)::double precision AS total_powder_kg,
    NULLIF(btrim(o.erp_order_type), ''::text) AS erp_order_type,
    (o.raw_material_qty)::double precision AS raw_material_qty,
    NULLIF(btrim(o.coil_serial_number), ''::text) AS coil_serial_number,
    NULLIF(btrim(o.raw_material_powder), ''::text) AS raw_material_powder,
    NULLIF(btrim(o.item_family), ''::text) AS item_family,
    NULLIF(btrim(o.item_translation), ''::text) AS item_translation,
    (o.total_actual_sample_qty)::double precision AS total_actual_sample_qty,
    (o.total_hold_qty)::double precision AS total_hold_qty,
    (o.total_std_sample_qty)::double precision AS total_std_sample_qty,
    (o.total_rem_qc_record_qty)::double precision AS total_rem_qc_record_qty,
    o.planned_start,
    o.planned_finish,
    NULLIF(btrim(o.shipping_status), ''::text) AS shipping_status,
    o.shipping_start_date,
    o.shipping_end_date,
    NULLIF(btrim(o.bom_id), ''::text) AS bom_id,
    (o.rm_received_qty)::double precision AS rm_received_qty,
    o.rm_receiving_date,
    o.delay_reason_code,
    (o.delay_period)::double precision AS delay_period,
    NULLIF(btrim(o.delay_comment), ''::text) AS delay_comment,
    NULLIF(btrim(o.status_reason), ''::text) AS status_reason,
    o.rm_promise_date
   FROM (production_orders o
     LEFT JOIN LATERAL ( SELECT m_1.display_name,
            m_1.factory,
            m_1.process
           FROM machines m_1
          WHERE ((ai.machine_key(m_1.code) = ai.machine_key(o.work_center_code)) AND (m_1.deleted_at IS NULL))
          ORDER BY m_1.created_at
         LIMIT 1) m ON (true))
  WHERE (o.deleted_at IS NULL);

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
    COALESCE(NULLIF(btrim(m.display_name), ''::text), ('Machine '::text || s.work_center_code)) AS machine,
    COALESCE(m.factory, ''::text) AS factory,
    COALESCE(m.process, 'universal'::text) AS process,
    (m.on_dashboard IS NOT FALSE) AS counts_on_dashboard,
    x.inspector_name AS inspector,
    x.created_at AS recorded_at,
    ((x.created_at AT TIME ZONE current_setting('TimeZone'::text)))::date AS recorded_day,
    c.coil_number,
    (c.coil_id IS NOT NULL) AS picked_from_register,
    COALESCE(NULLIF(btrim(c.supplier), ''::text), NULLIF(btrim(r.supplier), ''::text)) AS supplier,
    COALESCE(NULLIF(btrim(c.grade), ''::text), NULLIF(btrim(r.grade), ''::text)) AS grade,
    ai.material_kind(COALESCE(NULLIF(btrim(c.grade), ''::text), NULLIF(btrim(r.grade), ''::text))) AS material_kind,
    COALESCE(c.thickness, r.thickness) AS thickness_mm,
    COALESCE(c.width, r.width) AS width_mm,
    COALESCE(c.yield, r.yield) AS yield_strength,
    COALESCE(NULLIF(btrim(c.sm_type), ''::text), NULLIF(btrim(r.sm_type), ''::text)) AS sm_type,
    c.notes,
    (x.grade_ack_at IS NOT NULL) AS grade_mismatch_acknowledged,
    (x.sample_qty)::double precision AS sample_qty,
    (COALESCE(sr.defect_pieces, (0)::numeric))::double precision AS sample_defect_pieces,
    COALESCE(NULLIF(btrim(c.supplier), ''::text), '(unknown supplier)'::text) AS dashboard_supplier,
    COALESCE(NULLIF(btrim(c.grade), ''::text), '—'::text) AS dashboard_grade
   FROM ((((((sample_coils c
     JOIN inspection_samples x ON (((x.id = c.sample_id) AND (x.deleted_at IS NULL))))
     JOIN inspection_sessions s ON (((s.id = x.session_id) AND (s.deleted_at IS NULL))))
     JOIN production_orders o ON ((o.id = x.order_id)))
     LEFT JOIN coils r ON (((lower(r.coil_number) = lower(c.coil_number)) AND (r.deleted_at IS NULL))))
     LEFT JOIN machines m ON (((lower(m.code) = lower(s.work_center_code)) AND (m.deleted_at IS NULL))))
     LEFT JOIN sample_rollups sr ON ((sr.sample_id = x.id)))
  WHERE (c.deleted_at IS NULL);

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
    COALESCE(NULLIF(btrim(m.display_name), ''::text), ('Machine '::text || s.work_center_code)) AS machine,
    COALESCE(m.factory, ''::text) AS factory,
    COALESCE(m.process, 'universal'::text) AS process,
    x.inspector_name AS inspector,
    x.created_at AS recorded_at,
    ((x.created_at AT TIME ZONE current_setting('TimeZone'::text)))::date AS recorded_day,
    (x.shift)::text AS shift,
    r.sequence,
    r.name AS dimension,
    r.nominal,
    r.tol_plus,
    r.tol_minus,
    (r.nominal + abs(r.tol_plus)) AS upper_limit,
    (r.nominal - abs(r.tol_minus)) AS lower_limit,
    r.actual,
    (r.actual - r.nominal) AS deviation,
    r.unit,
    (r.status)::text AS status,
    (r.source)::text AS spec_source,
    (lower(btrim(r.name)) = 'paint thickness'::text) AS is_paint_thickness,
    btrim(o.expected_grade) AS expected_grade,
    sr.coil_material,
    sr.material
   FROM (((((dimension_results r
     JOIN inspection_samples x ON (((x.id = r.sample_id) AND (x.deleted_at IS NULL))))
     JOIN inspection_sessions s ON (((s.id = x.session_id) AND (s.deleted_at IS NULL))))
     JOIN production_orders o ON ((o.id = x.order_id)))
     LEFT JOIN machines m ON (((lower(m.code) = lower(s.work_center_code)) AND (m.deleted_at IS NULL))))
     LEFT JOIN sample_rollups sr ON ((sr.sample_id = x.id)))
  WHERE (r.deleted_at IS NULL);

COMMENT ON COLUMN ai.inspection_samples.coil_material IS 'The material of the coils listed on the sample, from their grades: black, galvanized, mixed (both), or null (no coil listed, or none of a known grade).';
COMMENT ON COLUMN ai.inspection_samples.material IS 'The sample''s material, black or galvanized: its coils'' when they agree, else that of its order line''s expected grade (ai.material_kind). The one to split figures by material; no join to sample_coils needed.';
COMMENT ON COLUMN ai.dimension_measurements.expected_grade IS 'The steel grade the order line expects.';
COMMENT ON COLUMN ai.dimension_measurements.coil_material IS 'The material of the sample''s coils: black, galvanized, mixed (both), or null.';
COMMENT ON COLUMN ai.dimension_measurements.material IS 'The sample''s material, black or galvanized: its coils'' when they agree, else that of its order line''s expected grade. The one to split SPC or capability by material; no join to sample_coils needed.';
