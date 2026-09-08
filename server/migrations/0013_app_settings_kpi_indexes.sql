-- ============================================================================
-- 0013 — The quality dashboard (§15).
--   • app_settings — small named settings an administrator edits in
--     Configuration, stored as JSON: the KPI thresholds live here. One row per
--     key; the previous value is written to the audit log on change.
--   • Indexes the KPI queries lean on: samples by day, sessions by machine
--     and day, defects by disposition with their sample.
-- ============================================================================

CREATE TABLE app_settings (
  key             text PRIMARY KEY,
  value           jsonb NOT NULL,
  updated_by_id   uuid REFERENCES users (id),
  updated_by_name text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_settings_key_not_blank CHECK (btrim(key) <> '')
);

CREATE INDEX inspection_samples_created_idx ON inspection_samples (created_at) WHERE deleted_at IS NULL;
CREATE INDEX inspection_sessions_machine_started_idx ON inspection_sessions (work_center_code, started_at) WHERE deleted_at IS NULL;
CREATE INDEX defect_results_hold_idx ON defect_results (sample_id) WHERE deleted_at IS NULL AND disposition = 'Hold';
