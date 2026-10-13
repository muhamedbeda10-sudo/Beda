-- ============================================================================
-- 0044 — tasks: work one person sends to others, followed to the end.
--
--   • tasks — what is to be done: a title, what it is about, a priority and
--     perhaps a deadline, from someone given the AI assistant (on its Tasks
--     page, or drafted by the assistant and sent by them). Open until every
--     person on it is confirmed done (closed), or its sender withdraws it
--     (cancelled). Numbered T-1, T-2… for people to name them by.
--   • task_assignees — each person it went to, with where they are on it:
--     to do, in progress, done (theirs to say), then confirmed (the sender's
--     to say, once satisfied: it leaves their list). Until then the sender
--     may send it back ("not yet"): in progress again, still theirs to do.
--   • task_messages — the task's thread, in order: what people wrote (with
--     photos: task_message_images, of the photo store) and each change of
--     state, by whom, with a note when one was given.
--   • user_notifications — the bell's alerts gain the tasks' kinds, and the
--     task they are about.
-- Nothing of a task is ever removed: a withdrawn one stays on record.
-- ============================================================================

CREATE TABLE tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number          integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  title           text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  description     text NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000),
  priority        text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high', 'urgent')),
  due_at          timestamptz,
  created_by_id   uuid NOT NULL REFERENCES users (id),
  created_by_name text NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  closed_at       timestamptz,
  -- Drafted by the assistant in this conversation, and sent by its person.
  conversation_id uuid REFERENCES ai_conversations (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tasks_closed_when_not_open CHECK ((status = 'open') = (closed_at IS NULL))
);
CREATE INDEX tasks_creator_idx ON tasks (created_by_id, status, created_at DESC);
CREATE TRIGGER tasks_updated_at BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tasks_no_delete BEFORE DELETE ON tasks FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

CREATE TABLE task_assignees (
  task_id      uuid NOT NULL REFERENCES tasks (id),
  user_id      uuid NOT NULL REFERENCES users (id),
  user_name    text NOT NULL,
  state        text NOT NULL DEFAULT 'todo' CHECK (state IN ('todo', 'in_progress', 'done', 'confirmed')),
  state_at     timestamptz NOT NULL DEFAULT now(),
  done_at      timestamptz,
  confirmed_at timestamptz,
  -- When they first opened it: their sender sees it was read.
  seen_at      timestamptz,
  PRIMARY KEY (task_id, user_id),
  CONSTRAINT task_assignees_done_at CHECK ((state IN ('done', 'confirmed')) = (done_at IS NOT NULL)),
  CONSTRAINT task_assignees_confirmed_at CHECK ((state = 'confirmed') = (confirmed_at IS NOT NULL))
);
-- A person's list: the tasks given to them, by where they are on them.
CREATE INDEX task_assignees_user_idx ON task_assignees (user_id, state);
CREATE TRIGGER task_assignees_no_delete BEFORE DELETE ON task_assignees FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

CREATE TABLE task_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The thread's order: several messages written in one transaction share its time.
  seq         bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  task_id     uuid NOT NULL REFERENCES tasks (id),
  author_id   uuid NOT NULL REFERENCES users (id),
  author_name text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('comment', 'event')),
  body        text NOT NULL DEFAULT '' CHECK (char_length(body) <= 4000),
  -- What happened, for an event; and to whose part of it (a start, a done, a confirmation, a sending back).
  event       text CHECK (event IN ('created', 'started', 'done', 'undone', 'confirmed', 'reopened', 'edited', 'cancelled', 'closed')),
  subject_id  uuid REFERENCES users (id),
  subject_name text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_messages_event_kind CHECK ((kind = 'event') = (event IS NOT NULL))
);
CREATE INDEX task_messages_task_idx ON task_messages (task_id, seq);
CREATE TRIGGER task_messages_no_delete BEFORE DELETE ON task_messages FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

CREATE TABLE task_message_images (
  message_id uuid NOT NULL REFERENCES task_messages (id),
  image_id   uuid NOT NULL REFERENCES images (id),
  position   smallint NOT NULL CHECK (position BETWEEN 0 AND 5),
  PRIMARY KEY (message_id, image_id),
  UNIQUE (message_id, position)
);
CREATE TRIGGER task_message_images_no_delete BEFORE DELETE ON task_message_images FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

-- ---- The bell's alerts about tasks ------------------------------------------------------

ALTER TABLE user_notifications ADD COLUMN task_id uuid REFERENCES tasks (id);
ALTER TABLE user_notifications DROP CONSTRAINT user_notifications_kind;
ALTER TABLE user_notifications ADD CONSTRAINT user_notifications_kind CHECK (kind IN (
  'automation-case', 'automation-digest', 'automation-report', 'automation-stopped',
  'follow-up-assigned', 'follow-up-overdue', 'follow-up-updated',
  'task-assigned', 'task-updated', 'task-done', 'task-reopened'));
