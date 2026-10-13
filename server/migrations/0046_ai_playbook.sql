-- ============================================================================
-- 0046 — the assistant's playbook: what it follows in every new
-- conversation. A person's own instructions ("always give rates as %, with
-- last month beside them") and the conclusions they kept from an analysis
-- ("machine 58 makes most of its defects on the night shift"), and the
-- instructions the assistant's owner sets for everyone. Instructions only
-- for everyone: a conclusion is drawn from data its person may read, which
-- others may not.
--
-- Saved from a conversation (the assistant, at the person's word) or on the
-- Playbook page. Every change is kept, with where it was made: the history
-- is append-only, and a removed entry is only marked so.
-- ============================================================================

CREATE TABLE ai_playbook_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope           text NOT NULL CHECK (scope IN ('personal', 'shared')),
  -- Whose it is; none for one for everyone.
  user_id         uuid REFERENCES users (id),
  kind            text NOT NULL CHECK (kind IN ('instruction', 'conclusion')),
  body            text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 500),
  -- For a conclusion: what it was drawn from (the data, the period).
  basis           text NOT NULL DEFAULT '' CHECK (length(basis) <= 200),
  created_by_id   uuid NOT NULL REFERENCES users (id),
  created_by_name text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CONSTRAINT ai_playbook_entries_owner CHECK ((scope = 'personal') = (user_id IS NOT NULL)),
  CONSTRAINT ai_playbook_entries_shared_instructions CHECK (scope = 'personal' OR kind = 'instruction'),
  CONSTRAINT ai_playbook_entries_basis_of_conclusion CHECK (kind = 'conclusion' OR basis = '')
);
CREATE INDEX ai_playbook_entries_person_idx ON ai_playbook_entries (user_id, created_at) WHERE deleted_at IS NULL;
CREATE INDEX ai_playbook_entries_shared_idx ON ai_playbook_entries (created_at) WHERE deleted_at IS NULL AND scope = 'shared';
CREATE TRIGGER ai_playbook_entries_updated_at BEFORE UPDATE ON ai_playbook_entries FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER ai_playbook_entries_no_delete BEFORE DELETE ON ai_playbook_entries FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

CREATE TABLE ai_playbook_changes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id        uuid NOT NULL REFERENCES ai_playbook_entries (id),
  action          text NOT NULL CHECK (action IN ('add', 'change', 'remove')),
  body_before     text,
  body_after      text,
  basis_before    text,
  basis_after     text,
  by_id           uuid NOT NULL REFERENCES users (id),
  by_name         text NOT NULL,
  -- Made by the assistant: the answer and the tool call; on the page: none.
  conversation_id uuid REFERENCES ai_conversations (id),
  turn_id         uuid REFERENCES ai_turns (id),
  tool_use_id     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_playbook_changes_source CHECK (
    (conversation_id IS NULL AND turn_id IS NULL AND tool_use_id IS NULL)
    OR (conversation_id IS NOT NULL AND turn_id IS NOT NULL AND tool_use_id IS NOT NULL)
  ),
  CONSTRAINT ai_playbook_changes_bodies CHECK (
    (action = 'add' AND body_before IS NULL AND body_after IS NOT NULL)
    OR (action = 'change' AND body_before IS NOT NULL AND body_after IS NOT NULL)
    OR (action = 'remove' AND body_before IS NOT NULL AND body_after IS NULL)
  ),
  UNIQUE (conversation_id, tool_use_id)
);
CREATE INDEX ai_playbook_changes_entry_idx ON ai_playbook_changes (entry_id, created_at);
CREATE INDEX ai_playbook_changes_turn_idx ON ai_playbook_changes (conversation_id, turn_id) WHERE conversation_id IS NOT NULL;

-- The history is what happened: never changed, never removed.
CREATE FUNCTION protect_ai_playbook_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'The playbook history is append-only.' USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER ai_playbook_changes_append_only BEFORE UPDATE OR DELETE ON ai_playbook_changes FOR EACH ROW EXECUTE FUNCTION protect_ai_playbook_change();
