-- ============================================================================
-- 0027 — a machine left out of the dashboard (§15).
--
-- Some machines are inspected but are not production the dashboard should
-- weigh — manual welding, a bench. Such a machine keeps its sessions,
-- History and inspection flow; every dashboard figure leaves it out.
-- ============================================================================

ALTER TABLE machines ADD COLUMN on_dashboard boolean NOT NULL DEFAULT true;
