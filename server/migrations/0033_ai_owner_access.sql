-- ============================================================================
-- 0033 — the AI assistant has one owner, and each person the data the owner
-- gives them (§20, phase 3).
--   • ai_owner — the one account that controls the assistant: its key, its
--     switch and caps, who may use it, and what it costs. Pinned once by the
--     API (the live, active account named by AI_OWNER_USERNAME) and never
--     moved through the app. Recovery, should that account go, is a database
--     operation: this table refuses every change.
--   • ai_access — who may ask, about which data, on which model and effort,
--     within what personal monthly cap. Checked on every request.
--   • Data domains, enforced by PostgreSQL rather than by the prompt: one role
--     without LOGIN per domain (<database>_ai_base, _ai_inspection,
--     _ai_orders, _ai_materials, _ai_audit), each holding exactly its views
--     and functions. The API signs in as one role per combination of domains
--     (<database>_ai_r_<bits>), a member of the base and of its own domains'
--     roles only; it creates them at start (server/src/ai/reader.ts).
--   • The single reader role of 0031 goes: every combination replaces it.
--   • ai.audit_log leaves out the assistant's own bookkeeping (its settings,
--     key, access list and reports): it is the owner's alone. It is a
--     security barrier, so no condition of a query can see the rows it hides.
--   • Answers stopped in phases 1 and 2 keep no amount and no talk of keys or
--     settings in their notices: the chat shows no costs (§20 phase 3).
--
-- A view a later migration adds to schema ai belongs to exactly one domain:
-- grant it to that domain's role there; nothing else can read it. A function
-- is another matter: PostgreSQL lets everyone run a new function, and a
-- default set for one schema cannot take that away. So a migration adding a
-- function to ai revokes it from PUBLIC and grants it to its domain's role
-- (the API refuses to start the readers while anything in ai is open to all).
-- ============================================================================

-- ---- The owner ---------------------------------------------------------------------

CREATE TABLE ai_owner (
  id        smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  user_id   uuid NOT NULL REFERENCES users (id),
  pinned_at timestamptz NOT NULL DEFAULT now()
);

-- Pinned once, for good: the app never moves it. Changing it is a deliberate
-- act in the database (disable this trigger), never something a request does.
CREATE FUNCTION protect_ai_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'The AI assistant''s owner is fixed once pinned.' USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER ai_owner_fixed BEFORE UPDATE OR DELETE ON ai_owner FOR EACH ROW EXECUTE FUNCTION protect_ai_owner();

-- ---- Who may ask -------------------------------------------------------------------

CREATE TABLE ai_access (
  user_id         uuid PRIMARY KEY REFERENCES users (id),
  enabled         boolean NOT NULL DEFAULT true,
  -- What the person may ask about (AI_DOMAINS); none means nothing to ask about.
  domains         text[] NOT NULL,
  -- One of AI_MODELS; checked by the API, so a new model needs no migration.
  model           text NOT NULL,
  effort          text NOT NULL,
  -- USD per calendar month (UTC), on top of the assistant's own monthly cap.
  monthly_cap_usd numeric(10, 2) NOT NULL,
  updated_by_id   uuid REFERENCES users (id),
  updated_by_name text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_access_domains CHECK (
    domains <@ ARRAY['inspection', 'orders', 'materials', 'audit']::text[] AND array_position(domains, NULL) IS NULL
  ),
  CONSTRAINT ai_access_effort CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
  CONSTRAINT ai_access_cap CHECK (monthly_cap_usd >= 0 AND monthly_cap_usd <= 2000)
);
CREATE TRIGGER ai_access_updated_at BEFORE UPDATE ON ai_access FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A person's spend this month is read before every call.
CREATE INDEX ai_usage_user_created_idx ON ai_usage (user_id, created_at);

-- The model and effort each question ran on: the person's at the time, which the owner may change later.
ALTER TABLE ai_turns ADD COLUMN model text, ADD COLUMN effort text;

-- ---- The audit trail the assistant reads ------------------------------------------

-- As in 0032, with the access list and the assistant's own settings left out
-- too. Same columns, so every comment stays as it is.
--
-- A security barrier: without it the planner may test a query's own condition
-- on a row the WHERE below hides before the WHERE does, and a failing cast
-- (new_value::date) quotes that row in its error. With it, only conditions
-- that can reveal nothing (comparisons of text, times, numbers) run first, so
-- the usual filters stay fast. Replacing this view later must say it again:
-- CREATE OR REPLACE VIEW without the option takes the barrier away.
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
   AND a.entity NOT IN ('AiAssistant', 'AiAccess', 'AiReport', 'Notice', 'ChatGroup')
   AND NOT (a.entity = 'AppSettings' AND a.entity_id LIKE 'ai%');

-- ---- What the chat shows of answers stopped before ---------------------------------
-- Phases 1 and 2 kept the cap's amount, and told everyone what to change under
-- Administration, in an answer's notice. Now the chat says neither, to anyone:
-- the same words a stop today keeps (server/src/ai/access.ts, assistant.ts).

-- Every cap then was the assistant's own: there were no personal caps.
UPDATE ai_turns
   SET notice = 'The assistant''s monthly limit is reached, so the answer stopped. It is available again on the 1st.'
 WHERE stop_reason = 'cap';

-- The key refused, not allowed, without the model, the account not billable: "An administrator can …".
UPDATE ai_turns
   SET notice = 'The assistant is not available right now. Try again later.'
 WHERE stop_reason = 'error' AND notice LIKE '%An administrator can%';

-- ---- The domain roles --------------------------------------------------------------
-- Every view belongs to exactly one domain. A view may read tables of another
-- domain (views run with their owner's rights); what a role may select is the
-- views. Functions a view calls are checked against the caller, so the
-- helpers every view needs sit in the base, which every combination holds.

DO $$
DECLARE
  db     text := current_database();
  reader text := current_database() || '_ai_reader';
  role   text;
  d      text;
  v      text;
  views  jsonb := jsonb_build_object(
    'base',       jsonb_build_array('machines'),
    'inspection', jsonb_build_array('inspection_sessions', 'inspection_samples', 'defects', 'dimension_measurements', 'sample_coils',
                                    'pt_records', 'session_stage_quantities', 'session_notes', 'production_sessions'),
    'orders',     jsonb_build_array('order_lines', 'pdi_documents', 'pdi_lines', 'order_sync_runs'),
    'materials',  jsonb_build_array('coils', 'suppliers', 'item_dimension_specs', 'machine_defect_list', 'grade_equivalences',
                                    'pt_consumables', 'work_instructions'),
    'audit',      jsonb_build_array('audit_log', 'users'));
BEGIN
  FOREACH d IN ARRAY ARRAY['base', 'inspection', 'orders', 'materials', 'audit'] LOOP
    role := db || '_ai_' || d;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role) THEN
      BEGIN
        EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', role);
      EXCEPTION WHEN duplicate_object THEN
        NULL; -- another instance created it a moment ago
      END;
    END IF;
    -- Exactly what the domain holds, whatever an earlier run granted.
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA ai FROM %I', role);
    EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ai FROM %I', role);
    EXECUTE format('REVOKE ALL ON SCHEMA ai FROM %I', role);
    FOR v IN SELECT jsonb_array_elements_text(views -> d) LOOP
      EXECUTE format('GRANT SELECT ON ai.%I TO %I', v, role);
    END LOOP;
  END LOOP;

  -- The base: the schema itself, and the helpers views and the query runner call.
  role := db || '_ai_base';
  EXECUTE format('GRANT USAGE ON SCHEMA ai TO %I', role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION ai.machine_key(text), ai.material_kind(text), ai.assert_row_size(int, int) TO %I', role);
  -- Production reads ai.production_sessions, an inspection view, as the caller.
  EXECUTE format('GRANT EXECUTE ON FUNCTION ai.production_between(date, date, text, boolean) TO %I', db || '_ai_inspection');

  -- The single reader of 0031 gives way to the combinations. Should anything
  -- still hold on to it (default privileges another role granted it), it is
  -- left without a grant and unable to sign in.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = reader) THEN
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA ai FROM %I', reader);
    EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ai FROM %I', reader);
    EXECUTE format('REVOKE ALL ON SCHEMA ai FROM %I', reader);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA ai REVOKE ALL ON TABLES FROM %I', reader);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA ai REVOKE ALL ON FUNCTIONS FROM %I', reader);
    BEGIN
      EXECUTE format('DROP ROLE %I', reader);
    EXCEPTION WHEN dependent_objects_still_exist THEN
      EXECUTE format('ALTER ROLE %I NOLOGIN', reader);
      RAISE NOTICE 'Role % is still referenced; it was left without LOGIN.', reader;
    END;
  END IF;
END $$;
