-- ============================================================================
-- 0047 — the bell's Reports list: scheduled reports delivered are listed and
-- counted apart from the other alerts (UserNotificationCategory). Nothing
-- moves: the rows stay as they are, and the list is chosen by kind.
--
-- A person's alerts may run to thousands (a watch tells them of each case),
-- their reports to one or two a day: walking the whole list for the few
-- reports in it would read every alert. Their own index keeps that list as
-- cheap as the other; the alerts keep user_notifications_user_idx, and the
-- unread counts user_notifications_unread_idx.
-- ============================================================================

CREATE INDEX user_notifications_reports_idx ON user_notifications (user_id, created_at DESC, id DESC) WHERE kind = 'automation-report';
