-- ============================================================================
-- 0017 — What's new (§18).
--
-- The release notes ship with the code. All the database keeps is how far
-- each person has read: the id of the newest note they dismissed, so the
-- prompt shows once per person and not once per device.
-- ============================================================================

ALTER TABLE users ADD COLUMN last_seen_release_id text;
