-- ============================================================================
-- 0006 — Sign in with a username instead of an email; an account can be
-- removed.
--
-- The factory has no mailbox per inspector, so the email was only ever a
-- login name in disguise. Each account gets a username backfilled from the
-- part of its email before "@" (de-duplicated with a short suffix), and the
-- email column goes.
--
-- Removing an account is a soft delete: the row stays because inspections,
-- samples and audit entries reference it by id and must keep the person's
-- name, but the account leaves the Users page, cannot sign in, and frees its
-- username for someone else.
-- ============================================================================

ALTER TABLE users
  ADD COLUMN username      text,
  ADD COLUMN deleted_at    timestamptz,
  ADD COLUMN deleted_by_id uuid REFERENCES users (id);

WITH base AS (
  SELECT id,
         created_at,
         -- Letters, digits, dot, dash, underscore only; nothing leading but a letter or digit.
         regexp_replace(
           regexp_replace(lower(split_part(email, '@', 1)), '[^a-z0-9._-]', '', 'g'),
           '^[._-]+', '') AS stem
    FROM users
),
named AS (
  SELECT id,
         CASE WHEN length(stem) < 2 THEN 'user' ELSE left(stem, 40) END AS stem,
         row_number() OVER (PARTITION BY CASE WHEN length(stem) < 2 THEN 'user' ELSE left(stem, 40) END ORDER BY created_at, id) AS rn
    FROM base
)
UPDATE users u
   SET username = CASE WHEN n.rn = 1 THEN n.stem ELSE left(n.stem, 32) || '-' || left(u.id::text, 6) END
  FROM named n
 WHERE n.id = u.id;

ALTER TABLE users
  ALTER COLUMN username SET NOT NULL,
  ADD CONSTRAINT users_username_format
    CHECK (username = lower(btrim(username)) AND username ~ '^[a-z0-9][a-z0-9._-]{1,39}$');

-- A removed account releases its username.
CREATE UNIQUE INDEX users_username_key ON users (username) WHERE deleted_at IS NULL;

ALTER TABLE users DROP CONSTRAINT users_email_format;
DROP INDEX users_email_key;
ALTER TABLE users DROP COLUMN email;
