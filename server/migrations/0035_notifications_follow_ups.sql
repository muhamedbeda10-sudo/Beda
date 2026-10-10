-- ============================================================================
-- 0035 — what automations deliver (§21): the bell's own alerts, the chat's
-- system sender, and follow-ups.
--   • users.is_system — an account the app writes with and nobody signs in
--     as. Exactly one: "QC Automations", the sender of automated chat
--     messages. Its password is no hash at all (no check can match it) and
--     the API refuses it at sign-in all the same; it is left out of every
--     list and count of people.
--   • user_notifications — alerts for one person each (a new case, a report
--     delivered, a follow-up assigned or overdue). Not notices: those are an
--     administrator's broadcasts with acknowledgement, and automation volume
--     would bury them. Read or not, nothing more; rows older than 90 days are
--     removed outright by the API, as they are no record of anything.
--   • follow_ups — one case an automation asks a person to look at, with a
--     deadline. Open until closed with a note. A follow-up linked to a session
--     marks it "Needs review" while it is not done — derived, never stored on
--     the session.
--   • follow_up_events — a follow-up's timeline: it was opened, comments,
--     every change of status, assignee or deadline, and its escalation.
--
-- automation_id and delivery_id are plain uuids here: the automations and
-- their deliveries arrive with 0036, which adds the foreign keys.
-- ============================================================================

-- ---- The system sender -------------------------------------------------------------

ALTER TABLE users ADD COLUMN is_system boolean NOT NULL DEFAULT false;

-- One system account, ever.
CREATE UNIQUE INDEX users_one_system ON users ((is_system)) WHERE is_system;

-- Its username is "qc-automations" unless a person already signs in with that
-- name, who keeps it. The password is not in the scrypt format the API checks,
-- so no password whatever can match it.
INSERT INTO users (username, name, role, password_hash, is_active, is_system)
VALUES (
  CASE WHEN EXISTS (SELECT 1 FROM users WHERE username = 'qc-automations' AND deleted_at IS NULL)
       THEN 'qc-automations-' || left(md5(random()::text || clock_timestamp()::text), 6)
       ELSE 'qc-automations' END,
  'QC Automations',
  'viewer',
  '!system:' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  true,
  true
);

-- A person never becomes the system account, nor the system account a person.
CREATE FUNCTION protect_system_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Whether an account is the system sender is fixed.' USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER users_system_fixed BEFORE UPDATE OF is_system ON users
  FOR EACH ROW WHEN (NEW.is_system IS DISTINCT FROM OLD.is_system) EXECUTE FUNCTION protect_system_user();

-- The assistant's list of accounts leaves it out too: it is nobody. Same
-- columns as 0031, so its comments stay as they are.
CREATE OR REPLACE VIEW ai.users AS
SELECT u.id          AS user_id,
       u.name,
       u.role::text  AS role,
       u.is_active,
       u.created_at,
       u.last_login_at
  FROM users u
 WHERE u.deleted_at IS NULL AND NOT u.is_system;

-- ---- Follow-ups --------------------------------------------------------------------

CREATE TABLE follow_ups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id   uuid,
  -- The automation's name when it opened this one (lists show its current name
  -- while the automation exists), and the person who set it up.
  automation_name text NOT NULL,
  creator_id      uuid REFERENCES users (id),
  -- The case: the automation's key for it, fired once.
  case_key        text NOT NULL,
  title           text NOT NULL,
  body            text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done')),
  assignee_id     uuid REFERENCES users (id),
  due_at          timestamptz NOT NULL,
  -- Told the assignee and the creator it is overdue; cleared when the deadline moves on.
  escalated_at    timestamptz,
  session_id      uuid REFERENCES inspection_sessions (id),
  sample_id       uuid REFERENCES inspection_samples (id),
  order_number    text,
  -- The case's row as the automation's query returned it.
  case_columns    text[] NOT NULL DEFAULT '{}',
  case_row        jsonb NOT NULL DEFAULT '[]',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  closed_by_id    uuid REFERENCES users (id),
  closed_by_name  text,
  closing_note    text,
  CONSTRAINT follow_ups_title_not_blank CHECK (btrim(title) <> ''),
  CONSTRAINT follow_ups_case_row_array CHECK (jsonb_typeof(case_row) = 'array'),
  -- Done means closed, with who closed it and why; anything else is not closed.
  CONSTRAINT follow_ups_closed CHECK (
    (status = 'done' AND closed_at IS NOT NULL AND closed_by_name IS NOT NULL AND btrim(COALESCE(closing_note, '')) <> '')
    OR (status <> 'done' AND closed_at IS NULL)
  ),
  -- One follow-up per case of an automation.
  CONSTRAINT follow_ups_case_key UNIQUE (automation_id, case_key)
);
-- History's "Needs review": the open follow-ups of each listed session, counted per row.
CREATE INDEX follow_ups_session_open_idx ON follow_ups (session_id) WHERE status <> 'done';
CREATE INDEX follow_ups_assignee_idx ON follow_ups (assignee_id, status);
CREATE INDEX follow_ups_creator_idx ON follow_ups (creator_id);
-- What the engine escalates: not done, past the deadline, not yet told.
CREATE INDEX follow_ups_overdue_idx ON follow_ups (due_at) WHERE status <> 'done' AND escalated_at IS NULL;
CREATE TRIGGER follow_ups_updated_at BEFORE UPDATE ON follow_ups FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- Closed, never removed: what was asked and how it was answered stays.
CREATE TRIGGER follow_ups_no_delete BEFORE DELETE ON follow_ups FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

CREATE TABLE follow_up_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  follow_up_id uuid NOT NULL REFERENCES follow_ups (id),
  kind         text NOT NULL CHECK (kind IN ('created', 'comment', 'status', 'assignee', 'due', 'escalated')),
  author_id    uuid REFERENCES users (id),
  author_name  text NOT NULL,
  body         text NOT NULL,
  -- The moment itself, not the transaction's: one change writes several events, in order.
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX follow_up_events_follow_up_idx ON follow_up_events (follow_up_id, created_at, id);
CREATE TRIGGER follow_up_events_no_delete BEFORE DELETE ON follow_up_events FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

-- ---- The bell's alerts -------------------------------------------------------------

CREATE TABLE user_notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id),
  kind          text NOT NULL,
  severity      text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  title         text NOT NULL,
  body          text NOT NULL DEFAULT '',
  -- A path in the app (never another site): what opening it navigates to.
  link          text,
  automation_id uuid,
  follow_up_id  uuid REFERENCES follow_ups (id),
  delivery_id   uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  read_at       timestamptz,
  CONSTRAINT user_notifications_kind CHECK (kind IN (
    'automation-case', 'automation-digest', 'automation-report', 'automation-stopped',
    'follow-up-assigned', 'follow-up-overdue', 'follow-up-updated')),
  CONSTRAINT user_notifications_title_not_blank CHECK (btrim(title) <> ''),
  CONSTRAINT user_notifications_link_in_app CHECK (link IS NULL OR (link LIKE '/%' AND link NOT LIKE '//%' AND position(E'\\' IN link) = 0))
);
-- A person's list, newest first, walked back by (created_at, id); and their unread count.
CREATE INDEX user_notifications_user_idx ON user_notifications (user_id, created_at DESC, id DESC);
CREATE INDEX user_notifications_unread_idx ON user_notifications (user_id) WHERE read_at IS NULL;
-- The daily removal of old ones.
CREATE INDEX user_notifications_created_idx ON user_notifications (created_at);
