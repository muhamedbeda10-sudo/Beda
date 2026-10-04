-- ============================================================================
-- 0026 — the order sheet synced from the factory's Access database (§7.7).
--
-- A small agent on a factory PC reads the Access table and sends it here with
-- an integration key: a long random secret, kept only as its SHA-256 hash and
-- shown to the administrator once. Every sync is a run, with what it found
-- and did; an administrator can ask for one now, and the agent picks the
-- request up on its next check. An order line the run did not see is marked
-- deleted (retired) only when the run read the whole table cleanly.
-- ============================================================================

CREATE TABLE integration_keys (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  purpose          text NOT NULL,
  -- The first characters, to tell keys apart on screen; never enough to use.
  prefix           text NOT NULL,
  key_hash         text NOT NULL,
  created_by_id    uuid NOT NULL REFERENCES users (id),
  created_by_name  text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_used_at     timestamptz,
  revoked_at       timestamptz,
  revoked_by_id    uuid REFERENCES users (id),
  CONSTRAINT integration_keys_name_shape CHECK (btrim(name) <> '' AND length(name) <= 80),
  CONSTRAINT integration_keys_purpose CHECK (purpose IN ('orders-sync'))
);
CREATE UNIQUE INDEX integration_keys_hash_key ON integration_keys (key_hash);
CREATE TRIGGER integration_keys_no_delete BEFORE DELETE ON integration_keys FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

CREATE TABLE order_sync_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id           uuid NOT NULL REFERENCES integration_keys (id),
  -- What the agent says it read: the PC and the table.
  source           text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'running',
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  rows_received    integer NOT NULL DEFAULT 0,
  rows_expected    integer,
  inserted         integer NOT NULL DEFAULT 0,
  updated          integer NOT NULL DEFAULT 0,
  invalid          integer NOT NULL DEFAULT 0,
  retired          integer NOT NULL DEFAULT 0,
  unknown_columns  text[] NOT NULL DEFAULT '{}',
  -- The first rows that could not be read, with why.
  errors           jsonb NOT NULL DEFAULT '[]',
  message          text,
  CONSTRAINT order_sync_runs_status CHECK (status IN ('running', 'success', 'warning', 'failed'))
);
CREATE INDEX order_sync_runs_started_idx ON order_sync_runs (started_at DESC);
CREATE TRIGGER order_sync_runs_no_delete BEFORE DELETE ON order_sync_runs FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

CREATE TABLE order_sync_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_at       timestamptz NOT NULL DEFAULT now(),
  requested_by_id    uuid NOT NULL REFERENCES users (id),
  requested_by_name  text NOT NULL,
  -- The run that answered it; NULL while it waits.
  run_id             uuid REFERENCES order_sync_runs (id)
);
CREATE INDEX order_sync_requests_waiting_idx ON order_sync_requests (requested_at) WHERE run_id IS NULL;
CREATE TRIGGER order_sync_requests_no_delete BEFORE DELETE ON order_sync_requests FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

-- The last sync run that saw the line: a run retires the lines it did not see.
ALTER TABLE production_orders ADD COLUMN last_sync_run_id uuid REFERENCES order_sync_runs (id);
