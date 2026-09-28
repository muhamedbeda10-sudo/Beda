-- ============================================================================
-- 0024 — universal machines and their stages (§4, §15).
--
-- The floor runs four kinds of machine: roll forming, welding, painting and
-- universal — presses, benders and anything that is none of the first three.
-- Mast machines and "others" are universal machines.
--
-- On a universal machine one item of an order can pass through several
-- stages, each a session of its own with its own defects. The first session
-- on a line is stage 1; a later one is given its stage when it closes. The
-- line's quantity is the one on the order sheet, counted once, whatever the
-- number of stages: the final quantity typed at each close would count the
-- same pieces again at every stage.
-- ============================================================================

UPDATE machines SET process = 'universal' WHERE process IN ('mast', 'other');
ALTER TABLE machines DROP CONSTRAINT machines_process_check;
ALTER TABLE machines ADD CONSTRAINT machines_process_check CHECK (process IN ('forming', 'welding', 'paint', 'universal'));

UPDATE work_instructions SET process = 'universal' WHERE process IN ('mast', 'other');
ALTER TABLE work_instructions DROP CONSTRAINT work_instructions_process_check;
ALTER TABLE work_instructions ADD CONSTRAINT work_instructions_process_check CHECK (process IN ('all', 'forming', 'welding', 'paint', 'universal'));

-- The stage of a session on a universal machine; empty on every other machine.
ALTER TABLE inspection_sessions ADD COLUMN stage smallint CHECK (stage IS NULL OR stage BETWEEN 1 AND 50);

-- Sessions already closed on a universal machine were recorded before stages
-- existed: they are stage 1, which leaves their line's figures as they were.
UPDATE inspection_sessions s
   SET stage = 1
 WHERE s.status = 'Closed' AND s.stage IS NULL
   AND EXISTS (SELECT 1 FROM machines m
                WHERE lower(m.code) = lower(s.work_center_code) AND m.deleted_at IS NULL AND m.process = 'universal')
   AND NOT EXISTS (SELECT 1 FROM production_orders o WHERE o.id = s.order_id AND upper(btrim(o.order_number)) = 'STOCK');
