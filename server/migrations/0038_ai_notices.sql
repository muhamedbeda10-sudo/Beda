-- ============================================================================
-- 0038 — notices through the assistant (§23).
--   • ai_access.notices — the owner allows a person to have the assistant
--     write notices: a new one, a change, a withdrawal, a deletion. It takes
--     effect only while the account is an administrator, which the API reads
--     again (the account's role as it is) on every call; the owner may
--     whatever this says, while an administrator. Reading notices through the
--     assistant needs nothing new: everyone reads what the app shows them.
--   • ai_notice_proposals — a notice card the assistant made in an answer,
--     as checked, with the people it reaches; for a change, a withdrawal or a
--     deletion, the notice as it was and the moment it last changed, so a card
--     made before a later change is never applied over it. Nothing changes
--     until the person who asked presses its button; then the notice is
--     written exactly as the Notices page writes it, as that person, and the
--     card names the notice. The answer's card shows it in its current state.
-- ============================================================================

ALTER TABLE ai_access ADD COLUMN notices boolean NOT NULL DEFAULT false;

CREATE TABLE ai_notice_proposals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The person who asked: only they may apply or discard it.
  user_id             uuid NOT NULL REFERENCES users (id),
  conversation_id     uuid NOT NULL REFERENCES ai_conversations (id),
  turn_id             uuid NOT NULL REFERENCES ai_turns (id),
  -- The propose_notice_change call it answers, in its answer.
  tool_use_id         text NOT NULL,
  action              text NOT NULL,
  -- update / withdraw / delete: the notice it acts on; create: the notice made, once applied.
  notice_id           uuid REFERENCES notices (id),
  -- AiNoticeDraft — create / update: the notice as it will be.
  draft               json,
  -- AiNoticeDraft — update / withdraw / delete: the notice as it was when the card was made.
  before              json,
  -- update / withdraw / delete: notices.updated_at when the card was made; any other value means it changed since.
  notice_updated_at   timestamptz,
  -- AiNoticeReach: whom the notice reaches.
  reach               json,
  -- The earlier card of the conversation this one is a new version of, checked when it is stored (cards are never
  -- deleted). No foreign key: storing a new version must take no lock on the card it revises, whose button may be
  -- being pressed at that very moment — the press never waits on an answer.
  revises_proposal_id uuid,
  -- The card passed the checks; when not, `error` says why (the assistant was told too).
  ok                  boolean NOT NULL,
  error               text,
  state               text NOT NULL DEFAULT 'proposed',
  applied_at          timestamptz,
  applied_by          uuid REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_notice_proposals_action CHECK (action IN ('create', 'update', 'withdraw', 'delete')),
  CONSTRAINT ai_notice_proposals_state CHECK (state IN ('proposed', 'applied', 'discarded', 'superseded', 'stale')),
  CONSTRAINT ai_notice_proposals_outcome CHECK (CASE WHEN ok THEN error IS NULL ELSE error IS NOT NULL END),
  -- A card that passed shows everything its action needs: the new notice, or the notice as it was, and its reach.
  CONSTRAINT ai_notice_proposals_shape CHECK (
    NOT ok OR (
      reach IS NOT NULL
      AND (draft IS NOT NULL) = (action IN ('create', 'update'))
      AND (before IS NOT NULL) = (action <> 'create')
      AND (action = 'create' OR (notice_id IS NOT NULL AND notice_updated_at IS NOT NULL))
    )
  ),
  -- Only a card that passed can be decided on; an applied one says when and by whom, and names its notice.
  CONSTRAINT ai_notice_proposals_decided CHECK (ok OR state = 'proposed'),
  CONSTRAINT ai_notice_proposals_applied CHECK ((state = 'applied') = (applied_at IS NOT NULL AND applied_by IS NOT NULL)),
  CONSTRAINT ai_notice_proposals_made CHECK (state <> 'applied' OR notice_id IS NOT NULL),
  CONSTRAINT ai_notice_proposals_call UNIQUE (conversation_id, tool_use_id)
);
CREATE INDEX ai_notice_proposals_turn_idx ON ai_notice_proposals (turn_id);
CREATE INDEX ai_notice_proposals_user_idx ON ai_notice_proposals (user_id, created_at DESC);
CREATE TRIGGER ai_notice_proposals_updated_at BEFORE UPDATE ON ai_notice_proposals FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER ai_notice_proposals_no_delete BEFORE DELETE ON ai_notice_proposals FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();
