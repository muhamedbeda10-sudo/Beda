-- ============================================================================
-- 0028 — universal machines: a final product, or stages with their quantities (§4, §15).
--
-- The first session closed on a line (an item of an order on a universal
-- machine) says what the line is:
--   • final  — a finished product with no stages. Every later session is one
--              more inspection of a new quantity, and the quantities add up.
--   • staged — the item passes through stages. A session may cover several
--              stages at once (the item runs on more than one press), each
--              with its own quantity, usually the same.
-- A staged line's production in any span is the quantity of the highest
-- stage recorded in that span.
--
-- Sessions closed before this change keep universal_kind NULL: the dashboard
-- still counts their line once at the order sheet's quantity, as before. Their
-- stage moves to the new table with the final quantity they were closed on.
-- ============================================================================

ALTER TABLE inspection_sessions
  ADD COLUMN universal_kind text CHECK (universal_kind IS NULL OR universal_kind IN ('final', 'staged'));

CREATE TABLE session_stage_quantities (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     uuid NOT NULL REFERENCES inspection_sessions(id),
  stage          smallint NOT NULL CHECK (stage BETWEEN 1 AND 50),
  qty            numeric(14, 3) NOT NULL CHECK (qty >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by_id  uuid REFERENCES users(id),
  deleted_at     timestamptz,
  deleted_by_id  uuid REFERENCES users(id)
);
-- One live quantity per stage of a session; a correction marks the old one deleted.
CREATE UNIQUE INDEX session_stage_quantities_live ON session_stage_quantities (session_id, stage) WHERE deleted_at IS NULL;
CREATE TRIGGER session_stage_quantities_no_delete BEFORE DELETE ON session_stage_quantities FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

INSERT INTO session_stage_quantities (session_id, stage, qty, created_at, created_by_id)
SELECT s.id, s.stage, COALESCE(s.final_qty, 0), COALESCE(s.closed_at, now()), s.closed_by_id
  FROM inspection_sessions s
 WHERE s.stage IS NOT NULL;

ALTER TABLE inspection_sessions DROP COLUMN stage;
