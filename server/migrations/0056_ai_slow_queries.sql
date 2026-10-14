-- ============================================================================
-- 0056 — the assistant's slow queries: every query it ran that took
-- SLOW_QUERY_MS (10 s) or more, kept so the owner can see which questions are
-- heavy and the views or indexes behind them can be fixed
-- (server/src/ai/slowQueries.ts). Where it ran (a chat, a report, a scheduled
-- report, an Excel file, a saved table, an export, an automation), who it ran
-- for, its SQL, how long it took and how it ended. Kept 90 days.
-- ============================================================================

CREATE TABLE ai_slow_queries (
  id              bigserial PRIMARY KEY,
  at              timestamptz NOT NULL DEFAULT now(),
  source          text NOT NULL CHECK (source IN ('chat', 'report', 'scheduled-report', 'excel', 'saved-table', 'export', 'automation', 'other')),
  user_id         uuid REFERENCES users(id),
  conversation_id uuid,
  purpose         text CHECK (char_length(purpose) <= 500),
  sql             text NOT NULL CHECK (char_length(sql) <= 100000),
  duration_ms     integer NOT NULL CHECK (duration_ms >= 0),
  outcome         text NOT NULL CHECK (outcome IN ('ok', 'timeout', 'error')),
  error           text CHECK (char_length(error) <= 1000),
  row_count       integer CHECK (row_count >= 0)
);

CREATE INDEX ai_slow_queries_at ON ai_slow_queries (at DESC, id DESC);
