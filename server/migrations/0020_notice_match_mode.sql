-- ============================================================================
-- 0020 — how a notice's targets combine (§16).
--
-- `all` (the rule so far): values of one kind are alternatives and the
-- kinds all have to hold. `any`: one target of any kind is enough.
-- ============================================================================

ALTER TABLE notices ADD COLUMN match_mode text NOT NULL DEFAULT 'all' CHECK (match_mode IN ('all', 'any'));
