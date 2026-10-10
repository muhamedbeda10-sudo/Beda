-- ============================================================================
-- 0037 — automations agreed in words before their card (§22).
--   • ai_automation_proposals.state 'superseded' — a newer version of the
--     proposal was made in the same conversation (revisesProposalId) before
--     it was activated: it can no longer be activated or discarded, and its
--     card says so. Only a proposal that passed its checks is superseded, as
--     only such a one is ever decided (ai_automation_proposals_decided), and
--     like a discarded one it names no automation.
--   • ai_automation_proposals.confirmation — the person's words of agreement
--     the assistant quoted from their message when it proposed: who agreed to
--     what. Null for proposals made before §22, and in conversations begun
--     before it, whose tool asks for none.
-- ============================================================================

ALTER TABLE ai_automation_proposals DROP CONSTRAINT ai_automation_proposals_state;
ALTER TABLE ai_automation_proposals
  ADD CONSTRAINT ai_automation_proposals_state CHECK (state IN ('proposed', 'activated', 'discarded', 'superseded'));

ALTER TABLE ai_automation_proposals ADD COLUMN confirmation text;
