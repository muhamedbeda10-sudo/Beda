-- ============================================================================
-- 0021 — hidden insights (§15).
--
-- An insight is a rule's reading of the period, so it comes back on every
-- load. Once a person has read one they can hide it: per person, so the
-- choice follows them from device to device, and by the insight's key (its
-- rule and its subject), so hiding "machine 14 runs hot" never hides the
-- same rule about machine 31. Showing it again keeps the row and stamps it.
-- ============================================================================

CREATE TABLE insight_dismissals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  insight_key  text NOT NULL,
  hidden_at    timestamptz NOT NULL DEFAULT now(),
  restored_at  timestamptz,
  CONSTRAINT insight_dismissals_key_shape CHECK (insight_key = btrim(insight_key) AND insight_key <> '' AND length(insight_key) <= 200),
  CONSTRAINT insight_dismissals_one_per_user UNIQUE (user_id, insight_key)
);
CREATE TRIGGER insight_dismissals_no_delete BEFORE DELETE ON insight_dismissals FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();
