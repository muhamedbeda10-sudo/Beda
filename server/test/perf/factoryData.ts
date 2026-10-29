// ============================================================================
// §20 — a factory's worth of made-up records, to time the assistant's views
// against (aiViewsPerf.test.ts, and by hand: scripts in this folder). One
// session in five per order, five samples a session, a dozen dimensions a
// sample; defects, coils, PT, notes, stages, paint, production tasks, PDI,
// scrap, photos, the audit log, planning's plans, the lab's tests of incoming coils and receiving's POs, delivery notes and coils in the proportions the floor writes them. `sessions` scales
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
-- Scrap: one weighing for every other session, on its machine, each with its card and box photos.
CREATE TEMP TABLE perf_scrap AS
SELECT s.id AS session_id, s.started_at, m.id AS machine_id, m.code, m.display_name, gen_random_uuid() AS card, gen_random_uuid() AS box
  FROM inspection_sessions s JOIN machines m ON m.code = s.work_center_code AND m.deleted_at IS NULL
 WHERE abs(hashtext(s.id::text)) % 2 = 0;
INSERT INTO images (id, storage_key, driver, original_filename, mime_type, byte_size, width, height, sha256, uploaded_by_id, uploaded_by_name)
SELECT x, 'perf/' || x, 'local', 'scrap.jpg', 'image/jpeg', 200000, 1600, 1200, repeat('0', 64), u.id, u.name
  FROM perf_scrap p CROSS JOIN LATERAL (VALUES (p.card), (p.box)) v (x), (SELECT id, name FROM users WHERE username = 'perf1') u;
INSERT INTO scrap_records (submission_id, request_hash, date, factory, machine_id, machine_code, machine_name, scrap_type_id, scrap_type_name, weight_kg,
                           inspector_id, inspector_name, card_image_id, box_image_id, created_at, created_by_id, created_by_name, updated_by_id, updated_by_name)
SELECT gen_random_uuid(), 'perf', p.started_at::date, 'LM' || (abs(hashtext(p.code)) % 3 + 1), p.machine_id, p.code, p.display_name, t.id, t.name,
       50 + abs(hashtext(p.session_id::text)) % 1900, u.id, u.name, p.card, p.box, p.started_at, u.id, u.name, u.id, u.name
  FROM perf_scrap p
  JOIN scrap_types t ON t.name = CASE WHEN abs(hashtext(p.session_id::text)) % 5 = 0 THEN 'Soft scrap' ELSE 'Coarse scrap' END,
       (SELECT id, name FROM users WHERE username = 'perf2') u;
DROP TABLE perf_scrap;
INSERT INTO audit_log (user_id, user_name, action, entity, entity_id, field, old_value, new_value, at)
SELECT u.id, u.name, 'update', 'InspectionSample', g::text, 'qty', '1', '2', timestamptz '2024-01-01' + (random() * 1000 || ' days')::interval
  FROM generate_series(1, ${sessions * 4}) g, (SELECT id, name FROM users WHERE username = 'perf1') u;
-- §25 planning: the automatic plan, the published one, one superseded and three scenarios, each with every order line placed;
-- what was learnt of each machine, its paces by item and family, the items' routes; set capacities, paces and the map.
INSERT INTO planning_plans (kind, name, status, created_by_name, published_at, events, computed_at, lines, placed, late)
SELECT k, n, st, 'perf', CASE WHEN st IN ('published', 'superseded') THEN now() - (g || ' days')::interval END,
       CASE WHEN k = 'scenario' THEN '[{"id":"d","type":"machine-down","machineKey":"3","from":"2026-10-24 08:00","to":"2026-10-26 08:00"}]'::jsonb ELSE '[]' END,
       now(), ${orders}, ${orders}, ${Math.round(orders / 10)}
  FROM (VALUES (1, 'auto', 'Automatic plan', 'draft'), (2, 'plan', 'Week plan', 'published'), (9, 'plan', 'Last week', 'superseded'),
               (3, 'scenario', 'Press down', 'draft'), (4, 'scenario', 'Friday worked', 'draft'), (5, 'scenario', 'Rush order', 'archived')) AS v(g, k, n, st);
INSERT INTO planning_operations (plan_id, line_id, order_line_id, line_key, order_number, item_code, item, customer, machine_key, seq, qty, hours,
                                 duration_source, start_at, end_at, due_date, late_days, depends_on, weight_kg, flags)
SELECT p.id, o.id::text, o.id, o.line_key, o.order_number, o.item_code, o.item, o.customer, o.work_center_code, row_number() OVER (PARTITION BY p.id, o.work_center_code ORDER BY o.id)::int,
       o.required_qty, 4 + abs(hashtext(o.id::text)) % 20, CASE WHEN abs(hashtext(o.id::text)) % 4 = 0 THEN 'assumed' ELSE 'erp' END,
       now() + (abs(hashtext(o.id::text)) % 2000 || ' hours')::interval, now() + (abs(hashtext(o.id::text)) % 2000 + 24 || ' hours')::interval,
       (now() + (abs(hashtext(o.line_key)) % 90 || ' days')::interval)::date, abs(hashtext(o.id::text)) % 7, '{}', 500, '{}'
  FROM planning_plans p CROSS JOIN production_orders o;
INSERT INTO planning_learnt_machines (machine_key, hours_per_day, hours_from, days_observed, efficiency, efficiency_samples, works_fridays, fridays_worked, last_work_day, shifts, learnt_at)
SELECT g::text, 16, 'actual', 100, 0.9, 400, false, 0, current_date, ARRAY['صباحي', 'مسائي'], now() FROM generate_series(1, 30) g;
INSERT INTO planning_learnt_rates (machine_key, item_code, item_family, pieces_per_hour, samples, learnt_at)
SELECT ((g % 30) + 1)::text, 'ic' || g, '', 40, 5, now() FROM generate_series(1, 300) g
UNION ALL SELECT g::text, '', '', 30, 50, now() FROM generate_series(1, 30) g;
INSERT INTO planning_learnt_routes (item_code, item, processes, steps, orders_seen, confidence_pct, learnt_at)
SELECT 'ic' || g, 'Beam ' || g, ARRAY['forming', 'welding', 'paint'], '[{"process":"forming","machines":[{"machineKey":"1","lines":4}]}]', 4, 75, now() FROM generate_series(1, 300) g;
INSERT INTO planning_machine_capacity (machine_key, hours_per_day, works_fridays) SELECT g::text, 22, g % 2 = 0 FROM generate_series(1, 10) g;
INSERT INTO planning_setup_times (machine_key, process, from_family, to_family, minutes) SELECT g::text, NULL, 'xl', 's', 30 + g FROM generate_series(1, 30) g;
INSERT INTO planning_setup_times (machine_key, process, from_family, to_family, minutes) VALUES (NULL, 'forming', '', '', 45), (NULL, NULL, '', '', 20);
INSERT INTO planning_maintenance (machine_key, name, every_days, duration_hours, last_done) SELECT g::text, 'Oil change', 30, 4, current_date - (g % 30) FROM generate_series(1, 30) g;
INSERT INTO planning_rates (machine_key, item_family, pieces_per_hour) SELECT g::text, 'xl', 25 FROM generate_series(1, 10) g;
INSERT INTO planning_machine_layout (machine_key, x, y, w, h) SELECT g::text, (g * 2) % 22, (g / 11) * 3, 2, 2 FROM generate_series(1, 30) g;
-- §26 the lab: a test for about one coil in three (three specimens each, a few imported from the log with one), under the seeded grades.
INSERT INTO lab_tests (reference, test_date, specimen_type, specimen_code, size, thickness, grade, material_standard, test_standard, machine,
                       yield_min, tensile_min, tensile_max, elongation_min, certificate, mtc_tensile, mtc_yield, mtc_elongation, tested_by,
                       source, form, submission_id, request_hash, created_by_id, created_by_name, updated_by_id, updated_by_name, created_at)
SELECT g || '-' || to_char(d, 'YY'), d::date, CASE WHEN g % 10 = 0 THEN 'Bolt' WHEN g % 4 = 0 THEN 'Galvanized Sheet' ELSE 'Black Sheet' END,
       'C' || g, (1 + (g % 5) * 0.5) || ' mm', 1 + (g % 5) * 0.5, CASE WHEN g % 10 = 0 THEN '8.8' WHEN g % 4 = 0 THEN 'S350GD' ELSE 'S420MC' END,
       'EN 10149-2-2013', 'EN 10002-1', 'GALDABINI - Quasar 200 T', 420, 480, 620, 16, 'MTC ' || (g % 40), 520, 430, 22, u.name,
       CASE WHEN g % 20 = 0 THEN 'log-import' ELSE 'app' END, '{"code":"F-Q-02-20"}', gen_random_uuid(), 'x', u.id, u.name, u.id, u.name, d
  FROM generate_series(1, ${Math.max(30, Math.round(sessions / 12))}) g
  CROSS JOIN LATERAL (SELECT timestamptz '2024-01-01' + (g % 1000 || ' days')::interval AS d) w,
       (SELECT id, name FROM users WHERE username = 'perf1') u;
INSERT INTO lab_test_specimens (test_id, position, tensile, yield, elongation)
SELECT t.id, k, 480 + abs(hashtext(t.id::text || k)) % 160, 400 + abs(hashtext(k || t.id::text)) % 80, 14 + abs(hashtext(t.id::text)) % 15
  FROM lab_tests t CROSS JOIN generate_series(1, 3) k WHERE t.source = 'app' OR k = 1;
-- §27 receiving: a PO for about one order in ten (four lines each), a delivery note and a half a PO (three lines, most decided),
-- coils on the paper of one note in three, half of them already in the coil register (their MTC read).
INSERT INTO purchase_orders (po_number, supplier, po_date, source, created_by_name, updated_by_name, created_at)
SELECT 'PO-' || g, 'Supplier ' || (g % 12), date '2024-01-01' + (g % 1000), CASE WHEN g % 3 = 0 THEN 'manual' ELSE 'import' END, 'perf', 'perf',
       timestamptz '2024-01-01' + (g % 1000 || ' days')::interval
  FROM generate_series(1, ${Math.max(20, Math.round(sessions / 10))}) g;
INSERT INTO purchase_order_lines (po_id, line_no, item_code, description, drawing, dimensions, quantity, unit, created_at)
SELECT p.id, k, 'ITEM-' || (abs(hashtext(p.id::text || k)) % 400), 'Bracket ' || k, 'DWG-' || k, '100 x 50 x 3', 100 + k * 25, 'pcs', p.created_at
  FROM purchase_orders p CROSS JOIN generate_series(1, 4) k;
INSERT INTO receiving_notes (reference, po_id, factory, delivered_on, submission_id, request_hash, created_by_id, created_by_name, updated_by_id, updated_by_name, created_at)
SELECT 'DN-P-' || row_number() OVER (), p.id, 'Factory ' || (k % 3 + 1), (p.created_at + (k * 7 || ' days')::interval)::date, gen_random_uuid(), 'x', u.id, u.name, u.id, u.name,
       p.created_at + (k * 7 || ' days')::interval
  FROM purchase_orders p CROSS JOIN generate_series(1, 2) k, (SELECT id, name FROM users WHERE username = 'perf1') u
 WHERE k = 1 OR abs(hashtext(p.id::text)) % 2 = 0;
INSERT INTO receiving_note_lines (note_id, po_line_id, position, quantity, status, accepted_qty, rejected_qty, hold_reason, reject_reason, decided_at, decided_by_name, created_at)
SELECT d.id, l.id, l.line_no, 50, s.status,
       CASE s.status WHEN 'accepted' THEN 50 WHEN 'partial' THEN 40 WHEN 'rejected' THEN 0 END,
       CASE s.status WHEN 'accepted' THEN 0 WHEN 'partial' THEN 10 WHEN 'rejected' THEN 50 END,
       CASE WHEN s.status = 'hold' THEN 'Missing MTC' ELSE '' END,
       CASE WHEN s.status IN ('partial', 'rejected') THEN 'Out of tolerance' ELSE '' END,
       CASE WHEN s.status <> 'pending' THEN d.created_at + interval '1 day' END, CASE WHEN s.status <> 'pending' THEN 'perf' ELSE '' END, d.created_at
  FROM receiving_notes d JOIN purchase_order_lines l ON l.po_id = d.po_id AND l.line_no <= 3
  CROSS JOIN LATERAL (SELECT (ARRAY['accepted', 'accepted', 'accepted', 'accepted', 'partial', 'rejected', 'hold', 'pending'])[1 + abs(hashtext(d.id::text || l.id::text)) % 8] AS status) s;
INSERT INTO receiving_note_coils (note_id, position, coil_number, weight, created_at)
SELECT d.id, k, 'C' || (abs(hashtext(d.id::text || k)) % ${Math.max(200, Math.round(sessions / 2))}), 8000 + k * 100, d.created_at
  FROM receiving_notes d CROSS JOIN generate_series(1, 5) k WHERE abs(hashtext(d.id::text)) % 3 = 0
ON CONFLICT DO NOTHING;
`
}
