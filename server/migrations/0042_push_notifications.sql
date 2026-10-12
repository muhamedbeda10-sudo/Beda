-- ============================================================================
-- 0042 — notifications on the phone or computer, with the app closed (Web
-- Push). A person turns them on for a device; the server then pushes what
-- reaches them in the app: the bell's alerts, chat messages, and notices aimed
-- at everyone, at roles or at named people.
--   • push_subscriptions — one per device (its push endpoint, unique), for the
--     account that turned it on. Signing out removes the device's row; one the
--     push service says is gone (404 / 410) is removed when it answers so.
--   • push_events — what happened, for the push dispatcher (push/dispatcher.ts)
--     to work out who is told and send: a row per new bell alert and per new
--     chat message, written by triggers, so no way of writing one is missed.
--     The dispatcher takes and removes them; who is told is decided there, by
--     the same rules the app shows them by. Only kept while some device is
--     subscribed: with none, nothing is queued.
--   • notices.push_sent_at — a notice is pushed once, on the first day it is
--     valid. Notices made before this are marked sent, so none of them is
--     pushed now.
-- ============================================================================

CREATE TABLE push_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id),
  endpoint      text NOT NULL UNIQUE,
  p256dh        text NOT NULL,
  auth          text NOT NULL,
  user_agent    text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  last_sent_at  timestamptz,
  CONSTRAINT push_subscriptions_endpoint_https CHECK (endpoint LIKE 'https://%'),
  CONSTRAINT push_subscriptions_keys_not_blank CHECK (btrim(p256dh) <> '' AND btrim(auth) <> '')
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);

CREATE TABLE push_events (
  id         bigserial PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('alert', 'chat')),
  ref_id     uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION queue_push_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM push_subscriptions) THEN
    INSERT INTO push_events (kind, ref_id) VALUES (TG_ARGV[0], NEW.id);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER user_notifications_push AFTER INSERT ON user_notifications FOR EACH ROW EXECUTE FUNCTION queue_push_event('alert');
CREATE TRIGGER chat_messages_push AFTER INSERT ON chat_messages FOR EACH ROW EXECUTE FUNCTION queue_push_event('chat');

ALTER TABLE notices ADD COLUMN push_sent_at timestamptz;
UPDATE notices SET push_sent_at = now();
CREATE INDEX notices_push_due_idx ON notices (valid_from) WHERE push_sent_at IS NULL AND deleted_at IS NULL AND withdrawn_at IS NULL;
