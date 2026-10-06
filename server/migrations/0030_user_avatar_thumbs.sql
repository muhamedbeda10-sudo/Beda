-- ============================================================================
-- 0030 — a small copy of each profile photo, for the circles in the chat.
--
-- The chat shows many people at once (the conversation list, the members, the
-- people to start a chat with, the messages of a group), each in a 32–44 px
-- circle. A 64 px copy, made on the device with the photo, keeps those lists
-- light; the full photo stays for the person's own account panel. A photo set
-- before this has no small copy: the API sends the full one in its place.
-- ============================================================================

ALTER TABLE user_avatars
  ADD COLUMN thumb_data_url text CHECK (thumb_data_url IS NULL OR (thumb_data_url LIKE 'data:image/jpeg;base64,%' AND length(thumb_data_url) <= 12288));
