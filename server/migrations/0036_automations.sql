-- ============================================================================
-- 0036 — automations (§21). A person describes in the assistant's chat what
-- to keep an eye on, or what report to send; the assistant writes it down as
-- a proposal, and nothing runs until a person presses Activate.
--   • ai_access.automations — the owner lets a person create automations
--     (the owner may, always).
--   • ai_automation_proposals — what the assistant proposed in an answer,
--     checked and tried once, until it is activated or discarded. The
--     answer's card shows it in its current state.
--   • ai_automations — an activated watch or scheduled report: its definition,
--     its state, and when it runs next. The engine takes a due one under a
--     lease (running_until), so several instances never run it twice.
--   • ai_automation_runs — every run: when, what it found, whom it told.
--   • ai_automation_hits — the cases a watch has seen: each fires once.
--   • ai_report_deliveries (+ recipients) — a scheduled report as it was
--     delivered, shown to the people it went to.
--   • ai_usage.automation_id — a report's summary is a call to the model,
--     counted against its creator and shown by automation on the owner's page.
--   • Foreign keys from 0035's follow-ups and bell notifications to the
--     automations and deliveries they came from.
--   • ai.audit_log leaves the automations' own audit entries out, as it does
--     the assistant's other bookkeeping.
-- An automation never changes the factory's record: these tables hold the
-- automations' own state, and none of them is granted to the reader roles.
-- ============================================================================

-- ---- Who may create them -----------------------------------------------------------

ALTER TABLE ai_access ADD COLUMN automations boolean NOT NULL DEFAULT false;

-- ---- Proposals ---------------------------------------------------------------------

CREATE TABLE ai_automation_proposals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The person who asked: only they may activate it.
  user_id         uuid NOT NULL REFERENCES users (id),
  conversation_id uuid NOT NULL REFERENCES ai_conversations (id),
  turn_id         uuid NOT NULL REFERENCES ai_turns (id),
  -- The propose_automation call it answers, in its answer.
  tool_use_id     text NOT NULL,
  -- The draft passed the checks; when not, `error` says why (the assistant was told too).
  ok              boolean NOT NULL,
  error           text,
  -- AutomationDraft as checked; null when the call's input could not be read at all.
  draft           json,
  -- AutomationBacktest: the draft run once.
  backtest        json,
  state           text NOT NULL DEFAULT 'proposed',
  automation_id   uuid,
  decided_by_id   uuid REFERENCES users (id),
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_automation_proposals_state CHECK (state IN ('proposed', 'activated', 'discarded')),
  CONSTRAINT ai_automation_proposals_outcome CHECK (CASE WHEN ok THEN draft IS NOT NULL AND error IS NULL ELSE error IS NOT NULL END),
  -- Only an accepted draft can be decided on; an activated one names what it became.
  CONSTRAINT ai_automation_proposals_decided CHECK (ok OR state = 'proposed'),
  CONSTRAINT ai_automation_proposals_activated CHECK ((state = 'activated') = (automation_id IS NOT NULL)),
  CONSTRAINT ai_automation_proposals_call UNIQUE (conversation_id, tool_use_id)
);
CREATE INDEX ai_automation_proposals_turn_idx ON ai_automation_proposals (turn_id);
CREATE INDEX ai_automation_proposals_user_idx ON ai_automation_proposals (user_id, created_at DESC);
CREATE TRIGGER ai_automation_proposals_updated_at BEFORE UPDATE ON ai_automation_proposals FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER ai_automation_proposals_no_delete BEFORE DELETE ON ai_automation_proposals FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

-- ---- Automations -------------------------------------------------------------------

CREATE TABLE ai_automations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Whose data domains it runs with, as they are at each run (like their chat).
  creator_id           uuid NOT NULL REFERENCES users (id),
  -- The proposal it was activated from: the latest, when a later one changed it.
  proposal_id          uuid REFERENCES ai_automation_proposals (id),
  conversation_id      uuid REFERENCES ai_conversations (id),
  kind                 text NOT NULL,
  name                 text NOT NULL,
  description          text NOT NULL,
  language             text NOT NULL,
  -- AutomationWatchSpec (a watch) or AutomationScheduleSpec (a report): exactly one.
  watch                json,
  schedule             json,
  -- AutomationRecipient[], AutomationChannels, AutomationActions.
  recipients           json NOT NULL,
  channels             json NOT NULL,
  actions              json NOT NULL,
  -- A watch: the columns its query returned when last checked or run, which recipients and templates may name.
  result_columns       json,
  -- On, paused by a person, or stopped by the engine after failing runs.
  status               text NOT NULL DEFAULT 'active',
  status_note          text,
  -- Why it last could not run (its creator's account or access); cleared once it runs again.
  blocked_reason       text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  -- A watch: when it runs next. A report: the factory-time slot it runs at next. Null while paused or failed.
  next_run_at          timestamptz,
  -- A run is in flight until then (the lease); a run that outlives it was lost with its instance.
  running_until        timestamptz,
  -- Not looked at again before then, after its creator could not run it.
  retry_at             timestamptz,
  last_run_at          timestamptz,
  last_run_ok          boolean,
  -- "Run now" at most once a minute.
  last_manual_run_at   timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by_id        uuid REFERENCES users (id),
  updated_by_name      text,
  deleted_at           timestamptz,
  CONSTRAINT ai_automations_kind CHECK (kind IN ('watch', 'report')),
  CONSTRAINT ai_automations_spec CHECK (CASE kind WHEN 'watch' THEN watch IS NOT NULL AND schedule IS NULL ELSE schedule IS NOT NULL AND watch IS NULL END),
  CONSTRAINT ai_automations_language CHECK (language IN ('ar', 'en')),
  CONSTRAINT ai_automations_status CHECK (status IN ('active', 'paused', 'failed')),
  CONSTRAINT ai_automations_blocked CHECK (blocked_reason IS NULL OR blocked_reason IN ('creator-inactive', 'no-access', 'no-permission', 'unavailable')),
  CONSTRAINT ai_automations_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT ai_automations_failures CHECK (consecutive_failures >= 0)
);
-- What the engine looks for on every tick.
CREATE INDEX ai_automations_due_idx ON ai_automations (next_run_at) WHERE deleted_at IS NULL AND status = 'active';
CREATE INDEX ai_automations_creator_idx ON ai_automations (creator_id, created_at DESC) WHERE deleted_at IS NULL;
-- The engine's own bookkeeping (a lease taken, a run stamped) is not a change anyone made.
CREATE TRIGGER ai_automations_updated_at BEFORE UPDATE ON ai_automations FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name
        OR OLD.description IS DISTINCT FROM NEW.description
        OR OLD.watch::text IS DISTINCT FROM NEW.watch::text
        OR OLD.schedule::text IS DISTINCT FROM NEW.schedule::text
        OR OLD.recipients::text IS DISTINCT FROM NEW.recipients::text
        OR OLD.channels::text IS DISTINCT FROM NEW.channels::text
        OR OLD.actions::text IS DISTINCT FROM NEW.actions::text
        OR OLD.status IS DISTINCT FROM NEW.status
        OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER ai_automations_no_delete BEFORE DELETE ON ai_automations FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

ALTER TABLE ai_automation_proposals
  ADD CONSTRAINT ai_automation_proposals_automation_fk FOREIGN KEY (automation_id) REFERENCES ai_automations (id);

-- ---- Runs and the cases they saw ---------------------------------------------------

CREATE TABLE ai_automation_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id  uuid NOT NULL REFERENCES ai_automations (id),
  trigger        text NOT NULL,
  started_at     timestamptz NOT NULL,
  finished_at    timestamptz,
  -- Null while it runs.
  ok             boolean,
  error          text,
  ms             integer,
  -- A watch: rows its query returned, and cases seen for the first time.
  matched        integer,
  fired          integer,
  -- Bell notifications and chat messages written, one per person each.
  notified       integer,
  follow_ups     integer,
  -- Cases told one by one, which the daily limit counts; the rest went out in a digest.
  cases_notified integer NOT NULL DEFAULT 0,
  digest         boolean NOT NULL DEFAULT false,
  note           text,
  delivery_id    uuid,
  CONSTRAINT ai_automation_runs_trigger CHECK (trigger IN ('schedule', 'manual')),
  CONSTRAINT ai_automation_runs_finished CHECK ((finished_at IS NULL) = (ok IS NULL))
);
CREATE INDEX ai_automation_runs_automation_idx ON ai_automation_runs (automation_id, started_at DESC, id DESC);

CREATE TABLE ai_automation_hits (
  automation_id uuid NOT NULL REFERENCES ai_automations (id),
  -- The case's key column, as text: one key, one case, fired once.
  case_key      text NOT NULL,
  -- The run that saw it first; null for a case already matching when the watch was activated (recorded, not told).
  run_id        uuid REFERENCES ai_automation_runs (id),
  first_seen_at timestamptz NOT NULL,
  PRIMARY KEY (automation_id, case_key)
);

-- ---- Scheduled reports, as delivered ----------------------------------------------

CREATE TABLE ai_report_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id   uuid NOT NULL REFERENCES ai_automations (id),
  run_id          uuid NOT NULL REFERENCES ai_automation_runs (id),
  -- The automation's name as it was when delivered.
  automation_name text NOT NULL,
  language        text NOT NULL,
  ran_at          timestamptz NOT NULL,
  -- The days its sections covered ({ from, to, label }), or null: they take no period.
  period          json,
  summary         text,
  -- Why there is no summary when one was asked for (never an amount).
  summary_note    text,
  -- AiReportSectionRun[], each with up to AUTOMATION_DELIVERY_MAX_ROWS rows.
  sections        json NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_report_deliveries_sections CHECK (json_typeof(sections) = 'array')
);
CREATE INDEX ai_report_deliveries_automation_idx ON ai_report_deliveries (automation_id, ran_at DESC);
CREATE TRIGGER ai_report_deliveries_no_delete BEFORE DELETE ON ai_report_deliveries FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

-- Who a delivery went to: they, its creator and the owner may open it.
CREATE TABLE ai_report_delivery_recipients (
  delivery_id uuid NOT NULL REFERENCES ai_report_deliveries (id),
  user_id     uuid NOT NULL REFERENCES users (id),
  PRIMARY KEY (delivery_id, user_id)
);
CREATE INDEX ai_report_delivery_recipients_user_idx ON ai_report_delivery_recipients (user_id);

ALTER TABLE ai_automation_runs
  ADD CONSTRAINT ai_automation_runs_delivery_fk FOREIGN KEY (delivery_id) REFERENCES ai_report_deliveries (id);

-- ---- What the summaries cost -------------------------------------------------------

ALTER TABLE ai_usage ADD COLUMN automation_id uuid REFERENCES ai_automations (id);
CREATE INDEX ai_usage_automation_idx ON ai_usage (automation_id, created_at) WHERE automation_id IS NOT NULL;

-- ---- Where follow-ups and notifications came from (0035) ---------------------------

ALTER TABLE follow_ups
  ADD CONSTRAINT follow_ups_automation_fk FOREIGN KEY (automation_id) REFERENCES ai_automations (id);
ALTER TABLE user_notifications
  ADD CONSTRAINT user_notifications_automation_fk FOREIGN KEY (automation_id) REFERENCES ai_automations (id),
  ADD CONSTRAINT user_notifications_delivery_fk FOREIGN KEY (delivery_id) REFERENCES ai_report_deliveries (id);

-- ---- What the assistant reads ------------------------------------------------------

-- As in 0033, with the automations' own entries left out too: they are the
-- assistant's bookkeeping, hidden from everyone but its owner in the audit
-- browser. Same columns, so every comment and grant stays as it is. Still a
-- security barrier (see 0033): replacing the view must say so again.
CREATE OR REPLACE VIEW ai.audit_log WITH (security_barrier = true) AS
SELECT a.id                                   AS audit_id,
       a.at,
       (a.at AT TIME ZONE current_setting('TimeZone'))::date AS day,
       a.user_id,
       a.user_name,
       a.action::text                         AS action,
       a.entity,
       a.entity_id,
       a.field,
       a.old_value,
       a.new_value,
       a.order_number,
       a.item,
       a.work_center_code                     AS machine_code,
       CASE WHEN a.work_center_code IS NULL THEN NULL
            ELSE COALESCE(NULLIF(btrim(m.display_name), ''), 'Machine ' || a.work_center_code) END AS machine,
       a.session_id,
       a.sample_id
  FROM audit_log a
  LEFT JOIN machines m ON lower(m.code) = lower(a.work_center_code) AND m.deleted_at IS NULL
 WHERE a.deleted_at IS NULL
   AND a.entity NOT IN ('AiAssistant', 'AiAccess', 'AiReport', 'Automation', 'Notice', 'ChatGroup')
   AND NOT (a.entity = 'AppSettings' AND a.entity_id LIKE 'ai%');
