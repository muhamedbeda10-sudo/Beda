-- ============================================================================
-- 0029 — a profile photo per person, shown in the circle at the top right.
--
-- Each person sets or removes their own; it is not a quality record, so it
-- is replaced in place and removed outright rather than soft-deleted. The
-- photo is a small square JPEG (cropped and compressed on the device) kept as
-- a data URL, so it travels with the person's own profile request and needs
-- no storage driver or signed URL. Its size is bounded here as well as in the
-- API. Kept apart from `users` so the many queries that list people never
-- carry it.
-- ============================================================================

CREATE TABLE user_avatars (
  user_id     uuid PRIMARY KEY REFERENCES users(id),
  data_url    text NOT NULL CHECK (data_url LIKE 'data:image/jpeg;base64,%' AND length(data_url) <= 65536),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
