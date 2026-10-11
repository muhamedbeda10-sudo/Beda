-- ============================================================================
-- 0039 — the connector welding wire (§5.6). A welding sample records, under
-- the welding wire batch on its setup step, the batch of the wire the
-- connectors are welded with: required on every welding sample saved from
-- now on (the API and the wizard refuse one without it), null on the
-- samples recorded before. Like the welding wire, it is offered again from
-- the session's latest sample, so it is typed once per spool.
--   • pt_records.connector_wire_batch
--   • ai.pt_records shows it, last, so the assistant can trace it too (the
--     view keeps its columns and grants: a column may only be added at the
--     end of a view replaced in place).
-- ============================================================================

ALTER TABLE pt_records ADD COLUMN connector_wire_batch text;

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
       p.test_frequency_pct                   AS legacy_test_frequency_pct,
       p.connector_wire_batch
  FROM pt_records p
  JOIN inspection_samples x ON x.id = p.sample_id AND x.deleted_at IS NULL
  JOIN inspection_sessions s ON s.id = x.session_id AND s.deleted_at IS NULL
  JOIN production_orders o ON o.id = x.order_id
  LEFT JOIN machines m ON lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL
 WHERE p.deleted_at IS NULL;
COMMENT ON COLUMN ai.pt_records.connector_wire_batch IS 'Batch of the connector welding wire (required on welding samples from 0039 on; null on older ones); welding_wire_batch is the main welding wire.';
