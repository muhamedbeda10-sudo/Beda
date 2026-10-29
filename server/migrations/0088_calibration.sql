-- ============================================================================
-- §27 — Calibration: the measuring instruments, their calibration plan, their
-- certificates and the instruments scrapped (forms F-Q-05-01, the
-- certificate, F-Q-05-03).
--
--   • calibration_categories — the configuration: each kind of instrument's
--     code prefix, usual interval and kind, and its certificate's template
--     (groups of nominal values) and reference.
--   • calibration_departments — where instruments are held, with the code
--     their calibration codes carry (QC.01 of V.171.QC.01).
--   • calibration_items — one instrument: the register's row. Its next
--     calibration is worked out (last + interval) as a generated column, so
--     it can never disagree with them; scrapping is kept on the row (when,
--     why, by whom); its count of certificates is kept by a statement trigger
--     from calibration_certificates (worked out again whole for the
--     instruments a statement touched, as 0067's rollups).
--   • calibration_certificates — one calibration: the device and reference
--     data, the readings by group (jsonb, judged by the server: shared/
--     calibration judgeCertificate), and the outside laboratory's PDF.
--   • calibration_files — the PDFs, in the image store under documents/.
-- The assistant reads them as ai.calibration_items, ai.calibration_certificates
-- and ai.calibration_readings, in the materials domain.
-- ============================================================================

-- ---- Configuration ----------------------------------------------------------------

CREATE TABLE calibration_categories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 120),
  code_prefix     text NOT NULL DEFAULT '' CHECK (code_prefix ~ '^[A-Z]{0,4}$'),
  interval_months integer NOT NULL DEFAULT 12 CHECK (interval_months BETWEEN 1 AND 120),
  kind            text NOT NULL DEFAULT 'internal' CHECK (kind IN ('internal', 'external')),
  resolution      text NOT NULL DEFAULT '' CHECK (length(resolution) <= 60),
  tolerance       numeric(14,6) CHECK (tolerance >= 0),
  unit            text NOT NULL DEFAULT 'mm' CHECK (length(unit) <= 20),
  template        jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(template) = 'array'),
  reference       jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(reference) = 'object'),
  position        integer NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by_name text NOT NULL DEFAULT '',
  deleted_at      timestamptz
);
CREATE UNIQUE INDEX calibration_categories_name_idx ON calibration_categories (lower(btrim(name))) WHERE deleted_at IS NULL;
CREATE TRIGGER calibration_categories_no_delete BEFORE DELETE ON calibration_categories FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

CREATE TABLE calibration_departments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 120),
  code       text NOT NULL DEFAULT '' CHECK (code ~ '^[A-Z0-9.]{0,12}$'),
  position   integer NOT NULL DEFAULT 0,
  deleted_at timestamptz
);
CREATE UNIQUE INDEX calibration_departments_name_idx ON calibration_departments (lower(btrim(name))) WHERE deleted_at IS NULL;
CREATE TRIGGER calibration_departments_no_delete BEFORE DELETE ON calibration_departments FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

CREATE TABLE calibration_files (
  id               uuid PRIMARY KEY,
  storage_key      text NOT NULL UNIQUE,
  driver           image_driver NOT NULL,
  file_name        text NOT NULL CHECK (length(file_name) <= 255),
  byte_size        integer NOT NULL CHECK (byte_size > 0),
  sha256           text NOT NULL,
  uploaded_by_id   uuid NOT NULL REFERENCES users (id),
  uploaded_by_name text NOT NULL,
  uploaded_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX calibration_files_uploaded_by_idx ON calibration_files (uploaded_by_id);
CREATE TRIGGER calibration_files_no_delete BEFORE DELETE ON calibration_files FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

-- ---- Instruments ------------------------------------------------------------------------

CREATE TABLE calibration_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id        uuid REFERENCES calibration_categories (id),
  name               text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 200),
  device_code        text NOT NULL DEFAULT '' CHECK (length(device_code) <= 120),
  manufacturer       text NOT NULL DEFAULT '' CHECK (length(manufacturer) <= 120),
  device_range       text NOT NULL DEFAULT '' CHECK (length(device_range) <= 120),
  resolution         text NOT NULL DEFAULT '' CHECK (length(resolution) <= 60),
  tolerance          numeric(14,6) CHECK (tolerance >= 0),
  unit               text NOT NULL DEFAULT 'mm' CHECK (length(unit) <= 20),
  department_id      uuid REFERENCES calibration_departments (id),
  holder             text NOT NULL DEFAULT '' CHECK (length(holder) <= 200),
  received_on        date,
  kind               text NOT NULL DEFAULT 'internal' CHECK (kind IN ('internal', 'external')),
  calibration_code   text NOT NULL DEFAULT '' CHECK (length(calibration_code) <= 120),
  last_calibrated_on date,
  interval_months    integer NOT NULL DEFAULT 12 CHECK (interval_months BETWEEN 1 AND 120),
  -- As shared/calibration nextDueOn: the same day some months on, the month's last when it is shorter.
  next_due_on        date GENERATED ALWAYS AS ((last_calibrated_on + make_interval(months => interval_months))::date) STORED,
  notes              text NOT NULL DEFAULT '' CHECK (length(notes) <= 4000),
  -- Scrapped (F-Q-05-03): when it was recorded, the day it was taken out of use (when known), why.
  scrapped_at        timestamptz,
  scrapped_on        date,
  scrap_reason       text NOT NULL DEFAULT '' CHECK (length(scrap_reason) <= 200),
  scrap_details      text NOT NULL DEFAULT '' CHECK (length(scrap_details) <= 4000),
  scrapped_by_id     uuid REFERENCES users (id),
  scrapped_by_name   text NOT NULL DEFAULT '',
  -- Kept by calibration_items_refresh() from its certificates.
  certificates       integer NOT NULL DEFAULT 0,
  source             text NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'import')),
  submission_id      uuid NOT NULL UNIQUE,
  request_hash       text NOT NULL,
  version            integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by_id      uuid NOT NULL REFERENCES users (id),
  created_by_name    text NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by_id      uuid NOT NULL REFERENCES users (id),
  updated_by_name    text NOT NULL,
  deleted_at         timestamptz,
  deleted_by_id      uuid REFERENCES users (id),
  CHECK (scrapped_at IS NOT NULL OR (scrapped_on IS NULL AND scrap_reason = '' AND scrapped_by_id IS NULL))
);
-- An instrument in use is known by its calibration code; a scrapped one gives it up.
CREATE UNIQUE INDEX calibration_items_code_idx ON calibration_items (lower(btrim(calibration_code)))
  WHERE deleted_at IS NULL AND scrapped_at IS NULL AND btrim(calibration_code) <> '';
CREATE INDEX calibration_items_due_idx ON calibration_items (next_due_on) WHERE deleted_at IS NULL AND scrapped_at IS NULL;
CREATE INDEX calibration_items_scrapped_idx ON calibration_items (scrapped_at DESC) WHERE deleted_at IS NULL AND scrapped_at IS NOT NULL;
CREATE INDEX calibration_items_scrapped_on_idx ON calibration_items (scrapped_on) WHERE deleted_at IS NULL AND scrapped_on IS NOT NULL;
CREATE INDEX calibration_items_last_idx ON calibration_items (last_calibrated_on) WHERE deleted_at IS NULL;
CREATE INDEX calibration_items_created_idx ON calibration_items (created_at);
CREATE INDEX calibration_items_category_idx ON calibration_items (category_id) WHERE deleted_at IS NULL;
CREATE INDEX calibration_items_department_idx ON calibration_items (department_id) WHERE deleted_at IS NULL;
CREATE INDEX calibration_items_holder_idx ON calibration_items (lower(btrim(holder))) WHERE deleted_at IS NULL;
CREATE INDEX calibration_items_created_by_idx ON calibration_items (created_by_id);
CREATE INDEX calibration_items_updated_by_idx ON calibration_items (updated_by_id);
CREATE INDEX calibration_items_scrapped_by_idx ON calibration_items (scrapped_by_id) WHERE scrapped_by_id IS NOT NULL;
CREATE INDEX calibration_items_deleted_by_idx ON calibration_items (deleted_by_id) WHERE deleted_by_id IS NOT NULL;
CREATE TRIGGER calibration_items_no_delete BEFORE DELETE ON calibration_items FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

-- ---- Certificates -----------------------------------------------------------------------

CREATE TABLE calibration_certificates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         uuid NOT NULL REFERENCES calibration_items (id),
  certificate_no  text NOT NULL DEFAULT '' CHECK (length(certificate_no) <= 120),
  kind            text NOT NULL CHECK (kind IN ('internal', 'external')),
  calibrated_on   date NOT NULL,
  interval_months integer NOT NULL CHECK (interval_months BETWEEN 1 AND 120),
  next_due_on     date GENERATED ALWAYS AS ((calibrated_on + make_interval(months => interval_months))::date) STORED,
  body            text NOT NULL DEFAULT '' CHECK (length(body) <= 200),
  performed_by    text NOT NULL DEFAULT '' CHECK (length(performed_by) <= 200),
  approved_by     text NOT NULL DEFAULT '' CHECK (length(approved_by) <= 200),
  resolution      text NOT NULL DEFAULT '' CHECK (length(resolution) <= 60),
  tolerance       numeric(14,6) CHECK (tolerance >= 0),
  unit            text NOT NULL DEFAULT 'mm' CHECK (length(unit) <= 20),
  reference       jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(reference) = 'object'),
  groups          jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(groups) = 'array'),
  -- Worked out from the readings at the save (shared/calibration judgeCertificate).
  readings        integer NOT NULL DEFAULT 0 CHECK (readings >= 0),
  max_error       numeric(16,6),
  result          text NOT NULL DEFAULT 'no-readings' CHECK (result IN ('pass', 'fail', 'no-tolerance', 'no-readings')),
  file_id         uuid REFERENCES calibration_files (id),
  notes           text NOT NULL DEFAULT '' CHECK (length(notes) <= 4000),
  source          text NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'import')),
  submission_id   uuid NOT NULL UNIQUE,
  request_hash    text NOT NULL,
  version         integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by_id   uuid NOT NULL REFERENCES users (id),
  created_by_name text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by_id   uuid NOT NULL REFERENCES users (id),
  updated_by_name text NOT NULL,
  deleted_at      timestamptz,
  deleted_by_id   uuid REFERENCES users (id)
);
CREATE INDEX calibration_certificates_item_idx ON calibration_certificates (item_id, calibrated_on DESC, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX calibration_certificates_item_all_idx ON calibration_certificates (item_id);
CREATE INDEX calibration_certificates_date_idx ON calibration_certificates (calibrated_on) WHERE deleted_at IS NULL;
CREATE INDEX calibration_certificates_created_idx ON calibration_certificates (created_at);
CREATE INDEX calibration_certificates_result_idx ON calibration_certificates (result, calibrated_on) WHERE deleted_at IS NULL;
CREATE INDEX calibration_certificates_file_idx ON calibration_certificates (file_id) WHERE file_id IS NOT NULL;
CREATE INDEX calibration_certificates_created_by_idx ON calibration_certificates (created_by_id);
CREATE INDEX calibration_certificates_updated_by_idx ON calibration_certificates (updated_by_id);
CREATE INDEX calibration_certificates_deleted_by_idx ON calibration_certificates (deleted_by_id) WHERE deleted_by_id IS NOT NULL;
CREATE TRIGGER calibration_certificates_no_delete BEFORE DELETE ON calibration_certificates FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

-- ---- An instrument's count of certificates, kept as they are written ---------------------------

/** The instruments' counts, worked out again whole from their certificates. */
CREATE FUNCTION calibration_items_refresh(ids uuid[]) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ids IS NULL OR cardinality(ids) = 0 THEN RETURN; END IF;
  UPDATE calibration_items i SET certificates = a.n
  FROM (
    SELECT x.id, count(k.id)::integer AS n
      FROM unnest(ids) AS x(id)
      LEFT JOIN calibration_certificates k ON k.item_id = x.id AND k.deleted_at IS NULL
     GROUP BY x.id
  ) a
  WHERE i.id = a.id AND i.certificates IS DISTINCT FROM a.n;
END
$$;

CREATE FUNCTION calibration_certificates_after_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ids uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT item_id) INTO ids FROM new_rows;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT item_id) INTO ids FROM old_rows;
  ELSE
    SELECT array_agg(DISTINCT item_id) INTO ids FROM (SELECT item_id FROM new_rows UNION SELECT item_id FROM old_rows) x;
  END IF;
  PERFORM calibration_items_refresh(ids);
  RETURN NULL;
END
$$;
CREATE TRIGGER calibration_certificates_rollups_ins AFTER INSERT ON calibration_certificates REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION calibration_certificates_after_change();
CREATE TRIGGER calibration_certificates_rollups_upd AFTER UPDATE ON calibration_certificates REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION calibration_certificates_after_change();
CREATE TRIGGER calibration_certificates_rollups_del AFTER DELETE ON calibration_certificates REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION calibration_certificates_after_change();
REVOKE EXECUTE ON FUNCTION calibration_items_refresh(uuid[]), calibration_certificates_after_change() FROM PUBLIC;

-- ---- Where it starts: the register's instruments and departments, as the workbooks have them --------------
-- The vernier's certificate as the certificates log's "الشهادة" sheet lays it out: its three groups of nominal
-- values and the block gauge set it is checked against. Everything here is edited on Calibration → Setup.

INSERT INTO calibration_categories (name, code_prefix, interval_months, kind, resolution, unit, template, reference, position) VALUES
  ('باكوليس / Vernier caliper', 'V', 12, 'internal', '0.02 mm', 'mm',
   '[{"name":"القياسات الخارجية / External Measurements","nominals":[11.5,40,70,135]},
     {"name":"القياسات الداخلية / Internal Measurements","nominals":[10,79.5,100]},
     {"name":"قياسات العمق / Depth Measurements","nominals":[10,50,100]}]',
   '{"name":"قوالب قياس صلب / Block Gauge set","manufacturer":"ULTRA PRAZISION","serial":"LS 8076","certificateNo":"322/63C007/12/661/2026","body":"المعهد القومى للمعايرة NIS"}', 1),
  ('شريط قياس صلب / Measuring tape', 'M', 3, 'internal', '1 mm', 'mm', '[]', '{}', 2),
  ('ميكروميتر / Micrometer', 'MI', 12, 'external', '0.01 mm', 'mm', '[]', '{}', 3),
  ('زاوية قياس / Protractor and square', 'A', 12, 'external', '', '°', '[]', '{}', 4),
  ('ساعة قياس / Dial gauge', 'DG', 12, 'external', '0.01 mm', 'mm', '[]', '{}', 5),
  ('فيلر / Feeler gauge', 'F', 12, 'external', '', 'mm', '[]', '{}', 6),
  ('عداد تدفق / Flow meter', 'FM', 12, 'external', '', '', '[]', '{}', 7),
  ('مفتاح عزم / Torque tool', 'TQ', 12, 'external', '', 'N·m', '[]', '{}', 8),
  ('أخرى / Other', '', 12, 'external', '', '', '[]', '{}', 9);

INSERT INTO calibration_departments (name, position)
SELECT v, n FROM unnest(ARRAY['الجودة', 'QA', 'اللحام', 'ماكينة السحب', 'التنايات', 'المكابس', 'البنش', 'المقص', 'المنشار', 'البناطة',
  'التركيبات', 'الشبك', 'الدهان', 'الصيانة', 'المخازن', 'المعمل', 'HSE', 'التصميم', 'التخطيط']) WITH ORDINALITY AS x(v, n);

-- ---- Who may ------------------------------------------------------------------------------

INSERT INTO permissions (id) VALUES ('view-calibration'), ('record-calibration'), ('manage-calibration-setup');
INSERT INTO role_permissions (role, permission) VALUES
  ('admin', 'view-calibration'), ('admin', 'record-calibration'), ('admin', 'manage-calibration-setup'),
  ('supervisor', 'view-calibration'), ('supervisor', 'record-calibration'),
  ('inspector', 'view-calibration');

-- ---- The assistant's views ------------------------------------------------------------------------

CREATE OR REPLACE VIEW ai.calibration_items AS
SELECT i.id                          AS calibration_item_id,
       i.name                        AS instrument,
       i.device_code,
       c.name                        AS category,
       c.code_prefix                 AS category_code,
       i.calibration_code,
       d.name                        AS department,
       i.holder,
       i.received_on,
       i.kind,
       i.manufacturer,
       i.device_range,
       i.resolution,
       i.tolerance::float8           AS tolerance,
       i.unit,
       i.interval_months,
       i.last_calibrated_on,
       i.next_due_on,
       CASE WHEN i.scrapped_at IS NOT NULL THEN 'scrapped'
            WHEN i.next_due_on IS NULL THEN 'no-date'
            WHEN i.next_due_on < current_date THEN 'overdue'
            WHEN i.next_due_on <= current_date + 30 THEN 'due-soon'
            ELSE 'valid' END         AS status,
       i.next_due_on - current_date  AS days_left,
       i.scrapped_at IS NOT NULL     AS scrapped,
       i.scrapped_on,
       i.scrapped_at,
       i.scrap_reason,
       i.scrap_details,
       i.scrapped_by_name            AS scrapped_by,
       CASE WHEN i.scrapped_on >= i.received_on THEN i.scrapped_on - i.received_on END AS working_days,
       i.certificates,
       i.notes,
       i.source,
       i.created_at                  AS recorded_at,
       i.updated_at
  FROM calibration_items i
  LEFT JOIN calibration_categories c ON c.id = i.category_id
  LEFT JOIN calibration_departments d ON d.id = i.department_id
 WHERE i.deleted_at IS NULL;

COMMENT ON VIEW ai.calibration_items IS 'The measuring instruments the factory uses (verniers, tapes, micrometers, gauges…) and their calibration plan, one row per instrument, as the register F-Q-05-01 lists them: who holds it, internal or external calibration, the last calibration and the next (last + interval). Scrapped instruments (F-Q-05-03) stay with scrapped = true. The plan: WHERE NOT scrapped, by next_due_on. Certificates: ai.calibration_certificates.';
COMMENT ON COLUMN ai.calibration_items.calibration_item_id IS 'The instrument''s id = ai.calibration_certificates.calibration_item_id.';
COMMENT ON COLUMN ai.calibration_items.instrument IS 'The instrument''s name as the register writes it, often Arabic and English (باكوليس/ Vernier 150mm).';
COMMENT ON COLUMN ai.calibration_items.device_code IS 'The instrument''s own serial or code (كود الجهاز).';
COMMENT ON COLUMN ai.calibration_items.category IS 'Its kind of instrument (Vernier caliper, Measuring tape…), from the configuration.';
COMMENT ON COLUMN ai.calibration_items.category_code IS 'The category''s calibration code prefix (V for verniers, M for tapes).';
COMMENT ON COLUMN ai.calibration_items.calibration_code IS 'Its calibration code (كود المعايرة): prefix.number.department (V.171.QC.02) for an internal calibration, the outside laboratory''s certificate number for an external one. Unique among instruments in use.';
COMMENT ON COLUMN ai.calibration_items.department IS 'The department that holds it (القسم): الجودة, اللحام, التنايات…';
COMMENT ON COLUMN ai.calibration_items.holder IS 'The person it is handed to (مستلم الجهاز).';
COMMENT ON COLUMN ai.calibration_items.received_on IS 'The day the holder received it (تاريخ الاستلام).';
COMMENT ON COLUMN ai.calibration_items.kind IS 'internal (calibrated by the quality department) | external (by an outside laboratory).';
COMMENT ON COLUMN ai.calibration_items.manufacturer IS 'Its maker (Insize, Mitutoyo…).';
COMMENT ON COLUMN ai.calibration_items.device_range IS 'Its range (150mm).';
COMMENT ON COLUMN ai.calibration_items.resolution IS 'Its resolution as written (0.02 mm).';
COMMENT ON COLUMN ai.calibration_items.tolerance IS 'The error allowed (±), in unit; null when none is set.';
COMMENT ON COLUMN ai.calibration_items.unit IS 'The unit of its readings and tolerance (mm…).';
COMMENT ON COLUMN ai.calibration_items.interval_months IS 'Months between calibrations (12 a year, 15 a year and a quarter, 3 for tapes).';
COMMENT ON COLUMN ai.calibration_items.last_calibrated_on IS 'Its last calibration (indexed).';
COMMENT ON COLUMN ai.calibration_items.next_due_on IS 'Its next calibration: last_calibrated_on + interval_months, worked out (indexed: the plan of a month is WHERE next_due_on BETWEEN …). Null without a last calibration.';
COMMENT ON COLUMN ai.calibration_items.status IS 'overdue (next_due_on passed) | due-soon (within 30 days) | valid | no-date (never calibrated) | scrapped, as of today.';
COMMENT ON COLUMN ai.calibration_items.days_left IS 'Days to next_due_on: negative when overdue; null without a date.';
COMMENT ON COLUMN ai.calibration_items.scrapped IS 'Taken out of use (تكهين): it leaves the plan.';
COMMENT ON COLUMN ai.calibration_items.scrapped_on IS 'The day it was scrapped (تاريخ التكهين; indexed); null when not scrapped, or when an imported register gave no day.';
COMMENT ON COLUMN ai.calibration_items.scrapped_at IS 'When the scrapping was recorded (indexed).';
COMMENT ON COLUMN ai.calibration_items.scrap_reason IS 'Why it was scrapped (broken, worn out, out of tolerance, lost…).';
COMMENT ON COLUMN ai.calibration_items.scrap_details IS 'The scrapping''s details as written.';
COMMENT ON COLUMN ai.calibration_items.scrapped_by IS 'Who recorded the scrapping.';
COMMENT ON COLUMN ai.calibration_items.working_days IS 'Days in use before it was scrapped: scrapped_on − received_on (أيام العمل).';
COMMENT ON COLUMN ai.calibration_items.certificates IS 'Its calibration certificates on record (kept as they are written).';
COMMENT ON COLUMN ai.calibration_items.notes IS 'Free notes.';
COMMENT ON COLUMN ai.calibration_items.source IS 'app | import (from the register''s workbook).';
COMMENT ON COLUMN ai.calibration_items.recorded_at IS 'When it was entered in the app (indexed).';
COMMENT ON COLUMN ai.calibration_items.updated_at IS 'When it was last changed.';

CREATE OR REPLACE VIEW ai.calibration_certificates AS
SELECT k.id                          AS calibration_certificate_id,
       k.item_id                     AS calibration_item_id,
       i.name                        AS instrument,
       i.device_code,
       k.certificate_no,
       k.kind,
       k.calibrated_on,
       k.interval_months,
       k.next_due_on,
       k.body                        AS laboratory,
       k.performed_by,
       k.approved_by,
       k.resolution,
       k.tolerance::float8           AS tolerance,
       k.unit,
       k.reference ->> 'name'        AS reference_name,
       k.reference ->> 'serial'      AS reference_serial,
       k.reference ->> 'certificateNo' AS reference_certificate,
       k.reference ->> 'body'        AS reference_laboratory,
       k.readings,
       k.max_error::float8           AS max_error,
       k.result,
       k.file_id IS NOT NULL         AS has_pdf,
       k.notes,
       k.source,
       k.created_at                  AS recorded_at,
       k.updated_at
  FROM calibration_certificates k
  JOIN calibration_items i ON i.id = k.item_id AND i.deleted_at IS NULL
 WHERE k.deleted_at IS NULL;

COMMENT ON VIEW ai.calibration_certificates IS 'Each calibration of an instrument: its certificate (number, day, internal or external, who calibrated it, the reference it was checked against) and its verdict over the readings. Join ai.calibration_items on calibration_item_id; the readings: ai.calibration_readings. Filter the period on calibrated_on.';
COMMENT ON COLUMN ai.calibration_certificates.calibration_certificate_id IS 'The certificate''s id = ai.calibration_readings.calibration_certificate_id.';
COMMENT ON COLUMN ai.calibration_certificates.calibration_item_id IS 'Its instrument = ai.calibration_items.calibration_item_id.';
COMMENT ON COLUMN ai.calibration_certificates.instrument IS 'Its instrument''s name.';
COMMENT ON COLUMN ai.calibration_certificates.device_code IS 'Its instrument''s own serial or code.';
COMMENT ON COLUMN ai.calibration_certificates.certificate_no IS 'The certificate''s number: the instrument''s calibration code for an internal one (V.171.QC.02), the laboratory''s number for an external one.';
COMMENT ON COLUMN ai.calibration_certificates.kind IS 'internal | external.';
COMMENT ON COLUMN ai.calibration_certificates.calibrated_on IS 'The day of the calibration (indexed).';
COMMENT ON COLUMN ai.calibration_certificates.interval_months IS 'Months to the next calibration it set.';
COMMENT ON COLUMN ai.calibration_certificates.next_due_on IS 'The re-calibration day it set: calibrated_on + interval_months.';
COMMENT ON COLUMN ai.calibration_certificates.laboratory IS 'Who calibrated it (جهة المعايرة): the outside laboratory for an external calibration; empty for an internal one.';
COMMENT ON COLUMN ai.calibration_certificates.performed_by IS 'Who did the calibration (القائم بالمعايرة).';
COMMENT ON COLUMN ai.calibration_certificates.approved_by IS 'Who approved the certificate.';
COMMENT ON COLUMN ai.calibration_certificates.resolution IS 'The instrument''s resolution as written on it.';
COMMENT ON COLUMN ai.calibration_certificates.tolerance IS 'The error allowed (±) it was judged by, in unit; null when none.';
COMMENT ON COLUMN ai.calibration_certificates.unit IS 'The readings'' unit.';
COMMENT ON COLUMN ai.calibration_certificates.reference_name IS 'The reference it was checked against (a block gauge set…).';
COMMENT ON COLUMN ai.calibration_certificates.reference_serial IS 'The reference''s serial.';
COMMENT ON COLUMN ai.calibration_certificates.reference_certificate IS 'The reference''s own calibration certificate.';
COMMENT ON COLUMN ai.calibration_certificates.reference_laboratory IS 'Who calibrated the reference (NIS…).';
COMMENT ON COLUMN ai.calibration_certificates.readings IS 'Readings with a nominal value and a reading.';
COMMENT ON COLUMN ai.calibration_certificates.max_error IS 'The largest error by size (reading − nominal, sign kept), in unit.';
COMMENT ON COLUMN ai.calibration_certificates.result IS 'pass (every reading within tolerance) | fail (one is not) | no-tolerance | no-readings (an external certificate kept only as its PDF) (indexed).';
COMMENT ON COLUMN ai.calibration_certificates.has_pdf IS 'The outside laboratory''s certificate is attached as a PDF.';
COMMENT ON COLUMN ai.calibration_certificates.notes IS 'Free notes.';
COMMENT ON COLUMN ai.calibration_certificates.source IS 'app | import (from the certificates log''s workbook).';
COMMENT ON COLUMN ai.calibration_certificates.recorded_at IS 'When it was entered in the app (indexed).';
COMMENT ON COLUMN ai.calibration_certificates.updated_at IS 'When it was last changed.';

CREATE OR REPLACE VIEW ai.calibration_readings AS
SELECT k.id                          AS calibration_certificate_id,
       k.item_id                     AS calibration_item_id,
       k.calibrated_on,
       g.ord::integer                AS group_no,
       g.value ->> 'name'            AS group_name,
       r.ord::integer                AS reading_no,
       (r.value ->> 'nominal')::float8 AS nominal,
       (r.value ->> 'reading')::float8 AS reading,
       round((r.value ->> 'reading')::numeric - (r.value ->> 'nominal')::numeric, 6)::float8 AS error,
       CASE WHEN k.tolerance IS NULL OR r.value ->> 'nominal' IS NULL OR r.value ->> 'reading' IS NULL THEN NULL
            ELSE abs((r.value ->> 'reading')::numeric - (r.value ->> 'nominal')::numeric) <= k.tolerance END AS within_tolerance,
       k.tolerance::float8           AS tolerance,
       k.unit,
       k.created_at                  AS recorded_at
  FROM calibration_certificates k
  JOIN calibration_items i ON i.id = k.item_id AND i.deleted_at IS NULL
 CROSS JOIN LATERAL jsonb_array_elements(k.groups) WITH ORDINALITY AS g(value, ord)
 CROSS JOIN LATERAL jsonb_array_elements(g.value -> 'readings') WITH ORDINALITY AS r(value, ord)
 WHERE k.deleted_at IS NULL;

COMMENT ON VIEW ai.calibration_readings IS 'Each reading of a calibration certificate: the reference''s nominal value, what the instrument read and the error, by group (external, internal, depth measurements…). Join ai.calibration_certificates on calibration_certificate_id; filter the period on calibrated_on.';
COMMENT ON COLUMN ai.calibration_readings.calibration_certificate_id IS 'Its certificate = ai.calibration_certificates.calibration_certificate_id.';
COMMENT ON COLUMN ai.calibration_readings.calibration_item_id IS 'Its instrument = ai.calibration_items.calibration_item_id.';
COMMENT ON COLUMN ai.calibration_readings.calibrated_on IS 'Its certificate''s day.';
COMMENT ON COLUMN ai.calibration_readings.group_no IS 'The group''s place on the certificate, from 1.';
COMMENT ON COLUMN ai.calibration_readings.group_name IS 'The group (القياسات الخارجية / External Measurements…).';
COMMENT ON COLUMN ai.calibration_readings.reading_no IS 'The reading''s place in its group, from 1.';
COMMENT ON COLUMN ai.calibration_readings.nominal IS 'The reference''s nominal value (قيمة القالب), in unit.';
COMMENT ON COLUMN ai.calibration_readings.reading IS 'What the instrument read, in unit.';
COMMENT ON COLUMN ai.calibration_readings.error IS 'reading − nominal, in unit.';
COMMENT ON COLUMN ai.calibration_readings.within_tolerance IS 'The error''s size at most the certificate''s tolerance; null without one.';
COMMENT ON COLUMN ai.calibration_readings.tolerance IS 'The certificate''s tolerance (±).';
COMMENT ON COLUMN ai.calibration_readings.unit IS 'The unit.';
COMMENT ON COLUMN ai.calibration_readings.recorded_at IS 'When its certificate was entered in the app (indexed).';

-- The materials domain holds them, with the coil register and the lab (0033, 0086).
DO $$
DECLARE
  role text := current_database() || '_ai_materials';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role) THEN
    EXECUTE format('GRANT SELECT ON ai.calibration_items, ai.calibration_certificates, ai.calibration_readings TO %I', role);
  END IF;
END $$;
