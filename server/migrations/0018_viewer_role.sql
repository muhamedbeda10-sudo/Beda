-- ============================================================================
-- 0018 — the viewer role (§14).
--
-- A viewer signs in to read: the board, History and the dashboard. They
-- record nothing, correct nothing, delete nothing, and are outside the chat
-- and the notices. What they may do is decided by the shared capability
-- table; the database only needs to know the role exists.
-- ============================================================================

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'viewer';
