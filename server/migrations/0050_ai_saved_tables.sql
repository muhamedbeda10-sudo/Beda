-- ============================================================================
-- 0050 — the assistant's saved tables: what it keeps to build on. A table is
-- the stored result of a query over the ai views (and other saved tables),
-- computed again by the database alone on a schedule, or rows the assistant
-- wrote out (a mapping, a list of targets). Questions, reports and
-- automations read them as ai_saved.<name>, through the same reader roles as
-- the views.
--
--   • schema ai_saved holds the tables themselves, made and replaced by the
--     API (server/src/ai/savedTables.ts). The base role may use the schema;
--     each table is granted to the combination roles whose domains cover
--     what its query reads, worked out again every time it is computed, so
--     a table never shows more than its readers could select themselves.
--   • ai_saved_tables: each table's definition and how its last computation
--     went. A removed table is dropped and its row only marked removed, so
--     its name can be used again.
--   • ai_saved_table_changes: every definition made, replaced or removed, and
--     every computation the assistant or a person asked for, with where:
--     append-only.
-- ============================================================================

CREATE SCHEMA ai_saved;
REVOKE ALL ON SCHEMA ai_saved FROM PUBLIC;

DO $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA ai_saved TO %I', current_database() || '_ai_base');
END $$;

CREATE TABLE ai_saved_tables (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The table's name in schema ai_saved.
  name              text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{1,47}$'),
  title             text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  description       text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  source            text NOT NULL CHECK (source IN ('query', 'rows')),
  -- A query's table: its SELECT. Rows written out: their columns and values.
  sql               text,
  literal           jsonb,
  -- What each column holds, by name, as the assistant described it.
  column_notes      jsonb NOT NULL DEFAULT '{}'::jsonb,
  refresh           text NOT NULL CHECK (refresh IN ('never', 'hourly', 'daily')),
  -- The domains its query reads (who may read it) and the saved tables it reads, as of its last computation.
  domains           text[] NOT NULL DEFAULT '{}',
  depends_on        text[] NOT NULL DEFAULT '{}',
  version           integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- As last computed: its columns ([{name, type}]) and rows.
  columns           jsonb NOT NULL DEFAULT '[]'::jsonb,
  row_count         integer,
  refreshed_at      timestamptz,
  refresh_ms        integer,
  -- The last computation that failed (the rows before it are kept), cleared by the next that works.
  last_error        text,
  last_error_at     timestamptz,
  failures          integer NOT NULL DEFAULT 0,
  next_refresh_at   timestamptz,
  -- Taken by one computation at a time, on any instance, until then.
  refreshing_until  timestamptz,
  created_by_id     uuid NOT NULL REFERENCES users (id),
  created_by_name   text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_by_id     uuid NOT NULL REFERENCES users (id),
  updated_by_name   text NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CONSTRAINT ai_saved_tables_query CHECK ((source = 'query') = (sql IS NOT NULL)),
  CONSTRAINT ai_saved_tables_rows CHECK ((source = 'rows') = (literal IS NOT NULL)),
  CONSTRAINT ai_saved_tables_rows_kept CHECK (source = 'query' OR refresh = 'never'),
  CONSTRAINT ai_saved_tables_schedule CHECK (refresh <> 'never' OR next_refresh_at IS NULL)
);
CREATE UNIQUE INDEX ai_saved_tables_name_live ON ai_saved_tables (name) WHERE deleted_at IS NULL;
CREATE INDEX ai_saved_tables_due_idx ON ai_saved_tables (next_refresh_at) WHERE deleted_at IS NULL AND next_refresh_at IS NOT NULL;
CREATE TRIGGER ai_saved_tables_updated_at BEFORE UPDATE ON ai_saved_tables FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER ai_saved_tables_no_delete BEFORE DELETE ON ai_saved_tables FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

CREATE TABLE ai_saved_table_changes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id        uuid NOT NULL REFERENCES ai_saved_tables (id),
  version         integer NOT NULL,
  action          text NOT NULL CHECK (action IN ('create', 'replace', 'refresh', 'remove')),
  -- The definition as made or replaced (title, description, source, sql or rows, notes, refresh); none for a computation or a removal.
  definition      jsonb,
  -- How the computation went, for a create, replace or refresh.
  row_count       integer,
  columns         jsonb,
  by_id           uuid NOT NULL REFERENCES users (id),
  by_name         text NOT NULL,
  -- Made by the assistant: the answer and the tool call; on the page: none.
  conversation_id uuid REFERENCES ai_conversations (id),
  turn_id         uuid REFERENCES ai_turns (id),
  tool_use_id     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_saved_table_changes_source CHECK (
    (conversation_id IS NULL AND turn_id IS NULL AND tool_use_id IS NULL)
    OR (conversation_id IS NOT NULL AND turn_id IS NOT NULL AND tool_use_id IS NOT NULL)
  ),
  CONSTRAINT ai_saved_table_changes_definition CHECK ((action IN ('create', 'replace')) = (definition IS NOT NULL)),
  UNIQUE (conversation_id, tool_use_id)
);
CREATE INDEX ai_saved_table_changes_table_idx ON ai_saved_table_changes (table_id, created_at);
CREATE INDEX ai_saved_table_changes_turn_idx ON ai_saved_table_changes (conversation_id, turn_id) WHERE conversation_id IS NOT NULL;

CREATE FUNCTION protect_ai_saved_table_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'The saved tables'' history is append-only.' USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER ai_saved_table_changes_append_only BEFORE UPDATE OR DELETE ON ai_saved_table_changes FOR EACH ROW EXECUTE FUNCTION protect_ai_saved_table_change();
