-- ============================================================================
-- §26 — The lab: the tensile testing machine's log and the material testing
-- reports (form F-Q-02-20) of the coils, bolts and wire that come in.
--
--   • lab_grades — each grade's limits (minimum yield, the tensile range,
--     minimum elongation), per family (sheet, bolt, wire) and, where the
--     standard says so, per thickness band [from, to). Seeded from the lab's
--     workbook (its STD sheet); edited on the Lab tab's Setup.
--   • lab_list_values — the lab's lists: sheet thicknesses, bolt sizes, wire
--     thicknesses, indenters, Rockwell scales, testing machines.
--   • lab_tests — one test: the report's fields and the log's (the supplier
--     certificate, its results, CUS No.), the limits it was judged by
--     (copied at the save: a later change to a grade never rewrites a test),
--     and its figures: averages, lowest and highest of its specimens, kept
--     by a statement trigger from lab_test_specimens (worked out again whole
--     for the tests a statement touched, as 0067's rollups), and the verdict
--     worked out from them as generated columns.
--   • lab_test_specimens — the report's Test Results rows.
--   • lab_test_images — the machine's curve and any photo.
-- The assistant reads them as ai.lab_tests, ai.lab_test_specimens and
-- ai.lab_grade_limits, in the materials domain with the coil register.
-- ============================================================================

-- ---- Master data ----------------------------------------------------------------

CREATE TABLE lab_grades (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family         text NOT NULL CHECK (family IN ('sheet', 'bolt', 'wire')),
  grade          text NOT NULL CHECK (btrim(grade) <> '' AND length(grade) <= 60),
  standard       text NOT NULL DEFAULT '' CHECK (length(standard) <= 120),
  thickness_from numeric(8,3) CHECK (thickness_from >= 0),
  thickness_to   numeric(8,3) CHECK (thickness_to > 0),
  yield_min      numeric(10,2) CHECK (yield_min >= 0),
  yield_max      numeric(10,2) CHECK (yield_max >= 0),
  tensile_min    numeric(10,2) CHECK (tensile_min >= 0),
  tensile_max    numeric(10,2) CHECK (tensile_max >= 0),
  elongation_min numeric(6,2) CHECK (elongation_min >= 0),
  hardness       text NOT NULL DEFAULT '' CHECK (length(hardness) <= 60),
  position       integer NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by_name text NOT NULL DEFAULT '',
  deleted_at     timestamptz,
  CHECK (thickness_from IS NULL OR thickness_to IS NULL OR thickness_from < thickness_to),
  CHECK (yield_min IS NULL OR yield_max IS NULL OR yield_min <= yield_max),
  CHECK (tensile_min IS NULL OR tensile_max IS NULL OR tensile_min <= tensile_max)
);
CREATE UNIQUE INDEX lab_grades_band_idx ON lab_grades (family, lower(btrim(grade)), COALESCE(thickness_from, -1)) WHERE deleted_at IS NULL;
CREATE TRIGGER lab_grades_no_delete BEFORE DELETE ON lab_grades FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

CREATE TABLE lab_list_values (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list       text NOT NULL CHECK (list IN ('sheet-thickness', 'bolt-size', 'wire-thickness', 'indenter', 'scale', 'machine')),
  value      text NOT NULL CHECK (btrim(value) <> '' AND length(value) <= 120),
  position   integer NOT NULL DEFAULT 0,
  deleted_at timestamptz
);
CREATE UNIQUE INDEX lab_list_values_value_idx ON lab_list_values (list, lower(btrim(value))) WHERE deleted_at IS NULL;
CREATE TRIGGER lab_list_values_no_delete BEFORE DELETE ON lab_list_values FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

-- ---- Tests ---------------------------------------------------------------------------

CREATE TABLE lab_test_counters (
  year        integer PRIMARY KEY CHECK (year BETWEEN 1 AND 9999),
  last_number bigint NOT NULL CHECK (last_number >= 0)
);

/** Whether a range of results lies within limits: null with no result or no limit (shared/lab withinLimits). */
CREATE FUNCTION lab_within(low numeric, high numeric, min_limit numeric, max_limit numeric) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN low IS NULL OR (min_limit IS NULL AND max_limit IS NULL) THEN NULL
              ELSE (min_limit IS NULL OR low >= min_limit) AND (max_limit IS NULL OR high <= max_limit) END
$$;

CREATE TABLE lab_tests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference         text NOT NULL CHECK (btrim(reference) <> '' AND length(reference) <= 60),
  test_date         date NOT NULL,
  test_type         text NOT NULL DEFAULT 'Tensile',
  specimen_type     text NOT NULL CHECK (specimen_type IN ('Black Sheet', 'Galvanized Sheet', 'Bolt', 'Wire')),
  material          text GENERATED ALWAYS AS (CASE specimen_type WHEN 'Black Sheet' THEN 'black' WHEN 'Galvanized Sheet' THEN 'galvanized' WHEN 'Bolt' THEN 'bolt' ELSE 'wire' END) STORED,
  specimen_code     text NOT NULL DEFAULT '' CHECK (length(specimen_code) <= 120),
  size              text NOT NULL DEFAULT '' CHECK (length(size) <= 120),
  thickness         numeric(8,3),
  grade             text NOT NULL DEFAULT '' CHECK (length(grade) <= 60),
  material_standard text NOT NULL DEFAULT '',
  test_standard     text NOT NULL DEFAULT '',
  machine           text NOT NULL DEFAULT '',
  -- The limits it was judged by, as they were at the save.
  yield_min         numeric(10,2),
  yield_max         numeric(10,2),
  tensile_min       numeric(10,2),
  tensile_max       numeric(10,2),
  elongation_min    numeric(6,2),
  hardness_spec     text NOT NULL DEFAULT '',
  hardness_standard text NOT NULL DEFAULT 'EN-ISO 6508',
  indenter          text NOT NULL DEFAULT '',
  hardness_scale    text NOT NULL DEFAULT '',
  hardness          numeric(8,2),
  supplier          text NOT NULL DEFAULT '' CHECK (length(supplier) <= 200),
  certificate       text NOT NULL DEFAULT '' CHECK (length(certificate) <= 200),
  cus_no            text NOT NULL DEFAULT '' CHECK (length(cus_no) <= 120),
  mtc_tensile       numeric(10,2),
  mtc_yield         numeric(10,2),
  mtc_elongation    numeric(6,2),
  tested_by         text NOT NULL DEFAULT '' CHECK (length(tested_by) <= 200),
  notes             text NOT NULL DEFAULT '' CHECK (length(notes) <= 4000),
  -- Its specimens' figures, kept by lab_tests_refresh().
  specimens         integer NOT NULL DEFAULT 0,
  tensile_avg       numeric(10,2),
  tensile_low       numeric(10,2),
  tensile_high      numeric(10,2),
  yield_avg         numeric(10,2),
  yield_low         numeric(10,2),
  yield_high        numeric(10,2),
  elongation_avg    numeric(6,2),
  elongation_low    numeric(6,2),
  elongation_high   numeric(6,2),
  tensile_ok        boolean GENERATED ALWAYS AS (lab_within(tensile_low, tensile_high, tensile_min, tensile_max)) STORED,
  yield_ok          boolean GENERATED ALWAYS AS (lab_within(yield_low, yield_high, yield_min, yield_max)) STORED,
  elongation_ok     boolean GENERATED ALWAYS AS (lab_within(elongation_low, elongation_high, elongation_min, NULL)) STORED,
  result            text GENERATED ALWAYS AS (CASE
                      WHEN specimens = 0 THEN 'no-results'
                      WHEN lab_within(tensile_low, tensile_high, tensile_min, tensile_max) IS FALSE
                        OR lab_within(yield_low, yield_high, yield_min, yield_max) IS FALSE
                        OR lab_within(elongation_low, elongation_high, elongation_min, NULL) IS FALSE THEN 'fail'
                      WHEN lab_within(tensile_low, tensile_high, tensile_min, tensile_max)
                        OR lab_within(yield_low, yield_high, yield_min, yield_max)
                        OR lab_within(elongation_low, elongation_high, elongation_min, NULL) THEN 'pass'
                      ELSE 'no-limits' END) STORED,
  source            text NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'log-import')),
  form              jsonb NOT NULL CHECK (jsonb_typeof(form) = 'object'),
  submission_id     uuid NOT NULL UNIQUE,
  request_hash      text NOT NULL,
  version           integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by_id     uuid NOT NULL REFERENCES users (id),
  created_by_name   text NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by_id     uuid NOT NULL REFERENCES users (id),
  updated_by_name   text NOT NULL,
  deleted_at        timestamptz,
  deleted_by_id     uuid REFERENCES users (id)
);
-- A deleted test's number may be given again.
CREATE UNIQUE INDEX lab_tests_reference_idx ON lab_tests (lower(btrim(reference))) WHERE deleted_at IS NULL;
CREATE INDEX lab_tests_date_idx ON lab_tests (test_date DESC, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX lab_tests_created_idx ON lab_tests (created_at);
CREATE INDEX lab_tests_code_idx ON lab_tests (lower(btrim(specimen_code)) text_pattern_ops) WHERE deleted_at IS NULL;
CREATE INDEX lab_tests_result_idx ON lab_tests (result, test_date) WHERE deleted_at IS NULL;
CREATE INDEX lab_tests_material_idx ON lab_tests (material, test_date) WHERE deleted_at IS NULL;
CREATE INDEX lab_tests_grade_idx ON lab_tests (lower(btrim(grade))) WHERE deleted_at IS NULL;
CREATE INDEX lab_tests_created_by_idx ON lab_tests (created_by_id);
CREATE INDEX lab_tests_updated_by_idx ON lab_tests (updated_by_id);
CREATE INDEX lab_tests_deleted_by_idx ON lab_tests (deleted_by_id) WHERE deleted_by_id IS NOT NULL;
CREATE TRIGGER lab_tests_no_delete BEFORE DELETE ON lab_tests FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

CREATE TABLE lab_test_specimens (
  test_id    uuid NOT NULL REFERENCES lab_tests (id),
  position   integer NOT NULL CHECK (position BETWEEN 1 AND 10),
  tensile    numeric(10,2) CHECK (tensile >= 0),
  yield      numeric(10,2) CHECK (yield >= 0),
  elongation numeric(6,2) CHECK (elongation >= 0),
  PRIMARY KEY (test_id, position),
  CHECK (tensile IS NOT NULL OR yield IS NOT NULL OR elongation IS NOT NULL)
);

CREATE TABLE lab_test_images (
  test_id    uuid NOT NULL REFERENCES lab_tests (id),
  image_id   uuid NOT NULL REFERENCES images (id),
  position   integer NOT NULL CHECK (position >= 0),
  removed_at timestamptz,
  PRIMARY KEY (test_id, image_id)
);
CREATE INDEX lab_test_images_image_idx ON lab_test_images (image_id) WHERE removed_at IS NULL;
CREATE TRIGGER lab_test_images_no_delete BEFORE DELETE ON lab_test_images FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

-- ---- Its figures, kept as its specimens are written -------------------------------------------

/** The tests' figures, worked out again whole from their specimens, one save of a test at a time. */
CREATE FUNCTION lab_tests_refresh(ids uuid[]) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ids IS NULL OR cardinality(ids) = 0 THEN RETURN; END IF;
  PERFORM 1 FROM lab_tests WHERE id = ANY (ids) ORDER BY id FOR UPDATE;
  UPDATE lab_tests t SET
    specimens = a.n,
    tensile_avg = a.tensile_avg, tensile_low = a.tensile_low, tensile_high = a.tensile_high,
    yield_avg = a.yield_avg, yield_low = a.yield_low, yield_high = a.yield_high,
    elongation_avg = a.elongation_avg, elongation_low = a.elongation_low, elongation_high = a.elongation_high
  FROM (
    SELECT x.id,
           count(s.position)::integer AS n,
           round(avg(s.tensile), 2) AS tensile_avg, min(s.tensile) AS tensile_low, max(s.tensile) AS tensile_high,
           round(avg(s.yield), 2) AS yield_avg, min(s.yield) AS yield_low, max(s.yield) AS yield_high,
           round(avg(s.elongation), 2) AS elongation_avg, min(s.elongation) AS elongation_low, max(s.elongation) AS elongation_high
      FROM unnest(ids) AS x(id)
      LEFT JOIN lab_test_specimens s ON s.test_id = x.id
     GROUP BY x.id
  ) a
  WHERE t.id = a.id
    AND (t.specimens, t.tensile_avg, t.tensile_low, t.tensile_high, t.yield_avg, t.yield_low, t.yield_high, t.elongation_avg, t.elongation_low, t.elongation_high)
        IS DISTINCT FROM (a.n, a.tensile_avg, a.tensile_low, a.tensile_high, a.yield_avg, a.yield_low, a.yield_high, a.elongation_avg, a.elongation_low, a.elongation_high);
END
$$;

CREATE FUNCTION lab_specimens_after_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ids uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT test_id) INTO ids FROM new_rows;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT test_id) INTO ids FROM old_rows;
  ELSE
    SELECT array_agg(DISTINCT test_id) INTO ids FROM (SELECT test_id FROM new_rows UNION SELECT test_id FROM old_rows) x;
  END IF;
  PERFORM lab_tests_refresh(ids);
  RETURN NULL;
END
$$;
CREATE TRIGGER lab_test_specimens_rollups_ins AFTER INSERT ON lab_test_specimens REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION lab_specimens_after_change();
CREATE TRIGGER lab_test_specimens_rollups_upd AFTER UPDATE ON lab_test_specimens REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION lab_specimens_after_change();
CREATE TRIGGER lab_test_specimens_rollups_del AFTER DELETE ON lab_test_specimens REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION lab_specimens_after_change();
REVOKE EXECUTE ON FUNCTION lab_tests_refresh(uuid[]), lab_specimens_after_change() FROM PUBLIC;

-- ---- The lab's workbook, as it stood -------------------------------------------------------------
-- Limits as its STD sheet gives them (by thickness band where it splits them), bolts per ISO 898-1 as
-- its Data sheet; DC01's 280 is EN 10130's maximum yield (ReH ≤ 280), not a minimum; 4.8 is added
-- (ISO 898-1) as the log tests it. Everything here is edited on Setup.

INSERT INTO lab_grades (family, grade, standard, thickness_from, thickness_to, yield_min, yield_max, tensile_min, tensile_max, elongation_min, hardness, position) VALUES
  ('sheet', 'S355JR',  'EN 10025-2/2019', NULL, 3,    355, NULL, 510, 680, 16, '', 1),
  ('sheet', 'S355JR',  'EN 10025-2/2019', 3,    NULL, 355, NULL, 470, 630, 16, '', 2),
  ('sheet', 'S315MC',  'EN 10149-2-2013', NULL, 3,    315, NULL, 390, 510, 20, '', 3),
  ('sheet', 'S315MC',  'EN 10149-2-2013', 3,    NULL, 315, NULL, 390, 510, 24, '', 4),
  ('sheet', 'S355MC',  'EN 10149-2-2013', NULL, 3,    355, NULL, 430, 550, 19, '', 5),
  ('sheet', 'S355MC',  'EN 10149-2-2013', 3,    NULL, 355, NULL, 430, 550, 23, '', 6),
  ('sheet', 'S420MC',  'EN 10149-2-2013', NULL, 3,    420, NULL, 480, 620, 16, '', 7),
  ('sheet', 'S420MC',  'EN 10149-2-2013', 3,    NULL, 420, NULL, 480, 620, 19, '', 8),
  ('sheet', 'DC01',    'EN-10130',        NULL, NULL, NULL, 280, 270, 410, 28, '', 9),
  ('sheet', 'HC420LA', 'EN 10268',        NULL, NULL, 420, 520, 470, 590, 17, '', 10),
  ('sheet', 'S280GD',  'EN 10346:2015',   NULL, NULL, 280, NULL, 360, NULL, 18, '', 11),
  ('sheet', 'S350GD',  'EN 10346:2015',   NULL, NULL, 350, NULL, 420, NULL, 16, '', 12),
  ('sheet', 'S450GD',  'EN 10346:2015',   NULL, NULL, 450, NULL, 510, NULL, 14, '', 13),
  ('sheet', 'DX51D',   'EN 10346:2015',   NULL, NULL, 140, 300, 270, 500, 22, '', 14),
  ('bolt',  '4.6',     'ISO 898-1',       NULL, NULL, 240, NULL, 400, NULL, 22, '22', 1),
  ('bolt',  '4.8',     'ISO 898-1',       NULL, NULL, 340, NULL, 420, NULL, NULL, '', 2),
  ('bolt',  '5.8',     'ISO 898-1',       NULL, NULL, 400, NULL, 500, NULL, 12, '25', 3),
  ('bolt',  '8.8',     'ISO 898-1',       NULL, NULL, 640, NULL, 800, NULL, 12, '22-32', 4),
  ('bolt',  '10.9',    'ISO 898-1',       NULL, NULL, 900, NULL, 1000, NULL, 9, '32-39', 5),
  ('bolt',  '12.9',    'ISO 898-1',       NULL, NULL, 1080, NULL, 1200, NULL, 8, '39-44', 6);

INSERT INTO lab_list_values (list, value, position)
SELECT 'sheet-thickness', v, n FROM unnest(ARRAY['0.6 mm', '0.7 mm', '0.8 mm', '0.9 mm', '1 mm', '1.2 mm', '1.25 mm', '1.37 mm', '1.5 mm', '1.6 mm', '1.7 mm',
  '1.8 mm', '2 mm', '2.4 mm', '2.5 mm', '2.7 mm', '3 mm', '3.5 mm', '4 mm', '5 mm', '6 mm']) WITH ORDINALITY AS x(v, n)
UNION ALL SELECT 'bolt-size', v, n FROM unnest(ARRAY['M8', 'M10', 'M12', 'M16']) WITH ORDINALITY AS x(v, n)
UNION ALL SELECT 'wire-thickness', v, n FROM unnest(ARRAY['3 mm', '3.9 mm', '4.3 mm', '4.8 mm', '5 mm', '8 mm']) WITH ORDINALITY AS x(v, n)
UNION ALL SELECT 'indenter', v, n FROM unnest(ARRAY['120° Diamond Indenter', '1.5875mm Ball Indenter']) WITH ORDINALITY AS x(v, n)
UNION ALL SELECT 'scale', v, n FROM unnest(ARRAY['HRB', 'HRC', 'HRD']) WITH ORDINALITY AS x(v, n)
UNION ALL SELECT 'machine', 'GALDABINI - Quasar 200 T', 1;

-- ---- Who may ------------------------------------------------------------------------------

INSERT INTO permissions (id) VALUES ('view-lab'), ('record-lab-test'), ('manage-lab-setup');
INSERT INTO role_permissions (role, permission) VALUES
  ('admin', 'view-lab'), ('admin', 'record-lab-test'), ('admin', 'manage-lab-setup'),
  ('supervisor', 'view-lab'), ('supervisor', 'record-lab-test'),
  ('inspector', 'view-lab');

-- ---- The assistant's views ------------------------------------------------------------------------

CREATE OR REPLACE VIEW ai.lab_tests AS
SELECT t.id                         AS lab_test_id,
       t.reference,
       t.test_date,
       t.created_at                 AS recorded_at,
       t.specimen_type,
       t.material,
       t.specimen_code,
       c.coil_number,
       t.size,
       t.thickness::float8          AS thickness,
       t.grade,
       t.material_standard,
       t.test_standard,
       t.machine,
       COALESCE(NULLIF(t.supplier, ''), c.supplier, '') AS supplier,
       t.yield_min::float8          AS yield_min,
       t.yield_max::float8          AS yield_max,
       t.tensile_min::float8        AS tensile_min,
       t.tensile_max::float8        AS tensile_max,
       t.elongation_min::float8     AS elongation_min,
       t.specimens,
       t.tensile_avg::float8        AS tensile_avg,
       t.yield_avg::float8          AS yield_avg,
       t.elongation_avg::float8     AS elongation_avg,
       t.tensile_low::float8        AS tensile_low,
       t.tensile_high::float8       AS tensile_high,
       t.yield_low::float8          AS yield_low,
       t.yield_high::float8         AS yield_high,
       t.elongation_low::float8     AS elongation_low,
       t.elongation_high::float8    AS elongation_high,
       t.tensile_ok,
       t.yield_ok,
       t.elongation_ok,
       t.result,
       t.hardness::float8           AS hardness,
       t.hardness_scale,
       t.indenter,
       t.hardness_spec,
       t.certificate,
       t.cus_no,
       t.mtc_tensile::float8        AS mtc_tensile,
       t.mtc_yield::float8          AS mtc_yield,
       t.mtc_elongation::float8     AS mtc_elongation,
       (t.tensile_avg - t.mtc_tensile)::float8       AS tensile_vs_mtc,
       (t.yield_avg - t.mtc_yield)::float8           AS yield_vs_mtc,
       (t.elongation_avg - t.mtc_elongation)::float8 AS elongation_vs_mtc,
       t.tested_by,
       t.notes,
       t.source,
       t.updated_at
  FROM lab_tests t
  LEFT JOIN coils c ON lower(c.coil_number) = lower(btrim(t.specimen_code)) AND c.deleted_at IS NULL AND btrim(t.specimen_code) <> ''
 WHERE t.deleted_at IS NULL;

COMMENT ON VIEW ai.lab_tests IS 'The lab''s tensile tests of the material that comes in (coils of black and galvanized sheet, bolts, wire), one row per test, as the Material Testing Report (form F-Q-02-20) and the tensile testing machine''s log record it. Filter the period on test_date. Its specimens'' results: ai.lab_test_specimens; the grades'' limits: ai.lab_grade_limits.';
COMMENT ON COLUMN ai.lab_tests.lab_test_id IS 'The test''s id = ai.lab_test_specimens.lab_test_id.';
COMMENT ON COLUMN ai.lab_tests.reference IS 'The test''s number as the lab writes it, number-year: "93-26" is test 93 of 2026 (the report''s Certificate No., the log''s Name).';
COMMENT ON COLUMN ai.lab_tests.test_date IS 'The day of the test (indexed: filter periods on it).';
COMMENT ON COLUMN ai.lab_tests.recorded_at IS 'When the test was entered in the app (indexed).';
COMMENT ON COLUMN ai.lab_tests.specimen_type IS 'Black Sheet | Galvanized Sheet | Bolt | Wire.';
COMMENT ON COLUMN ai.lab_tests.material IS 'black | galvanized (sheet), bolt | wire: the specimen type as one word, comparable with ai.inspection_samples.material (indexed).';
COMMENT ON COLUMN ai.lab_tests.specimen_code IS 'What was tested: a sheet''s coil number, a bolt''s or wire''s batch (the log''s Batch No.).';
COMMENT ON COLUMN ai.lab_tests.coil_number IS 'The coil register''s coil (ai.coils.coil_number) when specimen_code is one; null when it is not in the register. Join ai.coils or ai.sample_coils on it.';
COMMENT ON COLUMN ai.lab_tests.size IS 'The thickness (sheet, wire) or bolt size (M12, M10*50) as recorded.';
COMMENT ON COLUMN ai.lab_tests.thickness IS 'Thickness in mm read from size (sheet, wire); null for a bolt.';
COMMENT ON COLUMN ai.lab_tests.grade IS 'Grade as recorded (S420MC, S350GD, 8.8). The log''s older rows write grades loosely (S420, Black, Z.C): compare ignoring case and spaces.';
COMMENT ON COLUMN ai.lab_tests.material_standard IS 'The grade''s standard (EN 10149-2-2013, ISO 898-1).';
COMMENT ON COLUMN ai.lab_tests.test_standard IS 'The test''s standard: EN 10002-1 for sheet, ISO 898-1 for bolts.';
COMMENT ON COLUMN ai.lab_tests.machine IS 'The testing machine.';
COMMENT ON COLUMN ai.lab_tests.supplier IS 'The coil''s supplier: as recorded on the test, else the coil register''s.';
COMMENT ON COLUMN ai.lab_tests.yield_min IS 'Minimum yield strength (ReH), N/mm², the test was judged by (copied from the grade at the save); null when the grade sets none.';
COMMENT ON COLUMN ai.lab_tests.yield_max IS 'Maximum yield strength, N/mm² (DC01, HC420LA, DX51D); null when none.';
COMMENT ON COLUMN ai.lab_tests.tensile_min IS 'Lowest tensile strength (Rm) allowed, N/mm².';
COMMENT ON COLUMN ai.lab_tests.tensile_max IS 'Highest tensile strength allowed, N/mm²; null when only a minimum is set.';
COMMENT ON COLUMN ai.lab_tests.elongation_min IS 'Minimum elongation after fracture (A), %.';
COMMENT ON COLUMN ai.lab_tests.specimens IS 'Specimens with a result (the report has three; an imported log row has one, its averages).';
COMMENT ON COLUMN ai.lab_tests.tensile_avg IS 'Average tensile strength Rm of the specimens, N/mm² (the log''s RM).';
COMMENT ON COLUMN ai.lab_tests.yield_avg IS 'Average yield strength ReH, N/mm² (the log''s REH).';
COMMENT ON COLUMN ai.lab_tests.elongation_avg IS 'Average elongation A, % (the log''s A).';
COMMENT ON COLUMN ai.lab_tests.tensile_low IS 'Lowest specimen tensile strength, N/mm².';
COMMENT ON COLUMN ai.lab_tests.tensile_high IS 'Highest specimen tensile strength, N/mm².';
COMMENT ON COLUMN ai.lab_tests.yield_low IS 'Lowest specimen yield strength, N/mm².';
COMMENT ON COLUMN ai.lab_tests.yield_high IS 'Highest specimen yield strength, N/mm².';
COMMENT ON COLUMN ai.lab_tests.elongation_low IS 'Lowest specimen elongation, %.';
COMMENT ON COLUMN ai.lab_tests.elongation_high IS 'Highest specimen elongation, %.';
COMMENT ON COLUMN ai.lab_tests.tensile_ok IS 'Every specimen''s tensile strength within the limits; null with no result or no limit.';
COMMENT ON COLUMN ai.lab_tests.yield_ok IS 'Every specimen''s yield strength within the limits; null with no result or no limit.';
COMMENT ON COLUMN ai.lab_tests.elongation_ok IS 'Every specimen''s elongation at least the minimum; null with no result or no limit.';
COMMENT ON COLUMN ai.lab_tests.result IS 'pass | fail | no-limits (results but no limits for the grade) | no-results. Fails when any specimen misses a limit (indexed).';
COMMENT ON COLUMN ai.lab_tests.hardness IS 'Rockwell hardness value measured, on hardness_scale.';
COMMENT ON COLUMN ai.lab_tests.hardness_scale IS 'HRB | HRC | HRD.';
COMMENT ON COLUMN ai.lab_tests.indenter IS 'The hardness indenter.';
COMMENT ON COLUMN ai.lab_tests.hardness_spec IS 'The hardness the grade expects, as its standard writes it (informative).';
COMMENT ON COLUMN ai.lab_tests.certificate IS 'The supplier''s mill test certificate (MTC) the coil came with, as the lab names it.';
COMMENT ON COLUMN ai.lab_tests.cus_no IS 'The log''s CUS No.';
COMMENT ON COLUMN ai.lab_tests.mtc_tensile IS 'Tensile strength the supplier''s certificate states, N/mm².';
COMMENT ON COLUMN ai.lab_tests.mtc_yield IS 'Yield strength the supplier''s certificate states, N/mm².';
COMMENT ON COLUMN ai.lab_tests.mtc_elongation IS 'Elongation the supplier''s certificate states, %.';
COMMENT ON COLUMN ai.lab_tests.tensile_vs_mtc IS 'tensile_avg less mtc_tensile, N/mm² (the log''s RM Variance): negative when the lab found less than the certificate.';
COMMENT ON COLUMN ai.lab_tests.yield_vs_mtc IS 'yield_avg less mtc_yield, N/mm² (Yield Variance).';
COMMENT ON COLUMN ai.lab_tests.elongation_vs_mtc IS 'elongation_avg less mtc_elongation, % (Elongation Variance).';
COMMENT ON COLUMN ai.lab_tests.tested_by IS 'Who ran the test.';
COMMENT ON COLUMN ai.lab_tests.notes IS 'Free notes.';
COMMENT ON COLUMN ai.lab_tests.source IS 'app (recorded on the Lab tab) | log-import (a row of the machine log''s workbook: its averages only).';
COMMENT ON COLUMN ai.lab_tests.updated_at IS 'When the test was last changed.';

CREATE OR REPLACE VIEW ai.lab_test_specimens AS
SELECT s.test_id                    AS lab_test_id,
       t.reference,
       t.test_date,
       t.specimen_type,
       t.grade,
       s.position                   AS specimen_no,
       s.tensile::float8            AS tensile,
       s.yield::float8              AS yield,
       s.elongation::float8         AS elongation,
       lab_within(s.tensile, s.tensile, t.tensile_min, t.tensile_max) AS tensile_ok,
       lab_within(s.yield, s.yield, t.yield_min, t.yield_max)         AS yield_ok,
       lab_within(s.elongation, s.elongation, t.elongation_min, NULL) AS elongation_ok,
       t.created_at                 AS recorded_at
  FROM lab_test_specimens s
  JOIN lab_tests t ON t.id = s.test_id AND t.deleted_at IS NULL;

COMMENT ON VIEW ai.lab_test_specimens IS 'Each specimen of a lab test (the report''s Test Results rows): its tensile strength, yield and elongation. Join ai.lab_tests on lab_test_id; filter the period on test_date.';
COMMENT ON COLUMN ai.lab_test_specimens.lab_test_id IS 'Its test = ai.lab_tests.lab_test_id.';
COMMENT ON COLUMN ai.lab_test_specimens.reference IS 'Its test''s number (93-26).';
COMMENT ON COLUMN ai.lab_test_specimens.test_date IS 'Its test''s day.';
COMMENT ON COLUMN ai.lab_test_specimens.specimen_type IS 'Black Sheet | Galvanized Sheet | Bolt | Wire.';
COMMENT ON COLUMN ai.lab_test_specimens.grade IS 'Its test''s grade.';
COMMENT ON COLUMN ai.lab_test_specimens.specimen_no IS 'The specimen''s row on the report, from 1.';
COMMENT ON COLUMN ai.lab_test_specimens.tensile IS 'Tensile strength Rm, N/mm².';
COMMENT ON COLUMN ai.lab_test_specimens.yield IS 'Yield strength ReH, N/mm².';
COMMENT ON COLUMN ai.lab_test_specimens.elongation IS 'Elongation after fracture A, %.';
COMMENT ON COLUMN ai.lab_test_specimens.tensile_ok IS 'Within its test''s tensile limits; null with no value or no limit.';
COMMENT ON COLUMN ai.lab_test_specimens.yield_ok IS 'Within its test''s yield limits; null with no value or no limit.';
COMMENT ON COLUMN ai.lab_test_specimens.elongation_ok IS 'At least its test''s minimum elongation; null with no value or no limit.';
COMMENT ON COLUMN ai.lab_test_specimens.recorded_at IS 'When its test was entered in the app (indexed).';

CREATE OR REPLACE VIEW ai.lab_grade_limits AS
SELECT id AS lab_grade_id, family, grade, standard,
       thickness_from::float8 AS thickness_from,
       thickness_to::float8   AS thickness_to,
       yield_min::float8      AS yield_min,
       yield_max::float8      AS yield_max,
       tensile_min::float8    AS tensile_min,
       tensile_max::float8    AS tensile_max,
       elongation_min::float8 AS elongation_min,
       hardness,
       updated_at
  FROM lab_grades
 WHERE deleted_at IS NULL;

COMMENT ON VIEW ai.lab_grade_limits IS 'The lab''s grades and the limits a test is judged by, per thickness band where the standard splits them. A test keeps the limits it was judged by (ai.lab_tests.yield_min…): read them there for a past test.';
COMMENT ON COLUMN ai.lab_grade_limits.lab_grade_id IS 'The grade band''s id.';
COMMENT ON COLUMN ai.lab_grade_limits.updated_at IS 'When its limits were last changed.';
COMMENT ON COLUMN ai.lab_grade_limits.family IS 'sheet | bolt | wire.';
COMMENT ON COLUMN ai.lab_grade_limits.grade IS 'The grade (S420MC, 8.8).';
COMMENT ON COLUMN ai.lab_grade_limits.standard IS 'Its standard.';
COMMENT ON COLUMN ai.lab_grade_limits.thickness_from IS 'The band applies from this thickness, mm (inclusive); null from zero.';
COMMENT ON COLUMN ai.lab_grade_limits.thickness_to IS 'The band applies below this thickness, mm (exclusive); null without end.';
COMMENT ON COLUMN ai.lab_grade_limits.yield_min IS 'Minimum yield strength, N/mm².';
COMMENT ON COLUMN ai.lab_grade_limits.yield_max IS 'Maximum yield strength, N/mm².';
COMMENT ON COLUMN ai.lab_grade_limits.tensile_min IS 'Lowest tensile strength, N/mm².';
COMMENT ON COLUMN ai.lab_grade_limits.tensile_max IS 'Highest tensile strength, N/mm².';
COMMENT ON COLUMN ai.lab_grade_limits.elongation_min IS 'Minimum elongation, %.';
COMMENT ON COLUMN ai.lab_grade_limits.hardness IS 'The hardness expected, as written (informative).';

-- The materials domain holds them, with the coil register (0033).
DO $$
DECLARE
  role text := current_database() || '_ai_materials';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role) THEN
    EXECUTE format('GRANT SELECT ON ai.lab_tests, ai.lab_test_specimens, ai.lab_grade_limits TO %I', role);
  END IF;
END $$;
