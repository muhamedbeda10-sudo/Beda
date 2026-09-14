-- ============================================================================
-- 0016 — the History list filters in SQL (§6).
--
-- Every filter on the History screen is now applied over the whole record
-- rather than over the page already on screen, so a session that matches is
-- found wherever it sits. These indexes are what keep that answer quick as
-- the record grows: the list walks `started_at` backwards and stops at the
-- page it was asked for, and the two narrowest filters — who inspected, and
-- whether the session is still open — walk their own ordered index instead
-- of the whole table.
--
-- The machine filter already has `inspection_sessions_machine_started_idx`
-- (0013). Free text still scans, bounded by the other filters and the page.
--
-- The audit browser's filters moved into SQL for the same reason, and the log
-- is the table that grows fastest of all: its page walks (at, id) backwards,
-- and narrowing by who or by what is an ordered index of its own.
-- ============================================================================

CREATE INDEX inspection_sessions_inspector_started_idx
  ON inspection_sessions (inspector_id, started_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX inspection_sessions_status_started_idx
  ON inspection_sessions (status, started_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX audit_log_at_id_idx
  ON audit_log (at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX audit_log_user_at_idx
  ON audit_log (user_name, at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX audit_log_entity_at_idx
  ON audit_log (entity, at DESC)
  WHERE deleted_at IS NULL;
