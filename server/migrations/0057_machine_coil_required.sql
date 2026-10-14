-- ============================================================================
-- 0057 — a machine whose samples must name their coil: roll-forming lines,
-- the 400 t press… set per machine in Configuration → Machines. On such a
-- machine a sample is refused without at least one coil (shared/rules.ts
-- validateSample, in the wizard and on the server). Welding keeps its own
-- rule: the connector coil number, always required. Off by default: nothing
-- changes until the administrator turns it on.
-- ============================================================================

ALTER TABLE machines ADD COLUMN coil_required boolean NOT NULL DEFAULT false;
