-- ============================================================================
-- 0007 — The machine register carries the process; PT records list every
-- tested length; controlled work instructions (PDF) live in the database.
--
--   • machines.process — forming | welding | paint | other. Decides the wizard
--     steps and the work instructions an inspection on that machine gets.
--     Backfilled from the legacy work-centre numbers the code used to hold
--     (7, 11, 48 paint; 22, 58 welding; everything else forming).
--   • pt_tested_lengths — one row per tested weld length with its own verdict;
--     the record's accept_or_repair is Reject / Repair as soon as one is.
--   • work_instructions — a PDF per document code and issue. A new issue
--     supersedes the previous row, which stays on record.
-- ============================================================================

-- ---- Machines: the process ---------------------------------------------------

ALTER TABLE machines
  ADD COLUMN process text NOT NULL DEFAULT 'forming'
    CONSTRAINT machines_process_check CHECK (process IN ('forming', 'welding', 'paint', 'other'));

UPDATE machines
   SET process = CASE
                   WHEN substring(btrim(code) FROM '^[0-9]+') IN ('7', '11', '48') THEN 'paint'
                   WHEN substring(btrim(code) FROM '^[0-9]+') IN ('22', '58') THEN 'welding'
                   WHEN name ~* 'paint|dahan|دهان' THEN 'paint'
                   WHEN name ~* 'weld|لحام' THEN 'welding'
                   ELSE 'forming'
                 END;

-- ---- PT: tested lengths -------------------------------------------------------

CREATE TABLE pt_tested_lengths (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pt_record_id  uuid NOT NULL REFERENCES pt_records (id),
  seq           integer NOT NULL CHECK (seq > 0),
  length_mm     numeric(10, 2) NOT NULL CHECK (length_mm > 0),
  verdict       pt_verdict NOT NULL,
  deleted_at    timestamptz,
  deleted_by_id uuid REFERENCES users (id),
  UNIQUE (pt_record_id, seq)
);
CREATE TRIGGER pt_tested_lengths_no_delete BEFORE DELETE ON pt_tested_lengths FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

-- ---- Work instructions --------------------------------------------------------

CREATE TABLE work_instructions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code               text NOT NULL,
  title              text NOT NULL,
  issue_no           text NOT NULL DEFAULT '',
  issue_date         date,
  process            text NOT NULL CHECK (process IN ('all', 'forming', 'welding', 'paint', 'other')),
  step               text NOT NULL CHECK (step IN ('setup', 'dimensions', 'defects', 'pt', 'paint', 'paintThickness')),
  storage_key        text NOT NULL UNIQUE,
  driver             image_driver NOT NULL,
  original_filename  text NOT NULL,
  byte_size          integer NOT NULL CHECK (byte_size > 0),
  sha256             char(64) NOT NULL,
  -- NULL when the document was loaded by the system from the shipped set.
  uploaded_by_id     uuid REFERENCES users (id),
  uploaded_by_name   text NOT NULL,
  uploaded_at        timestamptz NOT NULL DEFAULT now(),
  sort_order         integer NOT NULL DEFAULT 0,
  superseded_at      timestamptz,
  superseded_by_id   uuid REFERENCES work_instructions (id),
  deleted_at         timestamptz,
  deleted_by_id      uuid REFERENCES users (id),
  CONSTRAINT work_instructions_code_not_blank CHECK (btrim(code) <> ''),
  CONSTRAINT work_instructions_title_not_blank CHECK (btrim(title) <> '')
);
-- One issue of a code is in force at a time.
CREATE UNIQUE INDEX work_instructions_code_in_force ON work_instructions (lower(code)) WHERE superseded_at IS NULL AND deleted_at IS NULL;
CREATE INDEX work_instructions_process_step_idx ON work_instructions (process, step) WHERE superseded_at IS NULL AND deleted_at IS NULL;
CREATE TRIGGER work_instructions_no_delete BEFORE DELETE ON work_instructions FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();
