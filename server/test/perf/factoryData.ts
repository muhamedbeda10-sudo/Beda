// ============================================================================
// §20 — a factory's worth of made-up records, to time the assistant's views
// against (aiViewsPerf.test.ts, and by hand: scripts in this folder). One
// session in five per order, five samples a session, a dozen dimensions a
// sample; defects, coils, PT, notes, stages, paint, production tasks, PDI,
// photos and the audit log in the proportions the floor writes them. `sessions` scales
// it all: 30 000 is a few years of a busy factory.
//
// Written straight into the tables through their triggers, so the samples'
// and sessions' rollups (migration 0067) are kept as the app keeps them; the
// caller runs it on a database of its own and ANALYZEs after.
// ============================================================================

export function factoryDataSql(sessions: number): string {
  const orders = Math.max(10, Math.round(sessions / 2))
  return `
INSERT INTO users (username, name, password_hash, role)
SELECT 'perf' || g, 'Inspector ' || g, 'x', 'inspector' FROM generate_series(1, 20) g ON CONFLICT DO NOTHING;
INSERT INTO machines (code, name, display_name, process)
SELECT g::text, 'M' || g, 'Machine ' || g || ' (LM' || g || ')', CASE WHEN g % 5 = 0 THEN 'welding' ELSE 'universal' END
  FROM generate_series(1, 30) g ON CONFLICT DO NOTHING;
INSERT INTO coils (coil_number, grade, supplier, thickness, width)
SELECT 'C' || g, CASE WHEN g % 2 = 0 THEN 'S350GD+Z275' ELSE 'S235JR' END, 'Supplier ' || (g % 12), 1 + (g % 5) * 0.5, 1000 + (g % 3) * 250
  FROM generate_series(1, ${Math.max(100, Math.round(sessions / 4))}) g;
INSERT INTO production_orders (order_number, item, item_code, work_center_code, line_key, expected_grade, customer, required_qty)
SELECT 'O' || (g / 3), CASE WHEN g % 4 = 0 THEN 'Upright ' || (g % 9) || '0x50 : L=' || (2000 + g % 7 * 500) ELSE 'Beam ' || (g % 40) || ' : L=2000' END,
       'IC' || (g % 300), ((g % 30) + 1)::text, 'LK' || g, CASE WHEN g % 2 = 0 THEN 'S350GD+Z275' ELSE 'S235JR' END, 'Customer ' || (g % 50), 100
  FROM generate_series(1, ${orders}) g;
INSERT INTO inspection_sessions (seq, order_id, work_center_code, inspector_id, inspector_name, status, closed_at, started_at, final_qty)
SELECT k, o.id, o.work_center_code, u.id, u.name, 'Closed', t + interval '6 hours', t, 50 + (k * 7) % 100
  FROM production_orders o
  CROSS JOIN generate_series(1, 2) k
  CROSS JOIN LATERAL (SELECT timestamptz '2024-01-01' + (random() * 1000 || ' days')::interval AS t) w
  CROSS JOIN LATERAL (SELECT id, name FROM users WHERE username LIKE 'perf%' ORDER BY random() LIMIT 1) u
 LIMIT ${sessions};
INSERT INTO inspection_samples (session_id, order_id, index, shift, created_at, inspector_id, inspector_name, drawing, sample_qty, submission_id)
SELECT s.id, s.order_id, k, (ARRAY['A','B','C'])[1 + k % 3]::shift_letter, s.started_at + (k || ' hours')::interval, s.inspector_id, s.inspector_name, 'D-1', 1 + k % 3, gen_random_uuid()
  FROM inspection_sessions s CROSS JOIN generate_series(1, 5) k;
INSERT INTO dimension_results (sample_id, name, sequence, nominal, tol_plus, tol_minus, actual, unit, status, source)
SELECT x.id, CASE k WHEN 1 THEN 'Total Length' WHEN 2 THEN 'L : 1' WHEN 3 THEN 'Paint thickness' ELSE 'D' || k END, k,
       CASE WHEN k = 3 THEN 80 ELSE 1000 + k * 10 END, 2, 2, CASE WHEN k = 3 THEN 80 ELSE 1000 + k * 10 END + random() * 5 - 2.5, 'mm',
       CASE WHEN random() < 0.03 THEN 'Fail' ELSE 'Pass' END::dimension_status, 'item-order'
  FROM inspection_samples x CROSS JOIN generate_series(1, 12) k;
INSERT INTO defect_results (sample_id, defect_name, qty, disposition)
SELECT x.id, 'Defect ' || (abs(hashtext(x.id::text)) % 25), 1 + abs(hashtext(x.id::text)) % 4,
       (ARRAY['Rejected','Hold','Repair','Used in another order','Accept with concession'])[1 + abs(hashtext(x.id::text)) % 5]::disposition
  FROM inspection_samples x WHERE abs(hashtext(x.id::text)) % 10 < 3;
INSERT INTO sample_coils (sample_id, coil_number, coil_id)
SELECT x.id, c.coil_number, c.id
  FROM inspection_samples x
  CROSS JOIN LATERAL (SELECT id, coil_number FROM coils OFFSET abs(hashtext(x.id::text)) % (SELECT count(*) FROM coils) LIMIT 1) c;
INSERT INTO pt_records (sample_id, cleaner_lot, penetrant_lot, developer_lot)
SELECT x.id, 'CL1', 'PL1', 'DL1' FROM inspection_samples x WHERE abs(hashtext(x.id::text)) % 10 = 0;
INSERT INTO pt_tested_lengths (pt_record_id, seq, length_mm, verdict)
SELECT p.id, k, 500, CASE WHEN k = 3 THEN 'Reject / Repair' ELSE 'Accept' END::pt_verdict FROM pt_records p CROSS JOIN generate_series(1, 3) k;
INSERT INTO paint_samples (sample_id) SELECT x.id FROM inspection_samples x WHERE abs(hashtext(x.id::text)) % 10 = 1;
INSERT INTO session_notes (session_id, order_id, author_id, author_name, text)
SELECT s.id, s.order_id, s.inspector_id, s.inspector_name, 'Note' FROM inspection_sessions s WHERE abs(hashtext(s.id::text)) % 5 = 0;
INSERT INTO session_stage_quantities (session_id, stage, qty)
SELECT s.id, k, 10 FROM inspection_sessions s CROSS JOIN generate_series(1, 2) k WHERE abs(hashtext(s.id::text)) % 3 = 0;
INSERT INTO production_task_records (line_key, erp_record_id, produced_qty)
SELECT o.line_key, o.line_key || '-' || k, 10 FROM production_orders o CROSS JOIN generate_series(1, 3) k;
INSERT INTO pdi_documents (order_id, created_by_id, created_by_name)
SELECT o.id, u.id, u.name FROM production_orders o, (SELECT id, name FROM users WHERE username = 'perf1') u WHERE abs(hashtext(o.id::text)) % 10 = 0;
INSERT INTO pdi_lines (pdi_id, order_id) SELECT d.id, d.order_id FROM pdi_documents d;
-- Photos: two of every other defect, one of every note, PT record, paint check and PDI.
CREATE TEMP TABLE perf_photo_owner (kind text, owner_id uuid, position int);
INSERT INTO perf_photo_owner SELECT 'defect', d.id, k FROM defect_results d CROSS JOIN generate_series(0, 1) k WHERE abs(hashtext(d.id::text)) % 2 = 0;
INSERT INTO perf_photo_owner SELECT 'note', n.id, 0 FROM session_notes n;
INSERT INTO perf_photo_owner SELECT 'pt', p.id, 0 FROM pt_records p;
INSERT INTO perf_photo_owner SELECT 'paint', p.id, 0 FROM paint_samples p;
INSERT INTO perf_photo_owner SELECT 'pdi', d.id, 0 FROM pdi_documents d;
ALTER TABLE perf_photo_owner ADD COLUMN image_id uuid NOT NULL DEFAULT gen_random_uuid();
INSERT INTO images (id, storage_key, driver, original_filename, mime_type, byte_size, width, height, sha256, uploaded_by_id, uploaded_by_name)
SELECT p.image_id, 'perf/' || p.image_id, 'local', 'photo.jpg', 'image/jpeg', 200000, 1600, 1200, repeat('0', 64), u.id, u.name
  FROM perf_photo_owner p, (SELECT id, name FROM users WHERE username = 'perf1') u;
INSERT INTO defect_images (defect_id, image_id, position) SELECT owner_id, image_id, position FROM perf_photo_owner WHERE kind = 'defect';
INSERT INTO session_note_images (note_id, image_id, position) SELECT owner_id, image_id, position FROM perf_photo_owner WHERE kind = 'note';
INSERT INTO pt_record_images (pt_record_id, image_id, position) SELECT owner_id, image_id, position FROM perf_photo_owner WHERE kind = 'pt';
INSERT INTO paint_sample_images (paint_sample_id, image_id, position) SELECT owner_id, image_id, position FROM perf_photo_owner WHERE kind = 'paint';
INSERT INTO pdi_images (pdi_id, image_id, position) SELECT owner_id, image_id, position FROM perf_photo_owner WHERE kind = 'pdi';
DROP TABLE perf_photo_owner;
INSERT INTO audit_log (user_id, user_name, action, entity, entity_id, field, old_value, new_value, at)
SELECT u.id, u.name, 'update', 'InspectionSample', g::text, 'qty', '1', '2', timestamptz '2024-01-01' + (random() * 1000 || ' days')::interval
  FROM generate_series(1, ${sessions * 4}) g, (SELECT id, name FROM users WHERE username = 'perf1') u;
`
}
