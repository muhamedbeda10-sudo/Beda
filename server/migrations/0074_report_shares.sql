-- ============================================================================
-- 0074 — a saved report shared with people and roles (ai/reportShares.ts).
--
--   • ai_report_shares — whom a report's owner shared it with: a person, or
--     everyone holding a role. Read live at every request: a role's members
--     as they are now, an inactive account never. Unsharing removes the row;
--     the audit log keeps who shared and unshared what (entity AiReport).
--     A recipient opens the report on the Reports page — whether or not they
--     have the assistant — and runs it as its owner's current domains, within
--     the domains its queries were written under (ai_reports.author_domains).
--   • ai_report_share_notices — whom the bell already told that a report was
--     shared with them: told once per report and person, however often it is
--     shared again. Kept apart from the alerts, which are removed after 90 days.
--   • ai_report_runs — each run and export of a shared report by a recipient,
--     for the owner to see who ran it and when. A table rather than the audit
--     log: runs are reads, not changes; the owner's panel reads them by report
--     with one index; and purging the audit log must not lose them.
--   • ai_report_share_images — the photos a recipient's run showed them, for
--     a day after the run (images.routes.ts, readableImageIds): a recipient
--     sees the inspection and PDI photos their runs returned, and no others,
--     while the report is still shared with them.
--   • ai_report_share_cards — the cards the assistant's share_report tool
--     left in a conversation (whom it added and removed), so a conversation
--     read again shows them.
--   • user_notifications — the kind 'report-shared', listed with the bell's
--     Reports; that list's index takes it.
--
-- Like the assistant's other records these live in public and are never
-- granted to the reader role.
-- ============================================================================

CREATE TABLE ai_report_shares (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id    uuid NOT NULL REFERENCES ai_reports (id),
  user_id      uuid REFERENCES users (id),
  role         user_role,
  shared_by_id uuid NOT NULL REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_report_shares_one_target CHECK ((user_id IS NULL) <> (role IS NULL))
);
-- Each person and each role once per report; the report's list by its id.
CREATE UNIQUE INDEX ai_report_shares_user_once ON ai_report_shares (report_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX ai_report_shares_role_once ON ai_report_shares (report_id, role) WHERE role IS NOT NULL;
-- What is shared with a person: directly, or through their role (the Reports page, and whether to show it at all).
CREATE INDEX ai_report_shares_user_idx ON ai_report_shares (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX ai_report_shares_role_idx ON ai_report_shares (role) WHERE role IS NOT NULL;

CREATE TABLE ai_report_share_notices (
  report_id   uuid NOT NULL REFERENCES ai_reports (id),
  user_id     uuid NOT NULL REFERENCES users (id),
  notified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, user_id)
);

CREATE TABLE ai_report_runs (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES ai_reports (id),
  user_id   uuid NOT NULL REFERENCES users (id),
  kind      text NOT NULL CHECK (kind IN ('run', 'export')),
  ran_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_report_runs_report_idx ON ai_report_runs (report_id, user_id, ran_at DESC);
CREATE TRIGGER ai_report_runs_no_delete BEFORE DELETE ON ai_report_runs FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

CREATE TABLE ai_report_share_images (
  report_id  uuid NOT NULL REFERENCES ai_reports (id),
  user_id    uuid NOT NULL REFERENCES users (id),
  image_id   uuid NOT NULL REFERENCES images (id),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (report_id, user_id, image_id)
);
-- Whether a photo may be read: one look-up by the photo and the reader.
CREATE INDEX ai_report_share_images_image_idx ON ai_report_share_images (image_id, user_id);
-- The daily removal of the lapsed ones.
CREATE INDEX ai_report_share_images_expires_idx ON ai_report_share_images (expires_at);

CREATE TABLE ai_report_share_cards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id       uuid NOT NULL REFERENCES ai_reports (id),
  conversation_id uuid NOT NULL REFERENCES ai_conversations (id),
  turn_id         uuid NOT NULL REFERENCES ai_turns (id),
  tool_use_id     text NOT NULL,
  user_id         uuid NOT NULL REFERENCES users (id),
  -- Whom the call added and removed, as they were named then ("Ahmed Ali", "Every supervisor").
  added           text[] NOT NULL DEFAULT '{}',
  removed         text[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, tool_use_id)
);
CREATE INDEX ai_report_share_cards_turn_idx ON ai_report_share_cards (conversation_id, turn_id);
CREATE FUNCTION ai_report_share_cards_keep() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ai_report_share_cards is append-only';
END $$;
CREATE TRIGGER ai_report_share_cards_keep BEFORE UPDATE OR DELETE ON ai_report_share_cards FOR EACH ROW EXECUTE FUNCTION ai_report_share_cards_keep();

-- ---- The bell -----------------------------------------------------------------------

ALTER TABLE user_notifications DROP CONSTRAINT user_notifications_kind;
ALTER TABLE user_notifications ADD CONSTRAINT user_notifications_kind CHECK (kind IN (
  'automation-case', 'automation-digest', 'automation-report', 'automation-stopped',
  'follow-up-assigned', 'follow-up-overdue', 'follow-up-updated',
  'task-assigned', 'task-updated', 'task-done', 'task-reopened',
  'ai-answer', 'report-shared'));

-- The Reports list (0047) holds the reports shared with a person beside the ones delivered: its index, both kinds.
DROP INDEX user_notifications_reports_idx;
CREATE INDEX user_notifications_reports_idx ON user_notifications (user_id, created_at DESC, id DESC) WHERE kind IN ('automation-report', 'report-shared');
