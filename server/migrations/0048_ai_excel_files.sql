-- ============================================================================
-- 0048 — Excel files the assistant makes, and the log of every request for
-- one. The assistant lays a file out at the person's word: its sheets, each a
-- read-only query over the ai.* views with its columns (order, headings, how
-- each is written), a totals row, a title and notes. The server runs the
-- queries as the person's domains read, builds the workbook and keeps it for
-- 30 days; the card's link downloads that very file. The assistant never sees
-- its rows: only its columns and how many rows each sheet holds.
--
-- Who may have files made is the owner's to say, person by person, as for
-- automations: ai_access.excel (the owner always may).
--
-- Every request is kept, made or refused: who asked (and in which role), what
-- the assistant sent (`request`, its parameters as sent), and why it was
-- refused. The tokens of the answer that asked are in ai_usage, by its turn:
-- ai_excel_log puts them together. Every download is kept too.
-- ============================================================================

ALTER TABLE ai_access ADD COLUMN excel boolean NOT NULL DEFAULT false;

CREATE TABLE ai_excel_files (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES ai_conversations (id),
  turn_id         uuid NOT NULL REFERENCES ai_turns (id),
  tool_use_id     text NOT NULL,
  user_id         uuid NOT NULL REFERENCES users (id),
  -- The person as they were when they asked: their name, and the role that decided whether they may export.
  user_name       text NOT NULL,
  user_role       text NOT NULL,
  status          text NOT NULL CHECK (status IN ('made', 'refused', 'failed')),
  -- What the assistant sent, as it sent it.
  request         jsonb NOT NULL,
  -- Why it was refused or failed: what the assistant was told.
  problems        text,
  -- A file made: its name, its layout as checked (shared/aiExcel.ts AiExcelSpec), its card, its rows by sheet and its bytes.
  file_name       text CHECK (file_name IS NULL OR length(btrim(file_name)) BETWEEN 1 AND 80),
  spec            json,
  card            json,
  sheet_rows      integer[],
  byte_size       integer CHECK (byte_size IS NULL OR byte_size > 0),
  sha256          text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  storage_key     text UNIQUE,
  expires_at      timestamptz,
  -- When its bytes were taken out of storage, its time over.
  removed_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, tool_use_id),
  CONSTRAINT ai_excel_files_made CHECK (
    status <> 'made'
    OR (file_name IS NOT NULL AND spec IS NOT NULL AND card IS NOT NULL AND sheet_rows IS NOT NULL AND byte_size IS NOT NULL
        AND sha256 IS NOT NULL AND storage_key IS NOT NULL AND expires_at IS NOT NULL)
  ),
  CONSTRAINT ai_excel_files_why CHECK (status = 'made' OR problems IS NOT NULL),
  CONSTRAINT ai_excel_files_removed CHECK (removed_at IS NULL OR status = 'made')
);
CREATE INDEX ai_excel_files_turn_idx ON ai_excel_files (conversation_id, turn_id);
CREATE INDEX ai_excel_files_user_idx ON ai_excel_files (user_id, created_at);
CREATE INDEX ai_excel_files_expiry_idx ON ai_excel_files (expires_at) WHERE status = 'made' AND removed_at IS NULL;
CREATE TRIGGER ai_excel_files_no_delete BEFORE DELETE ON ai_excel_files FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

-- A request, once logged, stays as it was: only the removal of a file's bytes is written later, once.
CREATE FUNCTION ai_excel_files_keep() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'removed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'removed_at') OR OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'ai_excel_files is a log: only removed_at is set, once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_excel_files_keep BEFORE UPDATE ON ai_excel_files FOR EACH ROW EXECUTE FUNCTION ai_excel_files_keep();

-- Every download of a file: who, and when.
CREATE TABLE ai_excel_downloads (
  id         bigserial PRIMARY KEY,
  file_id    uuid NOT NULL REFERENCES ai_excel_files (id),
  user_id    uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_excel_downloads_file_idx ON ai_excel_downloads (file_id, created_at);
CREATE FUNCTION ai_excel_downloads_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ai_excel_downloads is append-only';
END $$;
CREATE TRIGGER ai_excel_downloads_append_only BEFORE UPDATE OR DELETE ON ai_excel_downloads FOR EACH ROW EXECUTE FUNCTION ai_excel_downloads_append_only();

-- The log as it is read: each request with the tokens of the answer that asked (all of its calls to the model; an
-- answer that asked for two files shows its tokens on both) and how often the file was downloaded.
CREATE VIEW ai_excel_log AS
SELECT f.id,
       f.created_at,
       f.user_id,
       f.user_name,
       f.user_role,
       f.status,
       f.file_name,
       f.request,
       f.problems,
       f.sheet_rows,
       f.byte_size,
       f.expires_at,
       f.removed_at,
       f.conversation_id,
       f.turn_id,
       COALESCE(u.input_tokens, 0)                                         AS input_tokens,
       COALESCE(u.output_tokens, 0)                                        AS output_tokens,
       COALESCE(u.cache_read_tokens, 0)                                    AS cache_read_tokens,
       COALESCE(u.cache_write_tokens, 0)                                   AS cache_write_tokens,
       COALESCE(u.cost_usd, 0)                                             AS cost_usd,
       (SELECT count(*) FROM ai_excel_downloads d WHERE d.file_id = f.id)  AS downloads
  FROM ai_excel_files f
  -- Read by the turn's index, row by row: the log never sums the whole of ai_usage.
  LEFT JOIN LATERAL (
    SELECT sum(a.input_tokens)::bigint                                    AS input_tokens,
           sum(a.output_tokens)::bigint                                   AS output_tokens,
           sum(a.cache_read_tokens)::bigint                               AS cache_read_tokens,
           sum(a.cache_write_5m_tokens + a.cache_write_1h_tokens)::bigint AS cache_write_tokens,
           sum(a.cost_usd)                                                AS cost_usd
      FROM ai_usage a
     WHERE a.turn_id = f.turn_id
  ) u ON true;
