-- ============================================================================
-- 0022 — two more process groups (§15).
--
-- The dashboard's analysis page is sliced by the machine's process. The
-- floor groups its machines as roll forming, welding, painting, universal
-- machines, mast machines and others; the register only knew the first
-- three and "other". The two new groups run the forming wizard.
-- ============================================================================

ALTER TABLE machines DROP CONSTRAINT machines_process_check;
ALTER TABLE machines ADD CONSTRAINT machines_process_check CHECK (process IN ('forming', 'welding', 'paint', 'universal', 'mast', 'other'));

ALTER TABLE work_instructions DROP CONSTRAINT work_instructions_process_check;
ALTER TABLE work_instructions ADD CONSTRAINT work_instructions_process_check CHECK (process IN ('all', 'forming', 'welding', 'paint', 'universal', 'mast', 'other'));
