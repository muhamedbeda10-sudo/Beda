-- ============================================================================
-- §20 — the assistant shows the floor's photos.
--
-- Inspectors photograph what they record: a defect, a note on the session,
-- a penetrant test, a paint check, a PDI. Until now the assistant could only
-- count them (ai.defects.photos, ai.session_notes.photos…). Two views list
-- them, one row per photo, with what it was taken of:
--
--   • ai.inspection_photos (domain inspection): the photos of defects, notes,
--     PT records and paint checks, with their sample, session, order line
--     and machine;
--   • ai.pdi_photos (domain orders): the photos of PDI documents.
--
-- A query that returns a column named photo_id is drawn by the app as the
-- photos themselves, captioned by the row's other columns — in an answer, a
-- saved or scheduled report, and on paper. The bytes stay where they are
-- (served to signed-in people by /api/images/:id/content); the views carry
-- only the ids.
--
-- Fast as CLAUDE.md asks: no per-row subquery; every branch reads from the
-- record a question narrows (a sample's created_at, a note's created_at, a
-- PDI's created_at, each indexed) to its few photos by the owner's id (the
-- junction tables' primary keys lead with it).
-- ============================================================================

-- A note's time is what a question about a period filters it on.
CREATE INDEX session_notes_created_idx ON session_notes (created_at) WHERE deleted_at IS NULL;

CREATE VIEW ai.inspection_photos AS
SELECT i.id AS photo_id,
       'defect'::text AS photo_of,
       di.position + 1 AS photo_no,
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
       COALESCE(NULLIF(btrim(m.display_name), ''), 'Machine ' || s.work_center_code) AS machine,
       COALESCE(m.factory, '') AS factory,
       x.inspector_name AS recorded_by,
       x.shift::text AS shift,
       x.created_at AS recorded_at,
       (x.created_at AT TIME ZONE current_setting('TimeZone'))::date AS recorded_day,
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
SELECT i.id,
       'note',
       ni.position + 1,
       NULL::uuid,
       NULL::text,
       NULL::text,
       n.id,
       n.text,
       NULL::uuid,
       sm.id,
       n.session_id,
       s.seq,
       sm.index,
       n.order_id,
       btrim(o.order_number),
       btrim(o.item_code),
       btrim(o.item),
       btrim(o.customer),
       s.work_center_code,
       COALESCE(NULLIF(btrim(m.display_name), ''), 'Machine ' || s.work_center_code),
       COALESCE(m.factory, ''),
       n.author_name,
       sm.shift::text,
       n.created_at,
       (n.created_at AT TIME ZONE current_setting('TimeZone'))::date,
       i.uploaded_at,
       i.uploaded_by_name
  FROM session_note_images ni
  JOIN images i ON i.id = ni.image_id AND i.deleted_at IS NULL
  JOIN session_notes n ON n.id = ni.note_id AND n.deleted_at IS NULL
  JOIN inspection_sessions s ON s.id = n.session_id AND s.deleted_at IS NULL
  JOIN production_orders o ON o.id = n.order_id
  LEFT JOIN inspection_samples sm ON sm.id = n.sample_id AND sm.deleted_at IS NULL
  LEFT JOIN machines m ON lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL
UNION ALL
SELECT i.id,
       'pt',
       pi.position + 1,
       NULL::uuid,
       NULL::text,
       NULL::text,
       NULL::uuid,
       NULL::text,
       p.id,
       x.id,
       x.session_id,
       s.seq,
       x.index,
       x.order_id,
       btrim(o.order_number),
       btrim(o.item_code),
       btrim(o.item),
       btrim(o.customer),
       s.work_center_code,
       COALESCE(NULLIF(btrim(m.display_name), ''), 'Machine ' || s.work_center_code),
       COALESCE(m.factory, ''),
       x.inspector_name,
       x.shift::text,
       x.created_at,
       (x.created_at AT TIME ZONE current_setting('TimeZone'))::date,
       i.uploaded_at,
       i.uploaded_by_name
  FROM pt_record_images pi
  JOIN images i ON i.id = pi.image_id AND i.deleted_at IS NULL
  JOIN pt_records p ON p.id = pi.pt_record_id AND p.deleted_at IS NULL
  JOIN inspection_samples x ON x.id = p.sample_id AND x.deleted_at IS NULL
  JOIN inspection_sessions s ON s.id = x.session_id AND s.deleted_at IS NULL
  JOIN production_orders o ON o.id = x.order_id
  LEFT JOIN machines m ON lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL
UNION ALL
SELECT i.id,
       'paint',
       pi.position + 1,
       NULL::uuid,
       NULL::text,
       NULL::text,
       NULL::uuid,
       NULL::text,
       NULL::uuid,
       x.id,
       x.session_id,
       s.seq,
       x.index,
       x.order_id,
       btrim(o.order_number),
       btrim(o.item_code),
       btrim(o.item),
       btrim(o.customer),
       s.work_center_code,
       COALESCE(NULLIF(btrim(m.display_name), ''), 'Machine ' || s.work_center_code),
       COALESCE(m.factory, ''),
       x.inspector_name,
       x.shift::text,
       x.created_at,
       (x.created_at AT TIME ZONE current_setting('TimeZone'))::date,
       i.uploaded_at,
       i.uploaded_by_name
  FROM paint_sample_images pi
  JOIN images i ON i.id = pi.image_id AND i.deleted_at IS NULL
  JOIN paint_samples ps ON ps.id = pi.paint_sample_id AND ps.deleted_at IS NULL
  JOIN inspection_samples x ON x.id = ps.sample_id AND x.deleted_at IS NULL
  JOIN inspection_sessions s ON s.id = x.session_id AND s.deleted_at IS NULL
  JOIN production_orders o ON o.id = x.order_id
  LEFT JOIN machines m ON lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL;

COMMENT ON VIEW ai.inspection_photos IS 'The photos inspectors took, one row per photo: of a defect (photo_of = ''defect''), a note on a session (''note''), a penetrant test (''pt'') or a paint check (''paint''), with the sample, session, order line and machine it belongs to. To SHOW photos, return photo_id with a few columns that say what each one is (defect_name, order_number, machine, recorded_at): the app draws them as the photos, captioned by those columns. Filter on recorded_at for a period; join on defect_id, note_id, pt_record_id, sample_id or session_id. Deleted photos and photos of deleted records are left out.';
COMMENT ON COLUMN ai.inspection_photos.photo_id IS 'The photo. A result with a column named photo_id is shown as the photos themselves, captioned by the row''s other columns; never quote the id in an answer.';
COMMENT ON COLUMN ai.inspection_photos.photo_of IS 'What the photo is of: defect, note (a note on the session), pt (a penetrant test record) or paint (a paint check).';
COMMENT ON COLUMN ai.inspection_photos.photo_no IS 'Its place among the photos of the same defect, note or record: 1, 2, 3…';
COMMENT ON COLUMN ai.inspection_photos.defect_id IS 'The defect it shows (ai.defects.defect_id), for a defect''s photo; else NULL.';
COMMENT ON COLUMN ai.inspection_photos.defect_name IS 'The defect it shows, as recorded, for a defect''s photo; else NULL.';
COMMENT ON COLUMN ai.inspection_photos.disposition IS 'The defect''s disposition (Rejected, Hold, Repair, Used in another order, Accept with concession), for a defect''s photo; else NULL.';
COMMENT ON COLUMN ai.inspection_photos.note_id IS 'The note it belongs to (ai.session_notes.note_id), for a note''s photo; else NULL.';
COMMENT ON COLUMN ai.inspection_photos.note_text IS 'The note''s words, for a note''s photo; else NULL.';
COMMENT ON COLUMN ai.inspection_photos.pt_record_id IS 'The penetrant test record it belongs to (ai.pt_records), for a PT photo; else NULL.';
COMMENT ON COLUMN ai.inspection_photos.sample_id IS 'The sample it belongs to (ai.inspection_samples); NULL for a note written on the session rather than a sample.';
COMMENT ON COLUMN ai.inspection_photos.session_id IS 'The inspection session (ai.inspection_sessions).';
COMMENT ON COLUMN ai.inspection_photos.session_no IS 'The session''s number within its order line (#1, #2…).';
COMMENT ON COLUMN ai.inspection_photos.sample_no IS 'The sample''s number within its session (S1, S2…); NULL for a note on the session.';
COMMENT ON COLUMN ai.inspection_photos.order_line_id IS 'The order line (ai.order_lines.order_line_id).';
COMMENT ON COLUMN ai.inspection_photos.order_number IS 'The order number, as the order sheet writes it.';
COMMENT ON COLUMN ai.inspection_photos.item_code IS 'The item''s code on the order line.';
COMMENT ON COLUMN ai.inspection_photos.item IS 'The item''s name on the order line.';
COMMENT ON COLUMN ai.inspection_photos.customer IS 'The order''s customer.';
COMMENT ON COLUMN ai.inspection_photos.machine_code IS 'The session''s machine (work centre) code; filter one machine with ai.machine_key(machine_code) = ''24''.';
COMMENT ON COLUMN ai.inspection_photos.machine IS 'The machine''s name as the app shows it.';
COMMENT ON COLUMN ai.inspection_photos.factory IS 'The machine''s factory, empty when not set.';
COMMENT ON COLUMN ai.inspection_photos.recorded_by IS 'Who recorded the sample (or wrote the note).';
COMMENT ON COLUMN ai.inspection_photos.shift IS 'The sample''s shift (A, B, C); NULL for a note on the session.';
COMMENT ON COLUMN ai.inspection_photos.recorded_at IS 'When the sample (or the note) was recorded: the time to filter a period on (indexed).';
COMMENT ON COLUMN ai.inspection_photos.recorded_day IS 'recorded_at''s factory day.';
COMMENT ON COLUMN ai.inspection_photos.taken_at IS 'When the photo was uploaded (usually moments before the record was saved).';
COMMENT ON COLUMN ai.inspection_photos.taken_by IS 'Who uploaded the photo.';

CREATE VIEW ai.pdi_photos AS
SELECT i.id AS photo_id,
       pi.position + 1 AS photo_no,
       d.id AS pdi_id,
       COALESCE(btrim(o.order_number), '') AS order_number,
       COALESCE(btrim(o.customer), '') AS customer,
       d.created_by_name AS recorded_by,
       d.created_at AS recorded_at,
       (d.created_at AT TIME ZONE current_setting('TimeZone'))::date AS recorded_day,
       i.uploaded_at AS taken_at,
       i.uploaded_by_name AS taken_by
  FROM pdi_images pi
  JOIN images i ON i.id = pi.image_id AND i.deleted_at IS NULL
  JOIN pdi_documents d ON d.id = pi.pdi_id AND d.deleted_at IS NULL
  LEFT JOIN production_orders o ON o.id = d.order_id;

COMMENT ON VIEW ai.pdi_photos IS 'The photos of PDI (pre-delivery inspection) documents, one row per photo. To SHOW them, return photo_id with a few columns that say what each one is (order_number, customer, recorded_at): the app draws them as the photos, captioned by those columns. Filter on recorded_at for a period; join ai.pdi_documents on pdi_id.';
COMMENT ON COLUMN ai.pdi_photos.photo_id IS 'The photo. A result with a column named photo_id is shown as the photos themselves, captioned by the row''s other columns; never quote the id in an answer.';
COMMENT ON COLUMN ai.pdi_photos.photo_no IS 'Its place among the PDI''s photos: 1, 2, 3…';
COMMENT ON COLUMN ai.pdi_photos.pdi_id IS 'The PDI document (ai.pdi_documents.pdi_id).';
COMMENT ON COLUMN ai.pdi_photos.order_number IS 'The PDI''s order number.';
COMMENT ON COLUMN ai.pdi_photos.customer IS 'The order''s customer.';
COMMENT ON COLUMN ai.pdi_photos.recorded_by IS 'Who recorded the PDI.';
COMMENT ON COLUMN ai.pdi_photos.recorded_at IS 'When the PDI was recorded: the time to filter a period on (indexed).';
COMMENT ON COLUMN ai.pdi_photos.recorded_day IS 'recorded_at''s factory day.';
COMMENT ON COLUMN ai.pdi_photos.taken_at IS 'When the photo was uploaded.';
COMMENT ON COLUMN ai.pdi_photos.taken_by IS 'Who uploaded the photo.';

-- Each view to its domain's role (0033): an inspection photo is read with the
-- inspection record, a PDI's with the orders.
DO $$
BEGIN
  EXECUTE format('GRANT SELECT ON ai.inspection_photos TO %I', current_database() || '_ai_inspection');
  EXECUTE format('GRANT SELECT ON ai.pdi_photos TO %I', current_database() || '_ai_orders');
END $$;
