-- ============================================================================
-- Report styles and Excel forms (shared/src/reportStyles.ts).
--
--   • report_styles — how a report looks when it leaves the app: a set of
--     choices (colours, typeface, logo, letterhead, document control, tables,
--     approval boxes), never code. Anyone given the assistant keeps their own;
--     one with the Configuration permission shares one and makes one the
--     company's default (one at most, always shared). Each save is a version,
--     kept in report_style_versions.
--   • ai_reports.style_id — the style a saved report prints in (none: the
--     default).
--   • report_forms — a company workbook kept with a saved report (QF-07…),
--     with where each value goes. The file is small and kept here, with its
--     sheets as the app shows them.
--
-- Nothing is hard-deleted: removing one marks it.
-- ============================================================================

CREATE TABLE report_styles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         uuid NOT NULL REFERENCES users (id),
  name             text NOT NULL,
  spec             jsonb NOT NULL,
  logo_data_url    text,
  shared           boolean NOT NULL DEFAULT false,
  is_default       boolean NOT NULL DEFAULT false,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by_id    uuid NOT NULL REFERENCES users (id),
  updated_by_name  text NOT NULL,
  deleted_at       timestamptz,
  deleted_by_id    uuid REFERENCES users (id),
  CONSTRAINT report_styles_name_length CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT report_styles_spec_object CHECK (jsonb_typeof(spec) = 'object'),
  CONSTRAINT report_styles_logo CHECK (
    logo_data_url IS NULL OR (
      char_length(logo_data_url) <= 300000
      AND (logo_data_url LIKE 'data:image/png;base64,%' OR logo_data_url LIKE 'data:image/jpeg;base64,%')
    )
  ),
  CONSTRAINT report_styles_version CHECK (version >= 1),
  -- The company's default is everyone's to print in.
  CONSTRAINT report_styles_default_shared CHECK (NOT is_default OR shared)
);
CREATE INDEX report_styles_owner_idx ON report_styles (owner_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX report_styles_shared_idx ON report_styles (updated_at DESC) WHERE shared AND deleted_at IS NULL;
CREATE UNIQUE INDEX report_styles_one_default ON report_styles ((true)) WHERE is_default AND deleted_at IS NULL;
CREATE TRIGGER report_styles_no_delete BEFORE DELETE ON report_styles FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

CREATE TABLE report_style_versions (
  style_id         uuid NOT NULL REFERENCES report_styles (id),
  version          integer NOT NULL,
  name             text NOT NULL,
  spec             jsonb NOT NULL,
  logo_data_url    text,
  changed_by_id    uuid NOT NULL REFERENCES users (id),
  changed_by_name  text NOT NULL,
  changed_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (style_id, version)
);
CREATE TRIGGER report_style_versions_no_delete BEFORE DELETE ON report_style_versions FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

ALTER TABLE ai_reports ADD COLUMN style_id uuid REFERENCES report_styles (id);

CREATE TABLE report_forms (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id        uuid NOT NULL REFERENCES ai_reports (id),
  owner_id         uuid NOT NULL REFERENCES users (id),
  name             text NOT NULL,
  file_name        text NOT NULL,
  byte_size        integer NOT NULL,
  sha256           char(64) NOT NULL,
  file_bytes       bytea NOT NULL,
  sheets           jsonb NOT NULL,
  mapping          jsonb,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by_name  text NOT NULL,
  deleted_at       timestamptz,
  deleted_by_id    uuid REFERENCES users (id),
  CONSTRAINT report_forms_name_length CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT report_forms_size CHECK (byte_size BETWEEN 1 AND 2097152 AND octet_length(file_bytes) = byte_size),
  CONSTRAINT report_forms_sheets_array CHECK (jsonb_typeof(sheets) = 'array'),
  CONSTRAINT report_forms_mapping_object CHECK (mapping IS NULL OR jsonb_typeof(mapping) = 'object'),
  CONSTRAINT report_forms_version CHECK (version >= 1)
);
CREATE INDEX report_forms_report_idx ON report_forms (report_id, created_at) WHERE deleted_at IS NULL;
CREATE TRIGGER report_forms_no_delete BEFORE DELETE ON report_forms FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();
