-- ============================================================================
-- 0031 — the administrators' AI assistant (§20).
--   • schema ai — curated, read-only views of the factory record. They are
--     the ONLY objects the assistant's database role may read: each view runs
--     with its owner's rights (security_invoker stays off), so the reader needs
--     SELECT on these views and nothing at all in public. Their comments are
--     the data dictionary the model reads.
--   • the reader role, one per database (<database>_ai_reader): dev and test
--     share a cluster with different secrets, so one fixed name would have its
--     password flipped back and forth. It is created here without LOGIN; the
--     API gives it LOGIN and a password derived from JWT_SECRET at start.
--   • ai_credentials — the Anthropic API key an administrator set, encrypted.
--   • ai_conversations / ai_turns / ai_messages / ai_queries — each person's
--     conversations, kept as the exact transcript sent to the model (json,
--     never jsonb: jsonb reorders keys, and Claude checks the bytes).
--   • ai_usage — one row per call to the model, for the monthly cap.
--
-- Days and months in the views are factory days: every *_day / *_month column
-- converts with current_setting('TimeZone'). The query runner sets the session
-- time zone to FACTORY_TIMEZONE in each transaction (the role's default is set
-- at start too), which also makes the assistant's literal timestamps factory
-- time.
--
-- The ai part is idempotent (CREATE OR REPLACE, IF NOT EXISTS): the role
-- outlives a dropped schema, and the test harness drops and rebuilds both.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS ai;
REVOKE ALL ON SCHEMA ai FROM PUBLIC;
COMMENT ON SCHEMA ai IS 'Read-only views of the QC inspection records for the AI assistant. Soft-deleted rows are excluded everywhere. Days/months are factory days (session TimeZone).';

-- ---- Helpers -----------------------------------------------------------------

-- The machine-code comparison of NORMALISED_CODE (server/src/modules/sessions.routes.ts:119):
-- Arabic-Indic digits to Western, whitespace dropped, lower case, a purely numeric code without leading zeros.
CREATE OR REPLACE FUNCTION ai.machine_key(code text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN regexp_replace(lower(translate($1, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789')), '\s+', '', 'g') ~ '^[0-9]+$'
              THEN COALESCE(NULLIF(ltrim(regexp_replace(lower(translate($1, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789')), '\s+', '', 'g'), '0'), ''), '0')
              ELSE regexp_replace(lower(translate($1, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789')), '\s+', '', 'g') END
$$;
COMMENT ON FUNCTION ai.machine_key(text) IS 'Machine code made comparable: "STAM 24", "stam24" and "024" give the same key. Compare ai.machine_key(a) = ai.machine_key(b).';

-- materialOfGrade (shared/src/kpi.ts:1275): black or galvanized steel from a coil grade.
CREATE OR REPLACE FUNCTION ai.material_kind(grade text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
           WHEN upper(btrim(COALESCE($1, ''))) = '' THEN 'unknown'
           WHEN upper(btrim($1)) ~ '\+\s*A?Z' THEN 'galvanized'
           WHEN upper(btrim($1)) ~ '(^|[^A-Z0-9])DX5[1-7]D' THEN 'galvanized'
           WHEN upper(btrim($1)) ~ '(^|[^A-Z0-9])S[0-9]{3}GD' THEN 'galvanized'
           WHEN upper(btrim($1)) ~ '(^|[^A-Z])(GI|GALV)' THEN 'galvanized'
           ELSE 'black'
         END
$$;
COMMENT ON FUNCTION ai.material_kind(text) IS 'black | galvanized | unknown, from a steel grade (+Z/+AZ coatings, DX51D..DX57D, S###GD, GI/GALV are galvanized; any other grade is black; no grade is unknown).';

-- ---- Master data -------------------------------------------------------------

CREATE OR REPLACE VIEW ai.machines AS
SELECT m.id                                                         AS machine_id,
       m.code                                                       AS machine_code,
       COALESCE(NULLIF(btrim(m.display_name), ''), 'Machine ' || m.code) AS machine,
       m.name                                                       AS work_centre_name,
       m.line                                                       AS production_line,
       m.machine_number,
       COALESCE(m.factory, '')                                      AS factory,
       m.process,
       m.uses_item_dimensions,
       m.on_dashboard,
       ai.machine_key(m.code) = '21'                                AS makes_to_stock,
       m.created_at                                                 AS registered_at
  FROM machines m
 WHERE m.deleted_at IS NULL;
COMMENT ON VIEW ai.machines IS 'The machine register (one row per active machine). Sessions, order lines and defect lists refer to a machine by machine_code.';
COMMENT ON COLUMN ai.machines.machine_code IS 'Unique machine code (case-insensitive). Stored elsewhere as work_center_code / machine_code.';
COMMENT ON COLUMN ai.machines.machine IS 'Display name as the floor labels it, e.g. "58-A. Welding Line-LM4".';
COMMENT ON COLUMN ai.machines.process IS 'forming (roll forming/fabrication) | welding | paint | universal (presses, benders, mast machines, others). Decides the inspection steps.';
COMMENT ON COLUMN ai.machines.uses_item_dimensions IS 'Whether inspections load the item''s configured dimensions (never on universal machines).';
COMMENT ON COLUMN ai.machines.on_dashboard IS 'false = inspected but left out of every dashboard figure (e.g. manual welding).';
COMMENT ON COLUMN ai.machines.makes_to_stock IS 'The 400-ton press (code 21) that makes right+left connectors for stock; its sessions run against a fixed STOCK line.';

CREATE OR REPLACE VIEW ai.users AS
SELECT u.id          AS user_id,
       u.name,
       u.role::text  AS role,
       u.is_active,
       u.created_at,
       u.last_login_at
  FROM users u
 WHERE u.deleted_at IS NULL;
COMMENT ON VIEW ai.users IS 'Accounts (removed accounts excluded). Records keep the person''s name as written at the time (inspector, opened_by, recorded_by...), so a removed or renamed person still appears there.';
COMMENT ON COLUMN ai.users.role IS 'inspector | supervisor | admin | viewer (read-only).';
COMMENT ON COLUMN ai.users.is_active IS 'false = cannot sign in (deactivated, not removed).';
COMMENT ON COLUMN ai.users.last_login_at IS 'Last sign-in; NULL = never signed in.';

CREATE OR REPLACE VIEW ai.item_dimension_specs AS
SELECT t.id                                     AS spec_id,
       btrim(t.item_code)                       AS item_code,
       NULLIF(btrim(t.item), '')                AS item,
       t.work_center_code                       AS machine_code,
       CASE WHEN t.work_center_code IS NULL THEN NULL
            ELSE COALESCE(NULLIF(btrim(m.display_name), ''), 'Machine ' || t.work_center_code) END AS machine,
       t.dimension_name,
       t.sequence,
       t.nominal,
       t.tol_plus,
       t.tol_minus,
       t.unit,
       CASE WHEN t.nominal IS NULL OR t.nominal = 0 THEN NULL ELSE t.nominal + abs(t.tol_plus) END  AS upper_limit,
       CASE WHEN t.nominal IS NULL OR t.nominal = 0 THEN NULL ELSE t.nominal - abs(t.tol_minus) END AS lower_limit,
       t.updated_at
  FROM item_dimension_order t
  LEFT JOIN machines m ON lower(m.code) = lower(t.work_center_code) AND m.deleted_at IS NULL
 WHERE t.deleted_at IS NULL;
COMMENT ON VIEW ai.item_dimension_specs IS 'Configured dimensions per item code (the "item dimension order" sheet). A row with machine_code NULL applies on every machine; a machine-specific row overrides the general row of the same dimension_name.';
COMMENT ON COLUMN ai.item_dimension_specs.nominal IS 'NULL or 0 means "not set": the inspector types the nominal on the first sample and later samples carry it forward.';
COMMENT ON COLUMN ai.item_dimension_specs.tol_plus IS 'Upper tolerance (absolute value is used). Limits: nominal + |tol_plus| / nominal - |tol_minus|.';

CREATE OR REPLACE VIEW ai.machine_defect_list AS
SELECT w.work_center_code AS machine_code,
       COALESCE(NULLIF(btrim(m.display_name), ''), 'Machine ' || w.work_center_code) AS machine,
       w.defect_name
  FROM work_center_defects w
  LEFT JOIN machines m ON lower(m.code) = lower(w.work_center_code) AND m.deleted_at IS NULL
 WHERE w.deleted_at IS NULL;
COMMENT ON VIEW ai.machine_defect_list IS 'The defect names an inspector can pick on each machine. A defect outside the list is recorded as "Other" with a description in its notes.';

CREATE OR REPLACE VIEW ai.grade_equivalences AS
SELECT g.grade_a, g.grade_b
  FROM grade_mappings g
 WHERE g.deleted_at IS NULL;
COMMENT ON VIEW ai.grade_equivalences IS 'Pairs of steel grades treated as equivalent when a coil grade is checked against the order''s expected grade (transitive; compared ignoring case, spaces, - _ .).';

CREATE OR REPLACE VIEW ai.pt_consumables AS
SELECT p.kind::text AS kind, p.product_name, p.lot_batch
  FROM pt_consumables p
 WHERE p.deleted_at IS NULL;
COMMENT ON VIEW ai.pt_consumables IS 'Penetrant-testing consumables offered in the PT step. kind: Cleaner | Penetrant | Developer.';

CREATE OR REPLACE VIEW ai.work_instructions AS
SELECT w.code, w.title, NULLIF(w.issue_no, '') AS issue_no, w.issue_date, w.process, w.step,
       w.superseded_at IS NULL AS in_force, w.superseded_at, w.uploaded_by_name AS uploaded_by, w.uploaded_at
  FROM work_instructions w
 WHERE w.deleted_at IS NULL;
COMMENT ON VIEW ai.work_instructions IS 'Controlled work instructions (PDF metadata only). One issue per code is in force; older issues stay with in_force = false.';
COMMENT ON COLUMN ai.work_instructions.process IS 'all | forming | welding | paint | universal.';
COMMENT ON COLUMN ai.work_instructions.step IS 'Inspection step it is shown on: setup | dimensions | defects | pt | paint | paintThickness.';

-- ---- Coils, suppliers, materials ---------------------------------------------

CREATE OR REPLACE VIEW ai.coils AS
SELECT c.id                         AS coil_id,
       c.coil_number,
       NULLIF(btrim(c.grade), '')   AS grade,
       ai.material_kind(c.grade)    AS material_kind,
       NULLIF(btrim(c.sm_type), '') AS sm_type,
       NULLIF(btrim(c.supplier), '') AS supplier,
       c.thickness                  AS thickness_mm,
       c.width                      AS width_mm,
       c.yield                      AS yield_strength,
       c.notes,
       c.created_at                 AS registered_at,
       c.updated_at,
       (SELECT count(*) FROM sample_coils sc
          JOIN inspection_samples x ON x.id = sc.sample_id AND x.deleted_at IS NULL
          JOIN inspection_sessions s ON s.id = x.session_id AND s.deleted_at IS NULL
         WHERE sc.deleted_at IS NULL AND lower(sc.coil_number) = lower(c.coil_number))::int AS samples_used_in,
       (SELECT max(x.created_at) FROM sample_coils sc
          JOIN inspection_samples x ON x.id = sc.sample_id AND x.deleted_at IS NULL
          JOIN inspection_sessions s ON s.id = x.session_id AND s.deleted_at IS NULL
         WHERE sc.deleted_at IS NULL AND lower(sc.coil_number) = lower(c.coil_number)) AS last_used_at
  FROM coils c
 WHERE c.deleted_at IS NULL;
COMMENT ON VIEW ai.coils IS 'The coil (raw material) register, one row per coil number. Where a coil was used: ai.sample_coils.';
COMMENT ON COLUMN ai.coils.sm_type IS 'Steel/material type code from the coil sheet (e.g. HR).';
COMMENT ON COLUMN ai.coils.yield_strength IS 'Yield strength as imported from the coil sheet (typically N/mm² = MPa).';
COMMENT ON COLUMN ai.coils.samples_used_in IS 'Live inspection samples that recorded this coil number.';
COMMENT ON COLUMN ai.coils.last_used_at IS 'When a live sample last recorded this coil number.';

CREATE OR REPLACE VIEW ai.suppliers AS
SELECT COALESCE(NULLIF(btrim(c.supplier), ''), '(unknown supplier)') AS supplier,
       count(*)::int                                                AS coils_in_register,
       string_agg(DISTINCT NULLIF(btrim(c.grade), ''), ', ')        AS grades,
       min(c.thickness)                                             AS min_thickness_mm,
       max(c.thickness)                                             AS max_thickness_mm
  FROM coils c
 WHERE c.deleted_at IS NULL
 GROUP BY 1;
COMMENT ON VIEW ai.suppliers IS 'Suppliers as named in the coil register. Supplier quality: aggregate ai.sample_coils by supplier (the dashboard counts each sample once per supplier+grade, forming machines only).';

-- ---- Inspection records ------------------------------------------------------

CREATE OR REPLACE VIEW ai.inspection_sessions AS
SELECT b.*,
       CASE WHEN b.status = 'Closed' AND b.final_qty > 0
            THEN round((b.defect_pieces / b.final_qty * 100)::numeric, 1) END        AS defect_rate_pct,
       CASE WHEN b.pieces_inspected > 0
            THEN round((b.defect_pieces / b.pieces_inspected * 100)::numeric, 1) END AS inspected_defect_pct,
       CASE WHEN b.process = 'welding' AND b.status = 'Closed' AND b.final_qty IS NOT NULL
            THEN CASE WHEN b.final_qty <= 0 THEN 0 ELSE ceil(b.final_qty * 5 / 100.0 - 1e-9)::int END END AS pt_lengths_required
  FROM (
    SELECT s.id                                                   AS session_id,
           s.seq                                                  AS session_no,
           s.status::text                                         AS status,
           s.order_id                                             AS order_line_id,
           btrim(o.order_number)                                  AS order_number,
           upper(btrim(o.order_number)) = 'STOCK'                 AS is_stock,
           o.line_key                                             AS order_line_key,
           btrim(o.item_code)                                     AS item_code,
           btrim(o.item)                                          AS item,
           btrim(o.customer)                                      AS customer,
           btrim(o.expected_grade)                                AS expected_grade,
           btrim(o.erp_status)                                    AS erp_status,
           o.deleted_at IS NOT NULL                               AS order_line_retired,
           s.work_center_code                                     AS machine_code,
           COALESCE(NULLIF(btrim(m.display_name), ''), 'Machine ' || s.work_center_code) AS machine,
           COALESCE(m.factory, '')                                AS factory,
           COALESCE(m.process, 'universal')                       AS process,
           m.on_dashboard IS NOT FALSE                            AS counts_on_dashboard,
           s.inspector_id                                         AS opened_by_id,
           s.inspector_name                                       AS opened_by,
           (SELECT string_agg(DISTINCT x.inspector_name, ', ') FROM inspection_samples x
             WHERE x.session_id = s.id AND x.deleted_at IS NULL)  AS sample_inspectors,
           s.started_at,
           (s.started_at AT TIME ZONE current_setting('TimeZone'))::date AS started_day,
           s.closed_at,
           (s.closed_at AT TIME ZONE current_setting('TimeZone'))::date  AS closed_day,
           CASE WHEN s.closed_at IS NULL THEN NULL
                ELSE COALESCE((SELECT u.name FROM users u WHERE u.id = s.closed_by_id), 'Unknown') END AS closed_by,
           (CASE WHEN s.start_qty_at IS NOT NULL AND s.start_qty_by_id IS NOT NULL THEN s.start_qty END)::float8 AS rejected_before_release,
           s.start_qty_by_name                                    AS rejected_before_release_by,
           COALESCE(s.start_qty, 0) = 0                           AS first_part_clean,
           s.final_qty::float8                                    AS final_qty,
           (CASE WHEN upper(btrim(o.order_number)) = 'STOCK' THEN s.produced_qty END)::float8 AS produced_qty_stock,
           s.universal_kind,
           (SELECT string_agg(q.stage || ': ' || trim_scale(q.qty), ' · ' ORDER BY q.stage) FROM session_stage_quantities q
             WHERE q.session_id = s.id AND q.deleted_at IS NULL)  AS stages,
           (SELECT max(q.stage) FROM session_stage_quantities q
             WHERE q.session_id = s.id AND q.deleted_at IS NULL)::int AS top_stage,
           (SELECT count(*) FROM inspection_samples x
             WHERE x.session_id = s.id AND x.deleted_at IS NULL)::int AS samples,
           (SELECT COALESCE(sum(x.sample_qty), 0) FROM inspection_samples x
             WHERE x.session_id = s.id AND x.deleted_at IS NULL)::float8 AS pieces_inspected,
           (SELECT count(*) FROM defect_results d JOIN inspection_samples x ON x.id = d.sample_id
             WHERE x.session_id = s.id AND x.deleted_at IS NULL AND d.deleted_at IS NULL)::int AS defect_records,
           (SELECT COALESCE(sum(d.qty), 0) FROM defect_results d JOIN inspection_samples x ON x.id = d.sample_id
             WHERE x.session_id = s.id AND x.deleted_at IS NULL AND d.deleted_at IS NULL)::float8 AS defect_pieces,
           (SELECT count(*) FROM defect_results d JOIN inspection_samples x ON x.id = d.sample_id
             WHERE x.session_id = s.id AND x.deleted_at IS NULL AND d.deleted_at IS NULL AND d.disposition = 'Hold')::int AS hold_records,
           (SELECT COALESCE(sum(d.qty), 0) FROM defect_results d JOIN inspection_samples x ON x.id = d.sample_id
             WHERE x.session_id = s.id AND x.deleted_at IS NULL AND d.deleted_at IS NULL AND d.disposition = 'Hold')::float8 AS hold_pieces,
           (SELECT COALESCE(sum(d.qty), 0) FROM defect_results d JOIN inspection_samples x ON x.id = d.sample_id
             WHERE x.session_id = s.id AND x.deleted_at IS NULL AND d.deleted_at IS NULL AND d.disposition = 'Rejected')::float8 AS disposition_rejected_pieces,
           (SELECT COALESCE(sum(d.qty), 0) FROM defect_results d JOIN inspection_samples x ON x.id = d.sample_id
             WHERE x.session_id = s.id AND x.deleted_at IS NULL AND d.deleted_at IS NULL AND d.disposition = 'Repair')::float8 AS disposition_repair_pieces,
           (SELECT COALESCE(sum(d.qty), 0) FROM defect_results d JOIN inspection_samples x ON x.id = d.sample_id
             WHERE x.session_id = s.id AND x.deleted_at IS NULL AND d.deleted_at IS NULL AND d.disposition = 'Used in another order')::float8 AS disposition_used_elsewhere_pieces,
           (SELECT COALESCE(sum(d.qty), 0) FROM defect_results d JOIN inspection_samples x ON x.id = d.sample_id
             WHERE x.session_id = s.id AND x.deleted_at IS NULL AND d.deleted_at IS NULL AND d.disposition = 'Accept with concession')::float8 AS disposition_concession_pieces,
           (SELECT count(*) FROM dimension_results r JOIN inspection_samples x ON x.id = r.sample_id
             WHERE x.session_id = s.id AND x.deleted_at IS NULL AND r.deleted_at IS NULL AND r.status = 'Fail')::int AS dimension_fails,
           (SELECT count(*) FROM pt_tested_lengths l JOIN pt_records pr ON pr.id = l.pt_record_id JOIN inspection_samples x ON x.id = pr.sample_id
             WHERE x.session_id = s.id AND x.deleted_at IS NULL AND pr.deleted_at IS NULL AND l.deleted_at IS NULL)::int AS pt_lengths_tested,
           (SELECT count(*) FROM pt_tested_lengths l JOIN pt_records pr ON pr.id = l.pt_record_id JOIN inspection_samples x ON x.id = pr.sample_id
             WHERE x.session_id = s.id AND x.deleted_at IS NULL AND pr.deleted_at IS NULL AND l.deleted_at IS NULL
               AND l.verdict = 'Reject / Repair')::int     AS pt_lengths_rejected,
           (SELECT count(*) FROM session_notes n WHERE n.session_id = s.id AND n.deleted_at IS NULL)::int AS notes,
           EXISTS (
             SELECT 1
               FROM production_orders o1
               JOIN production_orders o2
                 ON lower(o2.order_number) = lower(o1.order_number) AND lower(o2.item_code) = lower(o1.item_code)
                AND lower(btrim(o2.item)) = lower(btrim(o1.item))
               JOIN inspection_sessions s2 ON s2.order_id = o2.id AND s2.id <> s.id AND s2.deleted_at IS NULL
               JOIN inspection_samples x2 ON x2.session_id = s2.id AND x2.deleted_at IS NULL
               JOIN defect_results d2 ON d2.sample_id = x2.id AND d2.deleted_at IS NULL
              WHERE o1.id = s.order_id AND btrim(o1.item_code) <> ''
                AND (lower(s2.work_center_code) <> lower(s.work_center_code) OR s2.started_at < s.started_at)
           )                                                      AS prior_defects_elsewhere
      FROM inspection_sessions s
      JOIN production_orders o ON o.id = s.order_id
      LEFT JOIN machines m ON lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL
     WHERE s.deleted_at IS NULL
  ) b;
COMMENT ON VIEW ai.inspection_sessions IS 'One row per inspection session (History). A session inspects one order line (an item of an order on one machine); it opens with its first sample and is closed with the confirmed final quantity. Counted on the dashboard by started_day; production by closed_day (use ai.production_between for dashboard production). Exclude counts_on_dashboard = false to match dashboard figures.';
COMMENT ON COLUMN ai.inspection_sessions.session_no IS 'Session number WITHIN its order line (#1, #2...), not globally unique. Use session_id to identify a session.';
COMMENT ON COLUMN ai.inspection_sessions.status IS 'Open | Closed. Closed = closed with a confirmed final quantity (closed_at set). A reopened session is Open again but keeps its previous final_qty/stages until it closes anew.';
COMMENT ON COLUMN ai.inspection_sessions.order_number IS 'Order number; "STOCK" for a make-to-stock session (shown as "For stock").';
COMMENT ON COLUMN ai.inspection_sessions.item_code IS 'An item is identified by item_code AND item name together: two items of one order can share a code.';
COMMENT ON COLUMN ai.inspection_sessions.erp_status IS 'Order line status from the Access sheet: Active, Hold, Stock, Cancel (variants such as Cancelled or ملغي). Not the defect disposition Hold.';
COMMENT ON COLUMN ai.inspection_sessions.order_line_retired IS 'true = the order line is no longer on the order sheet (sync retired it); the session remains valid evidence.';
COMMENT ON COLUMN ai.inspection_sessions.process IS 'Machine process: forming | welding | paint | universal (a code missing from the register counts as universal, as on the dashboard).';
COMMENT ON COLUMN ai.inspection_sessions.counts_on_dashboard IS 'false = machine excluded from all dashboard figures (machines.on_dashboard).';
COMMENT ON COLUMN ai.inspection_sessions.opened_by IS 'Inspector who opened the session (name as written then). Others may have recorded samples in it: sample_inspectors.';
COMMENT ON COLUMN ai.inspection_sessions.rejected_before_release IS 'Pieces already rejected on the line before the first-part release inspection, typed when the session opened (column start_qty). NULL on stock sessions.';
COMMENT ON COLUMN ai.inspection_sessions.first_part_clean IS 'Dashboard "first part released": true when nothing was rejected before release (rejected_before_release 0 or none).';
COMMENT ON COLUMN ai.inspection_sessions.final_qty IS 'Good pieces produced, confirmed at close (defective pieces were made on top of it). For a staged universal session: the quantity of its highest stage. Only meaningful when status = Closed.';
COMMENT ON COLUMN ai.inspection_sessions.produced_qty_stock IS 'Make-to-stock sessions only: pieces (right+left connector pairs) produced, typed at start.';
COMMENT ON COLUMN ai.inspection_sessions.universal_kind IS 'Universal machines only, set at close: final (finished product; each session is a new quantity and quantities add up) | staged (item passes through stages, see stages). NULL elsewhere and on sessions closed before the choice existed.';
COMMENT ON COLUMN ai.inspection_sessions.stages IS 'Stages this session covered with their quantities, e.g. "1: 300 · 2: 300".';
COMMENT ON COLUMN ai.inspection_sessions.samples IS 'Live samples recorded in the session.';
COMMENT ON COLUMN ai.inspection_sessions.pieces_inspected IS 'Sum of the samples'' sample_qty.';
COMMENT ON COLUMN ai.inspection_sessions.defect_records IS 'Number of defect entries across the samples.';
COMMENT ON COLUMN ai.inspection_sessions.defect_pieces IS 'Sum of defect quantities across the samples = the session''s defective ("rejected") pieces, whatever their disposition. The dashboard''s "rejected pieces".';
COMMENT ON COLUMN ai.inspection_sessions.hold_records IS 'Defect entries currently dispositioned Hold (awaiting a decision).';
COMMENT ON COLUMN ai.inspection_sessions.disposition_rejected_pieces IS 'Defect pieces whose disposition is Rejected (a subset of defect_pieces).';
COMMENT ON COLUMN ai.inspection_sessions.dimension_fails IS 'Dimension readings out of tolerance (status Fail) across the samples.';
COMMENT ON COLUMN ai.inspection_sessions.pt_lengths_tested IS 'PT (penetrant test) weld lengths tested across the samples (welding).';
COMMENT ON COLUMN ai.inspection_sessions.pt_lengths_required IS 'Welding sessions closed with a final quantity: 5% of final_qty rounded up.';
COMMENT ON COLUMN ai.inspection_sessions.prior_defects_elsewhere IS 'The same item of the same order showed defects on another machine or in an earlier session.';
COMMENT ON COLUMN ai.inspection_sessions.defect_rate_pct IS 'History''s "Defect rate": defect_pieces / final_qty x 100 (closed sessions). NOT the dashboard reject rate, which is defect / (produced + defect).';
COMMENT ON COLUMN ai.inspection_sessions.order_line_key IS 'The ERP''s Order ID of the session''s order line.';
COMMENT ON COLUMN ai.inspection_sessions.is_stock IS 'true = a make-to-stock session (order_number STOCK), not an ERP order.';
COMMENT ON COLUMN ai.inspection_sessions.started_day IS 'Factory day the session started (sessions are counted by it).';
COMMENT ON COLUMN ai.inspection_sessions.closed_day IS 'Factory day the session was (last) closed; production is counted by it.';
COMMENT ON COLUMN ai.inspection_sessions.sample_inspectors IS 'Everyone who recorded a live sample in the session, comma-separated.';
COMMENT ON COLUMN ai.inspection_sessions.top_stage IS 'Highest stage the session covered (staged universal sessions).';
COMMENT ON COLUMN ai.inspection_sessions.hold_pieces IS 'Defect pieces currently dispositioned Hold.';
COMMENT ON COLUMN ai.inspection_sessions.disposition_repair_pieces IS 'Defect pieces dispositioned Repair; likewise disposition_used_elsewhere_pieces (Used in another order) and disposition_concession_pieces (Accept with concession).';
COMMENT ON COLUMN ai.inspection_sessions.pt_lengths_rejected IS 'PT tested weld lengths judged Reject / Repair.';
COMMENT ON COLUMN ai.inspection_sessions.notes IS 'Number of live session notes (remarks) on the session; the text is in ai.session_notes.';
COMMENT ON COLUMN ai.inspection_sessions.inspected_defect_pct IS 'defect_pieces / pieces_inspected x 100.';

CREATE OR REPLACE VIEW ai.inspection_samples AS
SELECT b.*,
       b.defect_pieces = 0 AS first_pass
  FROM (
    SELECT x.id                                   AS sample_id,
           x.session_id,
           s.seq                                  AS session_no,
           x.index                                AS sample_no,
           s.status::text                         AS session_status,
           x.order_id                             AS order_line_id,
           btrim(o.order_number)                  AS order_number,
           upper(btrim(o.order_number)) = 'STOCK' AS is_stock,
           btrim(o.item_code)                     AS item_code,
           btrim(o.item)                          AS item,
           btrim(o.customer)                      AS customer,
           btrim(o.expected_grade)                AS expected_grade,
           s.work_center_code                     AS machine_code,
           COALESCE(NULLIF(btrim(m.display_name), ''), 'Machine ' || s.work_center_code) AS machine,
           COALESCE(m.factory, '')                AS factory,
           COALESCE(m.process, 'universal')       AS process,
           m.on_dashboard IS NOT FALSE            AS counts_on_dashboard,
           x.inspector_id,
           x.inspector_name                       AS inspector,
           x.created_at                           AS recorded_at,
           (x.created_at AT TIME ZONE current_setting('TimeZone'))::date AS recorded_day,
           x.shift::text                          AS shift,
           CASE x.shift WHEN 'A' THEN 'Morning' WHEN 'B' THEN 'Afternoon' ELSE 'Night' END AS shift_name,
           x.sample_qty::float8                   AS sample_qty,
           x.drawing,
           x.drawing_alt,
           x.issue                                AS drawing_issue,
           (SELECT count(*) FROM dimension_results r WHERE r.sample_id = x.id AND r.deleted_at IS NULL)::int AS dimension_rows,
           (SELECT count(*) FROM dimension_results r WHERE r.sample_id = x.id AND r.deleted_at IS NULL AND r.actual IS NOT NULL)::int AS dimensions_measured,
           (SELECT count(*) FROM dimension_results r WHERE r.sample_id = x.id AND r.deleted_at IS NULL AND r.actual IS NOT NULL AND r.status = 'Pass')::int AS dimensions_pass,
           (SELECT count(*) FROM dimension_results r WHERE r.sample_id = x.id AND r.deleted_at IS NULL AND r.actual IS NOT NULL AND r.status = 'Warning')::int AS dimensions_warning,
           (SELECT count(*) FROM dimension_results r WHERE r.sample_id = x.id AND r.deleted_at IS NULL AND r.status = 'Fail')::int AS dimensions_fail,
           (SELECT count(*) FROM defect_results d WHERE d.sample_id = x.id AND d.deleted_at IS NULL)::int AS defect_records,
           (SELECT COALESCE(sum(d.qty), 0) FROM defect_results d WHERE d.sample_id = x.id AND d.deleted_at IS NULL)::float8 AS defect_pieces,
           (SELECT count(*) FROM defect_results d WHERE d.sample_id = x.id AND d.deleted_at IS NULL AND d.disposition = 'Hold')::int AS hold_records,
           (SELECT string_agg(c.coil_number, ', ' ORDER BY c.coil_number) FROM sample_coils c
             WHERE c.sample_id = x.id AND c.deleted_at IS NULL) AS coils,
           x.grade_ack_at IS NOT NULL             AS grade_mismatch_acknowledged,
           x.grade_ack_by_name                    AS grade_ack_by,
           x.grade_ack_at,
           x.grade_ack_expected_grade,
           array_to_string(x.grade_ack_found_grades, ', ') AS grade_ack_found_grades,
           array_to_string(x.grade_ack_coil_numbers, ', ') AS grade_ack_coils,
           (SELECT p.notes FROM paint_samples p WHERE p.sample_id = x.id AND p.deleted_at IS NULL) AS paint_notes,
           (SELECT p.accept_or_repair::text FROM pt_records p WHERE p.sample_id = x.id AND p.deleted_at IS NULL) AS pt_verdict,
           x.updated_at                           AS last_changed_at
      FROM inspection_samples x
      JOIN inspection_sessions s ON s.id = x.session_id AND s.deleted_at IS NULL
      JOIN production_orders o ON o.id = x.order_id
      LEFT JOIN machines m ON lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL
     WHERE x.deleted_at IS NULL
  ) b;
COMMENT ON VIEW ai.inspection_samples IS 'One row per inspection sample. The dashboard counts samples, pieces inspected, defects found and first-pass yield by recorded_day.';
COMMENT ON COLUMN ai.inspection_samples.sample_no IS 'Sample number within its session (1, 2, ...).';
COMMENT ON COLUMN ai.inspection_samples.shift IS 'A Morning 08:00-15:59 | B Afternoon 16:00-18:59 | C Night 19:00-07:59 (factory time). Derived from the save time.';
COMMENT ON COLUMN ai.inspection_samples.sample_qty IS 'Pieces inspected in this sample.';
COMMENT ON COLUMN ai.inspection_samples.dimensions_fail IS 'Readings outside nominal ± tolerance.';
COMMENT ON COLUMN ai.inspection_samples.dimensions_warning IS 'Readings inside tolerance but in the outer 10% of either side.';
COMMENT ON COLUMN ai.inspection_samples.defect_pieces IS 'Sum of this sample''s defect quantities (defective pieces of the batch).';
COMMENT ON COLUMN ai.inspection_samples.first_pass IS 'No defect pieces in this sample. FPY % = first_pass samples / samples.';
COMMENT ON COLUMN ai.inspection_samples.grade_mismatch_acknowledged IS 'A coil grade not equivalent to the order''s expected grade was overridden (acknowledged) for this sample.';
COMMENT ON COLUMN ai.inspection_samples.pt_verdict IS 'Welding: Accept | Reject / Repair (Reject / Repair as soon as one tested length is).';
COMMENT ON COLUMN ai.inspection_samples.recorded_day IS 'Factory day the sample was recorded (samples are counted by it).';
COMMENT ON COLUMN ai.inspection_samples.dimension_rows IS 'Dimension rows of the sample; dimensions_measured = those with a reading, dimensions_pass / dimensions_warning = readings with that status.';
COMMENT ON COLUMN ai.inspection_samples.hold_records IS 'Defect entries of the sample currently dispositioned Hold.';
COMMENT ON COLUMN ai.inspection_samples.coils IS 'Coil numbers recorded on the sample, comma-separated (details: ai.sample_coils).';
COMMENT ON COLUMN ai.inspection_samples.drawing_alt IS 'Alternative drawing number from the order line, as recorded on the sample.';
COMMENT ON COLUMN ai.inspection_samples.grade_ack_found_grades IS 'Coil grades found when the mismatch was acknowledged (grade_ack_coils: those coils).';
COMMENT ON COLUMN ai.inspection_samples.paint_notes IS 'Paint step remarks (paint samples only).';
COMMENT ON COLUMN ai.inspection_samples.last_changed_at IS 'Last change to the sample record (corrections are in ai.audit_log).';

CREATE OR REPLACE VIEW ai.defects AS
SELECT d.id                                   AS defect_id,
       x.id                                   AS sample_id,
       x.session_id,
       s.seq                                  AS session_no,
       x.index                                AS sample_no,
       s.status::text                         AS session_status,
       x.order_id                             AS order_line_id,
       btrim(o.order_number)                  AS order_number,
       btrim(o.item_code)                     AS item_code,
       btrim(o.item)                          AS item,
       btrim(o.customer)                      AS customer,
       s.work_center_code                     AS machine_code,
       COALESCE(NULLIF(btrim(m.display_name), ''), 'Machine ' || s.work_center_code) AS machine,
       COALESCE(m.factory, '')                AS factory,
       COALESCE(m.process, 'universal')       AS process,
       m.on_dashboard IS NOT FALSE            AS counts_on_dashboard,
       x.inspector_name                       AS inspector,
       x.created_at                           AS recorded_at,
       (x.created_at AT TIME ZONE current_setting('TimeZone'))::date AS recorded_day,
       x.shift::text                          AS shift,
       d.defect_name,
       d.qty::float8                          AS pieces,
       d.disposition::text                    AS disposition,
       d.notes,
       (SELECT count(*) FROM defect_images di JOIN images i ON i.id = di.image_id AND i.deleted_at IS NULL
         WHERE di.defect_id = d.id)::int      AS photos,
       CASE WHEN d.disposition = 'Hold'
            THEN floor(EXTRACT(EPOCH FROM (now() - x.created_at)) / 86400)::int END AS hold_age_days,
       d.updated_at                           AS last_changed_at
  FROM defect_results d
  JOIN inspection_samples x ON x.id = d.sample_id AND x.deleted_at IS NULL
  JOIN inspection_sessions s ON s.id = x.session_id AND s.deleted_at IS NULL
  JOIN production_orders o ON o.id = x.order_id
  LEFT JOIN machines m ON lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL
 WHERE d.deleted_at IS NULL;
COMMENT ON VIEW ai.defects IS 'One row per defect entry of a live sample. Open holds = WHERE disposition = ''Hold'' (the dashboard lists the oldest first and leaves out counts_on_dashboard = false). Pareto = sum(pieces) by defect_name.';
COMMENT ON COLUMN ai.defects.pieces IS 'Defective pieces of the batch this entry covers.';
COMMENT ON COLUMN ai.defects.disposition IS 'Rejected | Hold (awaiting a decision) | Repair | Used in another order | Accept with concession. A Hold is resolved by changing the disposition (history in ai.audit_log, entity DefectResult).';
COMMENT ON COLUMN ai.defects.defect_name IS 'From the machine''s defect list (ai.machine_defect_list); "Other" carries its description in notes.';
COMMENT ON COLUMN ai.defects.hold_age_days IS 'Hold only: whole days since the sample was recorded.';
COMMENT ON COLUMN ai.defects.recorded_day IS 'Factory day the defect''s sample was recorded.';
COMMENT ON COLUMN ai.defects.photos IS 'Photos attached to the defect entry (the images themselves are not available here).';

CREATE OR REPLACE VIEW ai.dimension_measurements AS
SELECT r.id                                   AS measurement_id,
       x.id                                   AS sample_id,
       x.session_id,
       s.seq                                  AS session_no,
       x.index                                AS sample_no,
       btrim(o.order_number)                  AS order_number,
       btrim(o.item_code)                     AS item_code,
       btrim(o.item)                          AS item,
       s.work_center_code                     AS machine_code,
       COALESCE(NULLIF(btrim(m.display_name), ''), 'Machine ' || s.work_center_code) AS machine,
       COALESCE(m.factory, '')                AS factory,
       COALESCE(m.process, 'universal')       AS process,
       x.inspector_name                       AS inspector,
       x.created_at                           AS recorded_at,
       (x.created_at AT TIME ZONE current_setting('TimeZone'))::date AS recorded_day,
       x.shift::text                          AS shift,
       r.sequence,
       r.name                                 AS dimension,
       r.nominal,
       r.tol_plus,
       r.tol_minus,
       r.nominal + abs(r.tol_plus)            AS upper_limit,
       r.nominal - abs(r.tol_minus)           AS lower_limit,
       r.actual,
       r.actual - r.nominal                   AS deviation,
       r.unit,
       r.status::text                         AS status,
       r.source::text                         AS spec_source,
       lower(btrim(r.name)) = 'paint thickness' AS is_paint_thickness
  FROM dimension_results r
  JOIN inspection_samples x ON x.id = r.sample_id AND x.deleted_at IS NULL
  JOIN inspection_sessions s ON s.id = x.session_id AND s.deleted_at IS NULL
  JOIN production_orders o ON o.id = x.order_id
  LEFT JOIN machines m ON lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL
 WHERE r.deleted_at IS NULL;
COMMENT ON VIEW ai.dimension_measurements IS 'One row per dimension reading of a live sample. Paint thickness readings are rows named "Paint thickness" (µm, no tolerance, status Pending).';
COMMENT ON COLUMN ai.dimension_measurements.status IS 'Pass | Warning (inside tolerance, outer 10% of a side) | Fail (outside nominal ± tolerance) | Pending (not measured, or no nominal/tolerance to judge against).';
COMMENT ON COLUMN ai.dimension_measurements.spec_source IS 'Where nominal/tolerance came from: item-order (configured spec) | carry-forward (previous sample) | manual | item-master (retired).';
COMMENT ON COLUMN ai.dimension_measurements.unit IS 'Usually mm; µm for paint thickness.';
COMMENT ON COLUMN ai.dimension_measurements.deviation IS 'actual - nominal, in unit.';

CREATE OR REPLACE VIEW ai.sample_coils AS
SELECT c.id                                   AS sample_coil_id,
       x.id                                   AS sample_id,
       x.session_id,
       s.seq                                  AS session_no,
       x.index                                AS sample_no,
       btrim(o.order_number)                  AS order_number,
       btrim(o.item_code)                     AS item_code,
       btrim(o.item)                          AS item,
       btrim(o.customer)                      AS customer,
       btrim(o.expected_grade)                AS expected_grade,
       s.work_center_code                     AS machine_code,
       COALESCE(NULLIF(btrim(m.display_name), ''), 'Machine ' || s.work_center_code) AS machine,
       COALESCE(m.factory, '')                AS factory,
       COALESCE(m.process, 'universal')       AS process,
       m.on_dashboard IS NOT FALSE            AS counts_on_dashboard,
       x.inspector_name                       AS inspector,
       x.created_at                           AS recorded_at,
       (x.created_at AT TIME ZONE current_setting('TimeZone'))::date AS recorded_day,
       c.coil_number,
       c.coil_id IS NOT NULL                  AS picked_from_register,
       COALESCE(NULLIF(btrim(c.supplier), ''), NULLIF(btrim(r.supplier), '')) AS supplier,
       COALESCE(NULLIF(btrim(c.grade), ''), NULLIF(btrim(r.grade), ''))       AS grade,
       ai.material_kind(COALESCE(NULLIF(btrim(c.grade), ''), NULLIF(btrim(r.grade), ''))) AS material_kind,
       COALESCE(c.thickness, r.thickness)     AS thickness_mm,
       COALESCE(c.width, r.width)             AS width_mm,
       COALESCE(c.yield, r.yield)             AS yield_strength,
       COALESCE(NULLIF(btrim(c.sm_type), ''), NULLIF(btrim(r.sm_type), '')) AS sm_type,
       c.notes,
       x.grade_ack_at IS NOT NULL             AS grade_mismatch_acknowledged,
       x.sample_qty::float8                   AS sample_qty,
       (SELECT COALESCE(sum(d.qty), 0) FROM defect_results d WHERE d.sample_id = x.id AND d.deleted_at IS NULL)::float8 AS sample_defect_pieces
  FROM sample_coils c
  JOIN inspection_samples x ON x.id = c.sample_id AND x.deleted_at IS NULL
  JOIN inspection_sessions s ON s.id = x.session_id AND s.deleted_at IS NULL
  JOIN production_orders o ON o.id = x.order_id
  LEFT JOIN coils r ON lower(r.coil_number) = lower(c.coil_number) AND r.deleted_at IS NULL
  LEFT JOIN machines m ON lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL
 WHERE c.deleted_at IS NULL;
COMMENT ON VIEW ai.sample_coils IS 'Coils recorded on each live sample (traceability coil -> sample -> order -> customer). Details are the sample''s own snapshot, else the coil register''s, as the dashboard reads them. A sample with several coils appears once per coil: count DISTINCT sample_id before summing sample_qty / sample_defect_pieces.';
COMMENT ON COLUMN ai.sample_coils.picked_from_register IS 'true = chosen from the coil register; false = typed by hand.';
COMMENT ON COLUMN ai.sample_coils.material_kind IS 'black | galvanized | unknown (from grade).';
COMMENT ON COLUMN ai.sample_coils.sample_qty IS 'Pieces inspected in the sample (repeated on each of its coils).';
COMMENT ON COLUMN ai.sample_coils.sample_defect_pieces IS 'Defect pieces of the sample (repeated on each of its coils).';
COMMENT ON COLUMN ai.sample_coils.recorded_day IS 'Factory day the sample was recorded.';

CREATE OR REPLACE VIEW ai.pt_records AS
SELECT p.id                                   AS pt_record_id,
       x.id                                   AS sample_id,
       x.session_id,
       s.seq                                  AS session_no,
       x.index                                AS sample_no,
       btrim(o.order_number)                  AS order_number,
       btrim(o.item_code)                     AS item_code,
       btrim(o.item)                          AS item,
       s.work_center_code                     AS machine_code,
       COALESCE(NULLIF(btrim(m.display_name), ''), 'Machine ' || s.work_center_code) AS machine,
       COALESCE(m.factory, '')                AS factory,
       x.inspector_name                       AS inspector,
       x.created_at                           AS recorded_at,
       (x.created_at AT TIME ZONE current_setting('TimeZone'))::date AS recorded_day,
       p.accept_or_repair::text               AS verdict,
       (SELECT count(*) FROM pt_tested_lengths l WHERE l.pt_record_id = p.id AND l.deleted_at IS NULL)::int AS lengths_tested,
       (SELECT count(*) FROM pt_tested_lengths l WHERE l.pt_record_id = p.id AND l.deleted_at IS NULL AND l.verdict = 'Reject / Repair')::int AS lengths_rejected,
       (SELECT sum(l.length_mm) FROM pt_tested_lengths l WHERE l.pt_record_id = p.id AND l.deleted_at IS NULL) AS total_length_mm,
       (SELECT string_agg(l.seq || ': ' || trim_scale(l.length_mm) || ' mm ' || l.verdict::text, '; ' ORDER BY l.seq)
          FROM pt_tested_lengths l WHERE l.pt_record_id = p.id AND l.deleted_at IS NULL) AS tested_lengths,
       p.cleaner_lot,
       p.penetrant_lot,
       p.developer_lot,
       p.welding_wire_batch,
       p.indication_type,
       p.indication_size,
       p.final_result,
       p.notes,
       p.test_frequency_pct                   AS legacy_test_frequency_pct
  FROM pt_records p
  JOIN inspection_samples x ON x.id = p.sample_id AND x.deleted_at IS NULL
  JOIN inspection_sessions s ON s.id = x.session_id AND s.deleted_at IS NULL
  JOIN production_orders o ON o.id = x.order_id
  LEFT JOIN machines m ON lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL
 WHERE p.deleted_at IS NULL;
COMMENT ON VIEW ai.pt_records IS 'Penetrant testing (PT) / weld inspection, one row per welding sample. Requirement: tested lengths >= 5% of the session''s final quantity (ai.inspection_sessions.pt_lengths_required).';
COMMENT ON COLUMN ai.pt_records.verdict IS 'Accept | Reject / Repair (Reject / Repair as soon as one tested length is).';
COMMENT ON COLUMN ai.pt_records.tested_lengths IS 'Each tested weld length: "seq: length mm verdict".';
COMMENT ON COLUMN ai.pt_records.cleaner_lot IS 'Lot/batch of the PT cleaner (chemical traceability); likewise penetrant_lot, developer_lot.';
COMMENT ON COLUMN ai.pt_records.legacy_test_frequency_pct IS 'Typed by hand on old records only; the requirement is now computed from the final quantity.';

CREATE OR REPLACE VIEW ai.session_stage_quantities AS
SELECT q.session_id,
       s.seq                                  AS session_no,
       s.status::text                         AS session_status,
       s.order_id                             AS order_line_id,
       btrim(o.order_number)                  AS order_number,
       btrim(o.item_code)                     AS item_code,
       btrim(o.item)                          AS item,
       s.work_center_code                     AS machine_code,
       COALESCE(NULLIF(btrim(m.display_name), ''), 'Machine ' || s.work_center_code) AS machine,
       q.stage,
       q.qty::float8                          AS qty,
       q.created_at                           AS recorded_at,
       (SELECT u.name FROM users u WHERE u.id = q.created_by_id) AS recorded_by
  FROM session_stage_quantities q
  JOIN inspection_sessions s ON s.id = q.session_id AND s.deleted_at IS NULL
  JOIN production_orders o ON o.id = s.order_id
  LEFT JOIN machines m ON lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL
 WHERE q.deleted_at IS NULL;
COMMENT ON VIEW ai.session_stage_quantities IS 'Universal machines, staged lines: each stage (1..50) a session covered and its quantity. A staged line''s production in a span is the quantity of the highest stage recorded in that span (summed over the sessions that recorded it).';
COMMENT ON COLUMN ai.session_stage_quantities.recorded_by IS 'Who recorded the stage quantity (at close, or a later correction).';

CREATE OR REPLACE VIEW ai.session_notes AS
SELECT n.id                                   AS note_id,
       n.session_id,
       s.seq                                  AS session_no,
       n.order_id                             AS order_line_id,
       btrim(o.order_number)                  AS order_number,
       btrim(o.item_code)                     AS item_code,
       btrim(o.item)                          AS item,
       s.work_center_code                     AS machine_code,
       COALESCE(NULLIF(btrim(m.display_name), ''), 'Machine ' || s.work_center_code) AS machine,
       sm.index                               AS sample_no,
       n.text,
       n.author_name                          AS author,
       n.created_at                           AS written_at,
       (n.created_at AT TIME ZONE current_setting('TimeZone'))::date AS written_day,
       (SELECT count(*) FROM session_note_images i WHERE i.note_id = n.id)::int AS photos
  FROM session_notes n
  JOIN inspection_sessions s ON s.id = n.session_id AND s.deleted_at IS NULL
  JOIN production_orders o ON o.id = n.order_id
  LEFT JOIN inspection_samples sm ON sm.id = n.sample_id
  LEFT JOIN machines m ON lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL
 WHERE n.deleted_at IS NULL;
COMMENT ON VIEW ai.session_notes IS 'Inspectors'' remarks about an order line written on the Review step (quality evidence, not chat). Shown to every later session on the same order number + item + machine.';
COMMENT ON COLUMN ai.session_notes.sample_no IS 'The sample the note was written with, when it was written with one.';
COMMENT ON COLUMN ai.session_notes.photos IS 'Photos attached to the note.';

-- ---- Production (dashboard) ---------------------------------------------------

CREATE OR REPLACE VIEW ai.production_sessions AS
SELECT s.id                                   AS session_id,
       s.seq                                  AS session_no,
       s.order_id                             AS order_line_id,
       s.work_center_code                     AS machine_code,
       COALESCE(NULLIF(btrim(m.display_name), ''), 'Machine ' || s.work_center_code) AS machine,
       COALESCE(m.factory, '')                AS factory,
       COALESCE(m.process, 'universal')       AS process,
       btrim(o.order_number)                  AS order_number,
       btrim(o.item_code)                     AS item_code,
       btrim(o.item)                          AS item,
       btrim(o.customer)                      AS customer,
       s.closed_at,
       (s.closed_at AT TIME ZONE current_setting('TimeZone'))::date                 AS closed_day,
       to_char(s.closed_at AT TIME ZONE current_setting('TimeZone'), 'YYYY-MM')     AS closed_month,
       s.final_qty::float8                    AS final_qty,
       s.universal_kind,
       (COALESCE(m.process = 'universal', false) AND upper(btrim(o.order_number)) <> 'STOCK'
         AND s.universal_kind IS DISTINCT FROM 'final') AS counted_once_per_line,
       COALESCE(o.finished_qty, 0)::float8    AS sheet_finished_qty,
       (SELECT max(q.stage) FROM session_stage_quantities q WHERE q.session_id = s.id AND q.deleted_at IS NULL)::int AS top_stage,
       (SELECT jsonb_object_agg(q.stage::text, q.qty) FROM session_stage_quantities q
         WHERE q.session_id = s.id AND q.deleted_at IS NULL) AS stage_quantities,
       COALESCE((SELECT sum(d.qty) FROM defect_results d JOIN inspection_samples x ON x.id = d.sample_id
                  WHERE x.session_id = s.id AND x.deleted_at IS NULL AND d.deleted_at IS NULL), 0)::float8 AS defect_pieces
  FROM inspection_sessions s
  JOIN production_orders o ON o.id = s.order_id
  LEFT JOIN machines m ON lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL
 WHERE m.on_dashboard IS NOT FALSE
   AND s.deleted_at IS NULL AND s.status = 'Closed' AND s.final_qty IS NOT NULL AND s.closed_at IS NOT NULL;
COMMENT ON VIEW ai.production_sessions IS 'Inputs of the dashboard''s production figure: sessions closed with a final quantity on machines the dashboard counts. Do NOT sum final_qty for production: universal staged/legacy lines are counted once per line per span. Use ai.production_between(from, to, per).';
COMMENT ON COLUMN ai.production_sessions.counted_once_per_line IS 'Universal order line that is not a final product (staged, or closed before the choice): its production is counted once per line per span, not per session.';
COMMENT ON COLUMN ai.production_sessions.sheet_finished_qty IS 'Order sheet finished quantity of the line (used for lines closed before stages existed).';
COMMENT ON COLUMN ai.production_sessions.defect_pieces IS 'All defect pieces of the session (the dashboard''s rejected pieces).';
COMMENT ON COLUMN ai.production_sessions.closed_day IS 'Factory day of closed_at; closed_month = its YYYY-MM.';
COMMENT ON COLUMN ai.production_sessions.stage_quantities IS 'JSON object stage -> quantity of the stages this session covered.';

CREATE OR REPLACE FUNCTION ai.production_between(p_from date, p_to date, p_per text DEFAULT 'span')
RETURNS TABLE (
  session_id uuid, order_line_id uuid, machine_code text, machine text, factory text, process text,
  order_number text, item_code text, item text, customer text,
  closed_at timestamptz, closed_day date, closed_month text, period text,
  final_qty double precision, produced double precision, defect_pieces double precision)
LANGUAGE sql STABLE AS $$
  WITH r AS (
    SELECT b.*,
           CASE lower(p_per) WHEN 'month' THEN b.closed_month WHEN 'day' THEN b.closed_day::text ELSE '' END AS part
      FROM ai.production_sessions b
     WHERE b.closed_day BETWEEN p_from AND p_to
  ), w AS (
    SELECT r.*,
           CASE WHEN r.sheet_finished_qty > 0 THEN r.sheet_finished_qty
                ELSE max(r.final_qty) OVER (PARTITION BY r.order_line_id, r.counted_once_per_line) END AS line_qty,
           bool_or(r.universal_kind = 'staged') OVER (PARTITION BY r.order_line_id, r.counted_once_per_line, r.part) AS line_staged,
           max(r.top_stage) OVER (PARTITION BY r.order_line_id, r.counted_once_per_line, r.part) AS line_top,
           row_number() OVER (PARTITION BY r.order_line_id, r.counted_once_per_line, r.part ORDER BY r.closed_at, r.session_id) AS line_first
      FROM r
  ), t AS (
    SELECT w.*, COALESCE((w.stage_quantities ->> w.line_top::text)::float8, 0) AS at_top
      FROM w
  )
  SELECT t.session_id, t.order_line_id, t.machine_code, t.machine, t.factory, t.process,
         t.order_number, t.item_code, t.item, t.customer,
         t.closed_at, t.closed_day, t.closed_month,
         CASE lower(p_per) WHEN 'month' THEN t.closed_month WHEN 'day' THEN t.closed_day::text
              ELSE p_from::text || '..' || p_to::text END,
         t.final_qty,
         CASE WHEN NOT t.counted_once_per_line THEN t.final_qty
              WHEN t.line_first <> 1 THEN 0
              WHEN t.line_staged THEN sum(t.at_top) OVER (PARTITION BY t.order_line_id, t.counted_once_per_line, t.part)
              ELSE t.line_qty END,
         t.defect_pieces
    FROM t
$$;
COMMENT ON FUNCTION ai.production_between(date, date, text) IS 'Dashboard production for factory days p_from..p_to inclusive, one row per closed session. per = span (whole range, default) | month | day: a universal staged/legacy line counts once per period. Sum produced and defect_pieces over any grouping (machine, factory, process, item, order). Reject rate % = sum(defect_pieces) / (sum(produced) + sum(defect_pieces)) x 100; made = produced + defect_pieces; PPM = rate x 10000.';

-- ---- Orders (Access sheet) and PDI ---------------------------------------------

CREATE OR REPLACE VIEW ai.order_lines AS
SELECT o.id                                   AS order_line_id,
       btrim(o.line_key)                      AS line_key,
       btrim(o.order_number)                  AS order_number,
       btrim(o.item_code)                     AS item_code,
       btrim(o.item)                          AS item,
       btrim(o.work_center_code)              AS machine_code,
       CASE WHEN btrim(o.work_center_code) = '' THEN ''
            ELSE COALESCE(NULLIF(btrim(m.display_name), ''), 'Machine ' || btrim(o.work_center_code)) END AS machine,
       COALESCE(btrim(m.factory), '')         AS factory,
       m.process,
       NOT EXISTS (SELECT 1 FROM machines d WHERE lower(d.code) = lower(o.work_center_code) AND d.deleted_at IS NULL AND d.on_dashboard = false) AS counts_on_dashboard,
       btrim(o.erp_status)                    AS erp_status,
       (lower(btrim(o.erp_status)) LIKE 'cancel%' OR o.erp_status LIKE '%ملغ%' OR o.erp_status LIKE '%لغاء%') AS is_cancelled,
       upper(btrim(o.order_number)) = 'STOCK' AS is_stock_line,
       o.required_qty::float8                 AS required_qty,
       o.finished_qty::float8                 AS finished_qty,
       GREATEST(0, o.required_qty - o.finished_qty)::float8 AS remaining_qty,
       btrim(o.customer)                      AS customer,
       btrim(o.expected_grade)                AS expected_grade,
       btrim(o.material)                      AS material,
       btrim(o.drawing)                       AS drawing,
       NULLIF(btrim(o.drawing_alt), '')       AS drawing_alt,
       NULLIF(btrim(o.issue), '')             AS drawing_issue,
       btrim(o.type)                          AS order_type,
       btrim(o.colour)                        AS colour,
       o.order_date,
       (o.order_date AT TIME ZONE current_setting('TimeZone'))::date AS order_day,
       (SELECT count(*) FROM inspection_sessions s WHERE s.order_id = o.id AND s.deleted_at IS NULL)::int AS sessions,
       (SELECT count(*) FROM inspection_sessions s WHERE s.order_id = o.id AND s.deleted_at IS NULL AND s.status = 'Open')::int AS open_sessions,
       (SELECT count(*) FROM inspection_samples x WHERE x.order_id = o.id AND x.deleted_at IS NULL)::int AS samples,
       (SELECT COALESCE(sum(d.qty), 0) FROM defect_results d JOIN inspection_samples x ON x.id = d.sample_id
         WHERE x.order_id = o.id AND x.deleted_at IS NULL AND d.deleted_at IS NULL)::float8 AS defect_pieces,
       (SELECT max(x.created_at) FROM inspection_samples x WHERE x.order_id = o.id AND x.deleted_at IS NULL) AS last_inspected_at,
       (SELECT count(*) FROM pdi_lines pl JOIN pdi_documents d ON d.id = pl.pdi_id AND d.deleted_at IS NULL
         WHERE pl.order_id = o.id)::int       AS pdi_count,
       (SELECT COALESCE(r.finished_at, r.started_at) FROM order_sync_runs r WHERE r.id = o.last_sync_run_id) AS last_seen_by_sync_at,
       o.updated_at                           AS last_changed_at
  FROM production_orders o
  LEFT JOIN LATERAL (
    SELECT m.display_name, m.factory, m.process FROM machines m
     WHERE ai.machine_key(m.code) = ai.machine_key(o.work_center_code) AND m.deleted_at IS NULL
     ORDER BY m.created_at LIMIT 1) m ON true
 WHERE o.deleted_at IS NULL;
COMMENT ON VIEW ai.order_lines IS 'The order sheet ("Access"): one row per ORDER LINE = one item of an order on one machine (the ERP''s Order ID is line_key). An order_number repeats across its lines. Lines no longer on the sheet are excluded (sessions on them stay in ai.inspection_sessions with order_line_retired = true).';
COMMENT ON COLUMN ai.order_lines.erp_status IS 'Active | Hold | Stock | Cancel as the Access sheet writes it. Cancelled lines are kept for history but never offered for inspection or PDI.';
COMMENT ON COLUMN ai.order_lines.is_cancelled IS 'erp_status reads as cancelled (Cancel, Cancelled, Canceled, ملغي, إلغاء...).';
COMMENT ON COLUMN ai.order_lines.is_stock_line IS 'The fixed STOCK line of the make-to-stock press, not an ERP order.';
COMMENT ON COLUMN ai.order_lines.required_qty IS 'Pieces required (order sheet).';
COMMENT ON COLUMN ai.order_lines.finished_qty IS 'Pieces finished according to the order sheet (ERP), not the inspection record.';
COMMENT ON COLUMN ai.order_lines.remaining_qty IS 'max(0, required_qty - finished_qty). The dashboard''s "open lines" = lines with is_cancelled = false, remaining_qty > 0 and counts_on_dashboard = true.';
COMMENT ON COLUMN ai.order_lines.counts_on_dashboard IS 'false = the line''s machine is left out of every dashboard figure (machines.on_dashboard).';
COMMENT ON COLUMN ai.order_lines.process IS 'Process of the line''s machine: forming | welding | paint | universal; NULL when the machine code is not in the register.';
COMMENT ON COLUMN ai.order_lines.line_key IS 'The ERP''s Order ID of the line (unique).';
COMMENT ON COLUMN ai.order_lines.order_day IS 'Factory day of order_date (the order list sorts and filters by it).';
COMMENT ON COLUMN ai.order_lines.sessions IS 'Live inspection sessions on the line; open_sessions = those still Open.';
COMMENT ON COLUMN ai.order_lines.pdi_count IS 'Live PDIs covering the line.';
COMMENT ON COLUMN ai.order_lines.expected_grade IS 'Steel grade the order expects; coil grades are checked against it (ai.grade_equivalences).';
COMMENT ON COLUMN ai.order_lines.samples IS 'Live samples recorded against the line.';
COMMENT ON COLUMN ai.order_lines.defect_pieces IS 'Defect pieces recorded against the line across all its samples.';
COMMENT ON COLUMN ai.order_lines.last_seen_by_sync_at IS 'When the Access sync last saw this line.';

CREATE OR REPLACE VIEW ai.pdi_documents AS
SELECT d.id                                   AS pdi_id,
       d.created_at                           AS recorded_at,
       (d.created_at AT TIME ZONE current_setting('TimeZone'))::date AS recorded_day,
       d.created_by_name                      AS recorded_by,
       COALESCE(btrim(o.order_number), '')    AS order_number,
       COALESCE(btrim(o.customer), '')        AS customer,
       d.notes,
       (SELECT count(*) FROM pdi_images pi WHERE pi.pdi_id = d.id)::int AS photos,
       (SELECT count(*) FROM pdi_lines pl WHERE pl.pdi_id = d.id)::int  AS lines_covered,
       COALESCE((SELECT string_agg(t.item, ', ' ORDER BY lower(t.item))
                   FROM (SELECT DISTINCT btrim(l.item) AS item FROM pdi_lines pl JOIN production_orders l ON l.id = pl.order_id
                          WHERE pl.pdi_id = d.id) t), '') AS items,
       COALESCE((SELECT string_agg(t.code, ', ' ORDER BY lower(t.code))
                   FROM (SELECT DISTINCT btrim(l.item_code) AS code FROM pdi_lines pl JOIN production_orders l ON l.id = pl.order_id
                          WHERE pl.pdi_id = d.id AND btrim(l.item_code) <> '') t), '') AS item_codes
  FROM pdi_documents d
  LEFT JOIN production_orders o ON o.id = d.order_id
 WHERE d.deleted_at IS NULL;
COMMENT ON VIEW ai.pdi_documents IS 'Pre-delivery inspections (PDI): photo documentation of a delivery of one order. Lines covered: ai.pdi_lines.';
COMMENT ON COLUMN ai.pdi_documents.lines_covered IS 'Order lines (item on a machine) this PDI covers; all share one order number.';
COMMENT ON COLUMN ai.pdi_documents.photos IS 'Photos in the PDI (the images themselves are not available here).';
COMMENT ON COLUMN ai.pdi_documents.items IS 'Item names covered, comma-separated; item_codes likewise.';

CREATE OR REPLACE VIEW ai.pdi_lines AS
SELECT pl.pdi_id,
       d.created_at                           AS pdi_recorded_at,
       (d.created_at AT TIME ZONE current_setting('TimeZone'))::date AS pdi_recorded_day,
       d.created_by_name                      AS pdi_recorded_by,
       l.id                                   AS order_line_id,
       btrim(l.line_key)                      AS line_key,
       btrim(l.order_number)                  AS order_number,
       btrim(l.item_code)                     AS item_code,
       btrim(l.item)                          AS item,
       btrim(l.work_center_code)              AS machine_code,
       btrim(l.customer)                      AS customer,
       btrim(l.drawing)                       AS drawing,
       l.required_qty::float8                 AS required_qty,
       l.finished_qty::float8                 AS finished_qty,
       btrim(l.erp_status)                    AS erp_status,
       l.deleted_at IS NOT NULL               AS order_line_retired
  FROM pdi_lines pl
  JOIN pdi_documents d ON d.id = pl.pdi_id AND d.deleted_at IS NULL
  JOIN production_orders l ON l.id = pl.order_id;
COMMENT ON VIEW ai.pdi_lines IS 'Which order lines each PDI covers (one row per PDI x line).';

CREATE OR REPLACE VIEW ai.order_sync_runs AS
SELECT r.id                                   AS run_id,
       r.started_at,
       r.finished_at,
       r.status,
       r.source,
       r.rows_received,
       r.rows_expected,
       r.inserted,
       r.updated,
       r.invalid,
       r.retired,
       array_to_string(r.unknown_columns, ', ') AS unknown_columns,
       jsonb_array_length(r.errors)           AS error_rows,
       left(r.errors::text, 2000)             AS errors_sample,
       r.message,
       k.name                                 AS integration_key_name
  FROM order_sync_runs r
  LEFT JOIN integration_keys k ON k.id = r.key_id;
COMMENT ON VIEW ai.order_sync_runs IS 'Each run of the agent that syncs the Access order table into the app. status: running | success | warning | failed. retired = lines marked no longer on the sheet (only after a clean full read).';


-- ---- Audit log ---------------------------------------------------------------------

-- Chat and notices are outside what the assistant may read, and so are their
-- audit entries (a notice's edits carry its text). The assistant's own key
-- changes never hold the key, and are left out all the same.
CREATE OR REPLACE VIEW ai.audit_log AS
SELECT a.id                                   AS audit_id,
       a.at,
       (a.at AT TIME ZONE current_setting('TimeZone'))::date AS day,
       a.user_id,
       a.user_name,
       a.action::text                         AS action,
       a.entity,
       a.entity_id,
       a.field,
       a.old_value,
       a.new_value,
       a.order_number,
       a.item,
       a.work_center_code                     AS machine_code,
       CASE WHEN a.work_center_code IS NULL THEN NULL
            ELSE COALESCE(NULLIF(btrim(m.display_name), ''), 'Machine ' || a.work_center_code) END AS machine,
       a.session_id,
       a.sample_id
  FROM audit_log a
  LEFT JOIN machines m ON lower(m.code) = lower(a.work_center_code) AND m.deleted_at IS NULL
 WHERE a.deleted_at IS NULL
   AND a.entity NOT IN ('AiAssistant', 'Notice', 'ChatGroup');
COMMENT ON VIEW ai.audit_log IS 'Append-only audit trail of every change (purged entries excluded). One row per changed field.';
COMMENT ON COLUMN ai.audit_log.day IS 'Factory day of the change.';
COMMENT ON COLUMN ai.audit_log.action IS 'create | update | delete | restore | purge | acknowledge.';
COMMENT ON COLUMN ai.audit_log.entity IS 'InspectionSession, InspectionSample, DimensionResult, DefectResult, SessionNote, ProductionOrder, PDIDocument, Coil, Machine, ItemDimensionOrder, ItemReferenceImage, WorkCenterDefect, GradeMapping, PTConsumableProduct, WorkInstruction, User, IntegrationKey, AppSettings, AuditLog.';
COMMENT ON COLUMN ai.audit_log.entity_id IS 'Id (or key) of the changed record, as text.';
COMMENT ON COLUMN ai.audit_log.field IS 'Changed field; e.g. reRecorded (sample re-recorded from History), disposition, qty, actual, finalQty, startQty (rejected before release), status. Discarded empty sessions: action delete, field reason, new_value ''Discarded: ...''.';
COMMENT ON COLUMN ai.audit_log.session_id IS 'Related session (join ai.inspection_sessions.session_id).';

-- ---- The reader role ---------------------------------------------------------------
-- Created here without LOGIN; the API sets LOGIN, the password and the time
-- zone when it starts (server/src/ai/reader.ts). Everything is granted by
-- name through format(): the name depends on the database.

DO $$
DECLARE
  reader text := current_database() || '_ai_reader';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = reader) THEN
    BEGIN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 6', reader);
    EXCEPTION WHEN duplicate_object THEN
      NULL; -- another instance created it a moment ago
    END;
  END IF;

  REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ai FROM PUBLIC;
  EXECUTE format('GRANT USAGE ON SCHEMA ai TO %I', reader);
  EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA ai TO %I', reader);
  EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ai TO %I', reader);
  -- A view a later migration adds to ai is readable without another grant.
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA ai GRANT SELECT ON TABLES TO %I', reader);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA ai GRANT EXECUTE ON FUNCTIONS TO %I', reader);
  ALTER DEFAULT PRIVILEGES IN SCHEMA ai REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

  -- Defaults for every session of the role. The runner sets its own limits in
  -- each transaction as well; these hold whatever a client does.
  EXECUTE format('ALTER ROLE %I CONNECTION LIMIT 6', reader);
  EXECUTE format('ALTER ROLE %I SET search_path = ai, pg_catalog', reader);
  EXECUTE format('ALTER ROLE %I SET default_transaction_read_only = on', reader);
  EXECUTE format('ALTER ROLE %I SET statement_timeout = %L', reader, '10s');
  EXECUTE format('ALTER ROLE %I SET lock_timeout = %L', reader, '2s');
  EXECUTE format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', reader, '15s');
END $$;

-- ---- The assistant's own records (public; never granted to the reader) -----------

-- The Anthropic API key an administrator set in the app: AES-256-GCM under a
-- key derived from JWT_SECRET. One row at most.
CREATE TABLE ai_credentials (
  id              smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  ciphertext      bytea NOT NULL,
  iv              bytea NOT NULL,
  auth_tag        bytea NOT NULL,
  -- How the encryption key was derived, so a later scheme can still read this one.
  key_version     smallint NOT NULL DEFAULT 1,
  last4           text NOT NULL,
  updated_by_id   uuid REFERENCES users (id),
  updated_by_name text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id),
  -- The first question, shortened.
  title           text NOT NULL,
  model           text NOT NULL,
  -- Rendered once when the conversation starts and replayed byte for byte for
  -- its whole life: Claude ties its thinking to them, and the prompt cache too.
  system_prompt   text NOT NULL,
  tools           json NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CONSTRAINT ai_conversations_title_short CHECK (char_length(title) BETWEEN 1 AND 80)
);
CREATE INDEX ai_conversations_user_idx ON ai_conversations (user_id, last_message_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE TRIGGER ai_conversations_updated_at BEFORE UPDATE ON ai_conversations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER ai_conversations_no_delete BEFORE DELETE ON ai_conversations FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

-- One question and its whole answer. The sender's client id makes a send
-- idempotent; at most one answer is being written per conversation.
CREATE TABLE ai_turns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES ai_conversations (id),
  user_id         uuid NOT NULL REFERENCES users (id),
  client_id       text NOT NULL,
  question        text NOT NULL,
  status          text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done')),
  stop_reason     text CHECK (stop_reason IN ('end_turn', 'max_tokens', 'refusal', 'stopped', 'limit', 'cap', 'error')),
  notice          text,
  cost_usd        numeric(12, 6) NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  UNIQUE (user_id, client_id),
  CONSTRAINT ai_turns_done_finished CHECK ((status = 'done') = (finished_at IS NOT NULL AND stop_reason IS NOT NULL))
);
CREATE UNIQUE INDEX ai_turns_one_running ON ai_turns (conversation_id) WHERE status = 'running';
CREATE INDEX ai_turns_conversation_idx ON ai_turns (conversation_id, created_at);
CREATE INDEX ai_turns_created_idx ON ai_turns (created_at);
CREATE TRIGGER ai_turns_no_delete BEFORE DELETE ON ai_turns FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

-- The transcript as it is replayed to the model, append-only: `content` is
-- exactly what is sent for the message. A refused answer is kept for display
-- (in_replay false) and never sent again.
CREATE TABLE ai_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES ai_conversations (id),
  turn_id         uuid NOT NULL REFERENCES ai_turns (id),
  seq             integer NOT NULL,
  role            text NOT NULL CHECK (role IN ('user', 'assistant')),
  kind            text NOT NULL CHECK (kind IN ('question', 'assistant', 'tool_results', 'repair')),
  content         json NOT NULL,
  -- An answer as the model returned it, when what is replayed differs (a fallback hop).
  raw_content     json,
  in_replay       boolean NOT NULL DEFAULT true,
  model           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq)
);
CREATE INDEX ai_messages_turn_idx ON ai_messages (turn_id, seq);

-- A stored message never changes and is never removed: the model checks that
-- every earlier message is what it was. (json has no equality: compare text.)
CREATE FUNCTION protect_ai_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AI assistant messages are never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.content::text IS DISTINCT FROM OLD.content::text
     OR NEW.raw_content::text IS DISTINCT FROM OLD.raw_content::text
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.seq IS DISTINCT FROM OLD.seq
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.turn_id IS DISTINCT FROM OLD.turn_id
  THEN
    RAISE EXCEPTION 'AI assistant messages cannot be edited.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_messages_append_only BEFORE UPDATE OR DELETE ON ai_messages FOR EACH ROW EXECUTE FUNCTION protect_ai_message();

-- Each query the assistant ran, with the preview it (and the asker) saw.
CREATE TABLE ai_queries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES ai_conversations (id),
  turn_id         uuid NOT NULL REFERENCES ai_turns (id),
  tool_use_id     text NOT NULL,
  purpose         text NOT NULL,
  sql             text NOT NULL,
  ok              boolean NOT NULL,
  error           text,
  columns         json NOT NULL,
  rows            json NOT NULL,
  row_count       integer NOT NULL,
  truncated       boolean NOT NULL,
  ms              integer NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, tool_use_id)
);
CREATE INDEX ai_queries_turn_idx ON ai_queries (turn_id);
CREATE TRIGGER ai_queries_no_delete BEFORE DELETE ON ai_queries FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

-- One row per call to the model, written as soon as the call ends, so the
-- monthly cap reads what was really spent. `partial`: the call was cut off
-- and its output is an estimate.
CREATE TABLE ai_usage (
  id                    bigserial PRIMARY KEY,
  user_id               uuid NOT NULL REFERENCES users (id),
  conversation_id       uuid REFERENCES ai_conversations (id),
  turn_id               uuid REFERENCES ai_turns (id),
  -- The model that served the call.
  model                 text NOT NULL,
  input_tokens          integer NOT NULL DEFAULT 0,
  output_tokens         integer NOT NULL DEFAULT 0,
  cache_write_5m_tokens integer NOT NULL DEFAULT 0,
  cache_write_1h_tokens integer NOT NULL DEFAULT 0,
  cache_read_tokens     integer NOT NULL DEFAULT 0,
  cost_usd              numeric(12, 6) NOT NULL,
  request_id            text,
  partial               boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_created_idx ON ai_usage (created_at);
CREATE INDEX ai_usage_turn_idx ON ai_usage (turn_id);
CREATE TRIGGER ai_usage_no_delete BEFORE DELETE ON ai_usage FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();
