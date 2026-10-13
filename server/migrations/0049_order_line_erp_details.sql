-- ============================================================================
-- 0049 — the ERP details of an order line (§7.7.1). The order sheet's file is
-- now the ERP's whole "Tasks" query: besides the columns production_orders
-- already holds, 42 more, one value per order line — planning (due, refined,
-- planned start and finish, the planning week), the ERP's own quantities
-- (remaining, cancelled, accepted, stock), the part's size and weight,
-- painting (area, powder), raw material, QC totals, shipping, and delays.
--
--   • production_orders gains them as typed, nullable columns: NULL = the
--     ERP has no value. They are a mirror of the ERP, written only by the
--     import (file or Access sync): an empty cell clears one, a column the
--     source does not carry leaves it alone. No CHECKs on them: the ERP is
--     the master, and a row it accepts must not be refused here (it writes
--     negative hold and QC-remaining totals, for one). Figures are plain
--     numeric so nothing the ERP wrote is rounded; days are `date`, with no
--     time zone to shift them.
--   • ai.order_lines carries them (appended, so the view is replaced in
--     place and its grants stay), each with the comment the assistant reads.
-- ============================================================================

ALTER TABLE production_orders
  ADD COLUMN due_date                date,
  ADD COLUMN refined_date            date,
  -- "01/2026" = week/year, as the ERP's Pivot column writes it.
  ADD COLUMN planning_week           text,
  ADD COLUMN erp_remaining_qty       numeric,
  ADD COLUMN cancelled_qty           numeric,
  ADD COLUMN accepted_qty            numeric,
  ADD COLUMN stock_qty               numeric,
  ADD COLUMN length_mm               numeric,
  ADD COLUMN width_mm                numeric,
  ADD COLUMN thickness_mm            numeric,
  -- Of the whole line (every required piece), not of one piece.
  ADD COLUMN weight_kg               numeric,
  ADD COLUMN stage                   text,
  ADD COLUMN qc_category             text,
  ADD COLUMN version_parent_id       text,
  ADD COLUMN parent_id               text,
  ADD COLUMN part_duration_hours     numeric,
  ADD COLUMN model_group_id          text,
  ADD COLUMN total_area_m2           numeric,
  ADD COLUMN total_powder_kg         numeric,
  -- The ERP's Order Type (Production, Purchase order…); `type` stays Export / Local.
  ADD COLUMN erp_order_type          text,
  ADD COLUMN raw_material_qty        numeric,
  ADD COLUMN coil_serial_number      text,
  ADD COLUMN raw_material_powder     text,
  ADD COLUMN item_family             text,
  -- The item's Arabic name (the ERP's Translation column).
  ADD COLUMN item_translation        text,
  ADD COLUMN total_actual_sample_qty numeric,
  ADD COLUMN total_hold_qty          numeric,
  ADD COLUMN total_std_sample_qty    numeric,
  ADD COLUMN total_rem_qc_record_qty numeric,
  ADD COLUMN planned_start           date,
  ADD COLUMN planned_finish          date,
  ADD COLUMN shipping_status         text,
  ADD COLUMN shipping_start_date     date,
  ADD COLUMN shipping_end_date       date,
  ADD COLUMN bom_id                  text,
  ADD COLUMN rm_received_qty         numeric,
  ADD COLUMN rm_receiving_date       date,
  -- The ERP's numeric code; the names of the codes are not on the sheet.
  ADD COLUMN delay_reason_code       integer,
  ADD COLUMN delay_period            numeric,
  ADD COLUMN delay_comment           text,
  ADD COLUMN status_reason           text,
  -- The ERP's header says "RM Promiss Date".
  ADD COLUMN rm_promise_date         date;

-- ---- The assistant's view -------------------------------------------------------------

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
       -- Samples of a deleted session keep deleted_at NULL themselves: only a live session's count.
       (SELECT count(*) FROM inspection_samples x JOIN inspection_sessions s ON s.id = x.session_id AND s.deleted_at IS NULL
         WHERE x.order_id = o.id AND x.deleted_at IS NULL)::int AS samples,
       (SELECT COALESCE(sum(d.qty), 0) FROM defect_results d JOIN inspection_samples x ON x.id = d.sample_id
          JOIN inspection_sessions s ON s.id = x.session_id AND s.deleted_at IS NULL
         WHERE x.order_id = o.id AND x.deleted_at IS NULL AND d.deleted_at IS NULL)::float8 AS defect_pieces,
       (SELECT max(x.created_at) FROM inspection_samples x JOIN inspection_sessions s ON s.id = x.session_id AND s.deleted_at IS NULL
         WHERE x.order_id = o.id AND x.deleted_at IS NULL) AS last_inspected_at,
       (SELECT count(*) FROM pdi_lines pl JOIN pdi_documents d ON d.id = pl.pdi_id AND d.deleted_at IS NULL
         WHERE pl.order_id = o.id)::int       AS pdi_count,
       (SELECT COALESCE(r.finished_at, r.started_at) FROM order_sync_runs r WHERE r.id = o.last_sync_run_id) AS last_seen_by_sync_at,
       o.updated_at                           AS last_changed_at,
       o.due_date                             AS due_date,
       o.refined_date                         AS refined_date,
       NULLIF(btrim(o.planning_week), '')     AS planning_week,
       CASE WHEN o.planning_week ~ '^\s*(0?[1-9]|[1-4][0-9]|5[0-3])\s*/\s*[0-9]{4}\s*$' THEN substring(o.planning_week FROM '^\s*([0-9]{1,2})')::int END AS planning_week_no,
       CASE WHEN o.planning_week ~ '^\s*(0?[1-9]|[1-4][0-9]|5[0-3])\s*/\s*[0-9]{4}\s*$' THEN substring(o.planning_week FROM '([0-9]{4})\s*$')::int END AS planning_week_year,
       o.erp_remaining_qty::float8            AS erp_remaining_qty,
       o.cancelled_qty::float8                AS cancelled_qty,
       o.accepted_qty::float8                 AS accepted_qty,
       o.stock_qty::float8                    AS stock_qty,
       o.length_mm::float8                    AS length_mm,
       o.width_mm::float8                     AS width_mm,
       o.thickness_mm::float8                 AS thickness_mm,
       o.weight_kg::float8                    AS weight_kg,
       NULLIF(btrim(o.stage), '')             AS stage,
       NULLIF(btrim(o.qc_category), '')       AS qc_category,
       NULLIF(btrim(o.version_parent_id), '') AS version_parent_id,
       NULLIF(btrim(o.parent_id), '')         AS parent_id,
       o.part_duration_hours::float8          AS part_duration_hours,
       NULLIF(btrim(o.model_group_id), '')    AS model_group_id,
       o.total_area_m2::float8                AS total_area_m2,
       o.total_powder_kg::float8              AS total_powder_kg,
       NULLIF(btrim(o.erp_order_type), '')    AS erp_order_type,
       o.raw_material_qty::float8             AS raw_material_qty,
       NULLIF(btrim(o.coil_serial_number), '') AS coil_serial_number,
       NULLIF(btrim(o.raw_material_powder), '') AS raw_material_powder,
       NULLIF(btrim(o.item_family), '')       AS item_family,
       NULLIF(btrim(o.item_translation), '')  AS item_translation,
       o.total_actual_sample_qty::float8      AS total_actual_sample_qty,
       o.total_hold_qty::float8               AS total_hold_qty,
       o.total_std_sample_qty::float8         AS total_std_sample_qty,
       o.total_rem_qc_record_qty::float8      AS total_rem_qc_record_qty,
       o.planned_start                        AS planned_start,
       o.planned_finish                       AS planned_finish,
       NULLIF(btrim(o.shipping_status), '')   AS shipping_status,
       o.shipping_start_date                  AS shipping_start_date,
       o.shipping_end_date                    AS shipping_end_date,
       NULLIF(btrim(o.bom_id), '')            AS bom_id,
       o.rm_received_qty::float8              AS rm_received_qty,
       o.rm_receiving_date                    AS rm_receiving_date,
       o.delay_reason_code                    AS delay_reason_code,
       o.delay_period::float8                 AS delay_period,
       NULLIF(btrim(o.delay_comment), '')     AS delay_comment,
       NULLIF(btrim(o.status_reason), '')     AS status_reason,
       o.rm_promise_date                      AS rm_promise_date
  FROM production_orders o
  LEFT JOIN LATERAL (
    SELECT m.display_name, m.factory, m.process FROM machines m
     WHERE ai.machine_key(m.code) = ai.machine_key(o.work_center_code) AND m.deleted_at IS NULL
     ORDER BY m.created_at LIMIT 1) m ON true
 WHERE o.deleted_at IS NULL;
COMMENT ON COLUMN ai.order_lines.due_date IS 'The line''s due date in the ERP (Due Date), a day.';
COMMENT ON COLUMN ai.order_lines.refined_date IS 'The ERP''s refined date of the line (Refined Date), a day.';
COMMENT ON COLUMN ai.order_lines.planning_week IS 'The ERP''s planning week of the line (the sheet''s Pivot column) as written: "01/2026" = week 1 of 2026. planning_week_no and planning_week_year are its two numbers; sort and group by those, never by this text.';
COMMENT ON COLUMN ai.order_lines.planning_week_no IS 'Week number (1-53) of planning_week; NULL when it does not read as week/year.';
COMMENT ON COLUMN ai.order_lines.planning_week_year IS 'Year of planning_week; NULL when it does not read as week/year.';
COMMENT ON COLUMN ai.order_lines.erp_remaining_qty IS 'Pieces remaining as the ERP itself writes it (Rem_Q). remaining_qty is the app''s own max(0, required_qty - finished_qty).';
COMMENT ON COLUMN ai.order_lines.cancelled_qty IS 'Cancelled pieces of the line in the ERP (Canceled_Qty).';
COMMENT ON COLUMN ai.order_lines.accepted_qty IS 'Accepted pieces of the line in the ERP (Accepted_Qty).';
COMMENT ON COLUMN ai.order_lines.stock_qty IS 'The ERP''s stock quantity of the line (Stock_Qty).';
COMMENT ON COLUMN ai.order_lines.length_mm IS 'Length in mm (L (mm)); 0 where the ERP gives none.';
COMMENT ON COLUMN ai.order_lines.width_mm IS 'Width in mm (W (mm)); 0 where the ERP gives none.';
COMMENT ON COLUMN ai.order_lines.thickness_mm IS 'Thickness in mm (T (mm)); 0 where the ERP gives none.';
COMMENT ON COLUMN ai.order_lines.weight_kg IS 'Weight of the WHOLE line in kg (W (Kg)): all required pieces, not one piece. Sum it over lines; never multiply it by a quantity.';
COMMENT ON COLUMN ai.order_lines.stage IS 'The ERP''s stage of the line (Stage), as written.';
COMMENT ON COLUMN ai.order_lines.qc_category IS 'The ERP''s QC category of the line (QC Category), e.g. Normal.';
COMMENT ON COLUMN ai.order_lines.version_parent_id IS 'The ERP''s version parent id (VersionParentID), as written; "Del" is the ERP''s own mark.';
COMMENT ON COLUMN ai.order_lines.parent_id IS 'The ERP''s parent id of the line (Parent ID), as written; "Deleted" and "null" are the ERP''s own marks.';
COMMENT ON COLUMN ai.order_lines.part_duration_hours IS 'The ERP''s part duration in hours (Part Dur (Hr)).';
COMMENT ON COLUMN ai.order_lines.model_group_id IS 'The ERP''s model group (Model Group ID), e.g. FP.MF, SF.PO, AC.SYS.';
COMMENT ON COLUMN ai.order_lines.total_area_m2 IS 'Total surface area of the whole line in m2 (Total area(m2)).';
COMMENT ON COLUMN ai.order_lines.total_powder_kg IS 'Total paint powder of the whole line in kg (Total Powder (KG)).';
COMMENT ON COLUMN ai.order_lines.erp_order_type IS 'The ERP''s order type (Order Type), e.g. Production, Production order, Purchase order; "0" is the ERP''s blank. Not order_type, which is Export / Local.';
COMMENT ON COLUMN ai.order_lines.raw_material_qty IS 'Raw material quantity of the line (Raw Material Qty), in the raw material''s own unit.';
COMMENT ON COLUMN ai.order_lines.coil_serial_number IS 'Coil serial number the ERP gives the line (Coil Serial Number). The coils the inspection recorded are in ai.sample_coils.';
COMMENT ON COLUMN ai.order_lines.raw_material_powder IS 'The paint powder of the line (Raw Material Powder), as the ERP describes it.';
COMMENT ON COLUMN ai.order_lines.item_family IS 'The item''s family code (Item Family), e.g. XL, SH, LO, EU.';
COMMENT ON COLUMN ai.order_lines.item_translation IS 'The item''s Arabic name (Translation); "0" is the ERP''s blank.';
COMMENT ON COLUMN ai.order_lines.total_actual_sample_qty IS 'QC samples actually taken, as the ERP totals them (Total Actual Sample Qty). The inspection record''s own count is samples.';
COMMENT ON COLUMN ai.order_lines.total_hold_qty IS 'Hold quantity as the ERP totals it (Total Hold Qty); the ERP may write it negative.';
COMMENT ON COLUMN ai.order_lines.total_std_sample_qty IS 'Standard sample quantity as the ERP totals it (Total Std Sample Qty).';
COMMENT ON COLUMN ai.order_lines.total_rem_qc_record_qty IS 'QC record quantity remaining as the ERP totals it (Total Rem QC Record Qty); the ERP may write it negative.';
COMMENT ON COLUMN ai.order_lines.planned_start IS 'Planned start of the line (Planned Start), a day.';
COMMENT ON COLUMN ai.order_lines.planned_finish IS 'Planned finish of the line (Planned Finish), a day.';
COMMENT ON COLUMN ai.order_lines.shipping_status IS 'Shipped | Partial Shipped | Not Shipped, as the ERP writes it (Shipping Status).';
COMMENT ON COLUMN ai.order_lines.shipping_start_date IS 'Shipping start of the line (Shipping Start Date), a day.';
COMMENT ON COLUMN ai.order_lines.shipping_end_date IS 'Shipping end of the line (Shipping End Date), a day.';
COMMENT ON COLUMN ai.order_lines.bom_id IS 'The ERP''s bill-of-materials id of the line (Bom ID).';
COMMENT ON COLUMN ai.order_lines.rm_received_qty IS 'Raw material received for the line (RM Received QTY).';
COMMENT ON COLUMN ai.order_lines.rm_receiving_date IS 'Day the raw material was received (RM Receiving Date).';
COMMENT ON COLUMN ai.order_lines.delay_reason_code IS 'The ERP''s delay reason as its numeric code (DelayReason). What each code means is not on the sheet: report the code, never guess its meaning.';
COMMENT ON COLUMN ai.order_lines.delay_period IS 'The ERP''s delay period (DelayPeriod), as written; the ERP does not state its unit.';
COMMENT ON COLUMN ai.order_lines.delay_comment IS 'Free comment on the delay (DelayComment), as written; a date in it is month/day/year.';
COMMENT ON COLUMN ai.order_lines.status_reason IS 'Why the line has its status (Status Reason), as written: who asked for a hold or a cancel, and when.';
COMMENT ON COLUMN ai.order_lines.rm_promise_date IS 'Day the raw material is promised for (RM Promiss Date).';
