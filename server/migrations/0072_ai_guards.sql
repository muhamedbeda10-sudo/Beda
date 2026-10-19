-- ============================================================================
-- §20 — the assistant's guards, tightened where a review found them open.
--
--   • Reading by name. PostgreSQL's *_to_xml family runs a query given as
--     text, or reads a table, a schema or the whole database named in a
--     string; ts_stat and ts_rewrite(tsquery, text) run a query given as text;
--     pg_stats and its kin show the most common values of any table the role
--     may read. What they read is checked only as they run, so planning a
--     query (EXPLAIN) cannot see it — and planning is how a saved table learns
--     which domains it reads (ai/savedTables.ts). Nothing in the app uses
--     them: they are taken from PUBLIC, so no role (the readers included) may
--     use them. Only a superuser may change what PUBLIC holds in pg_catalog;
--     where the migration runs as anyone else (a managed server's admin) it
--     says so, the API warns at every start (ai/reader.ts), and the runner's
--     own refusal of them (ai/runQuery.ts, DENIED) stands alone.
--   • ai_reports.author_domains: the domains of whoever last wrote a report's
--     queries, as they were then (its queries were run as them to be kept).
--     A scheduled report that sends someone else's saved report runs it as
--     the creator's domains within these (automations/savedReport.ts): a
--     shared report changed after it was scheduled reads no more than its
--     author could. Null for the app's own starter reports.
--   • ai_usage_holds: the worst case of every call to the model that is
--     under way, held against both monthly caps until the call ends — then
--     replaced by what it really cost (ai_usage), in the same statement, or
--     let go when it cost nothing. Every cap check counts them, under one
--     lock (ai/access.ts), so calls made at once cannot pass a cap together.
--     A hold left by a server that died expires on its own.
--   • A sample's material under concurrency. refresh_sample_rollups read its
--     order's expected grade and its coils' grades from the register as any
--     statement does: a grade changed (the register, the ERP sync) while a
--     sample was being saved with them was missed by both, and the material
--     kept stayed stale. Now the save holds what it reads still (below).
-- ============================================================================

-- ---- Reading by name ----------------------------------------------------------------

DO $$
DECLARE
  f regprocedure;
  v regclass;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE WARNING 'the *_to_xml functions, ts_stat, ts_rewrite(tsquery, text) and pg_stats stay usable by every role: only a superuser can take them from PUBLIC. The assistant''s runner refuses them by name.';
    RETURN;
  END IF;
  FOR f IN
    SELECT p.oid::regprocedure FROM pg_proc p
     WHERE p.pronamespace = 'pg_catalog'::regnamespace
       AND (p.proname IN ('table_to_xml', 'table_to_xmlschema', 'table_to_xml_and_xmlschema',
                          'query_to_xml', 'query_to_xmlschema', 'query_to_xml_and_xmlschema',
                          'cursor_to_xml', 'cursor_to_xmlschema',
                          'schema_to_xml', 'schema_to_xmlschema', 'schema_to_xml_and_xmlschema',
                          'database_to_xml', 'database_to_xmlschema', 'database_to_xml_and_xmlschema',
                          'ts_stat')
            OR p.oid = 'pg_catalog.ts_rewrite(tsquery, text)'::regprocedure)
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  FOR v IN SELECT to_regclass(n) FROM unnest(ARRAY['pg_catalog.pg_stats', 'pg_catalog.pg_stats_ext', 'pg_catalog.pg_stats_ext_exprs']) n WHERE to_regclass(n) IS NOT NULL
  LOOP
    EXECUTE format('REVOKE SELECT ON %s FROM PUBLIC', v);
  END LOOP;
END
$$;

-- ---- Whose domains a report's queries were written within -------------------------------

ALTER TABLE ai_reports ADD COLUMN author_domains text[];
COMMENT ON COLUMN ai_reports.author_domains IS
  'The domains of whoever last wrote the report''s queries, as they were then; a scheduled delivery of it by someone else reads within them. Null: the app''s own starter report.';
-- Reports kept before: their maker's domains as they are now, the nearest to what they were.
UPDATE ai_reports r
   SET author_domains = COALESCE((SELECT a.domains FROM ai_access a WHERE a.user_id = r.user_id), '{}')
 WHERE r.made_by <> 'starter';

-- ---- Calls under way, held against the caps -----------------------------------------------

CREATE TABLE ai_usage_holds (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id),
  -- The most the call could cost.
  usd        numeric(14, 6) NOT NULL CHECK (usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Past this, the call cannot still be under way: the hold no longer counts, and is cleared.
  expires_at timestamptz NOT NULL
);
CREATE INDEX ai_usage_holds_expires_idx ON ai_usage_holds (expires_at);
CREATE INDEX ai_usage_holds_user_idx ON ai_usage_holds (user_id, expires_at);

-- ---- A sample's material, read as committed -------------------------------------------------
-- The coil register's rows of a sample's coils, and its order line, are read FOR SHARE: a change to one waits for the
-- save, or the save for it. A coil added to the register under a number already typed on a sample has no row to wait
-- for, so each number is also held by an advisory lock (class 67, the number's hash): shared by the saves, which never
-- wait for one another, exclusive for a change to the register under that number. The register's rows are locked
-- before the numbers, in the order a change to the register takes them (its row by its UPDATE, then the number in its
-- trigger), so the two never wait on each other in a circle. The statement that works the figures out takes its
-- snapshot once all are held, and so reads them as committed.

CREATE OR REPLACE FUNCTION refresh_sample_rollups(ids uuid[]) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ids IS NULL OR cardinality(ids) = 0 THEN RETURN; END IF;
  PERFORM 1 FROM production_orders o
   WHERE o.id IN (SELECT x.order_id FROM inspection_samples x WHERE x.id = ANY (ids))
   ORDER BY o.id FOR SHARE;
  PERFORM 1 FROM coils reg
   WHERE lower(reg.coil_number) IN (SELECT lower(sc.coil_number) FROM sample_coils sc WHERE sc.sample_id = ANY (ids) AND sc.deleted_at IS NULL)
   ORDER BY reg.id FOR SHARE;
  PERFORM pg_advisory_xact_lock_shared(67, n.k)
     FROM (SELECT DISTINCT hashtext(lower(sc.coil_number)) AS k FROM sample_coils sc
            WHERE sc.sample_id = ANY (ids) AND sc.deleted_at IS NULL ORDER BY 1) n;
  INSERT INTO sample_rollups (sample_id)
  SELECT x.id FROM inspection_samples x WHERE x.id = ANY (ids) ORDER BY x.id
  ON CONFLICT (sample_id) DO NOTHING;
  PERFORM 1 FROM sample_rollups WHERE sample_id = ANY (ids) ORDER BY sample_id FOR UPDATE;
  UPDATE sample_rollups r SET
    dimension_rows = d.dimension_rows, dimensions_measured = d.dimensions_measured, dimensions_pass = d.dimensions_pass,
    dimensions_warning = d.dimensions_warning, dimensions_fail = d.dimensions_fail,
    defect_records = f.defect_records, defect_pieces = f.defect_pieces, hold_records = f.hold_records, hold_pieces = f.hold_pieces,
    rejected_pieces = f.rejected_pieces, repair_pieces = f.repair_pieces, used_elsewhere_pieces = f.used_elsewhere_pieces,
    concession_pieces = f.concession_pieces,
    pt_lengths_tested = t.tested, pt_lengths_rejected = t.rejected,
    coils = c.coils, coil_material = c.coil_material,
    material = CASE WHEN c.coil_material IN ('black', 'galvanized') THEN c.coil_material ELSE ai.material_kind(o.expected_grade) END
  FROM inspection_samples x
  JOIN production_orders o ON o.id = x.order_id
  CROSS JOIN LATERAL (
    SELECT count(*)::integer AS dimension_rows,
           count(*) FILTER (WHERE dr.actual IS NOT NULL)::integer AS dimensions_measured,
           count(*) FILTER (WHERE dr.actual IS NOT NULL AND dr.status = 'Pass')::integer AS dimensions_pass,
           count(*) FILTER (WHERE dr.actual IS NOT NULL AND dr.status = 'Warning')::integer AS dimensions_warning,
           count(*) FILTER (WHERE dr.status = 'Fail')::integer AS dimensions_fail
      FROM dimension_results dr WHERE dr.sample_id = x.id AND dr.deleted_at IS NULL
  ) d
  CROSS JOIN LATERAL (
    SELECT count(*)::integer AS defect_records,
           COALESCE(sum(df.qty), 0) AS defect_pieces,
           count(*) FILTER (WHERE df.disposition = 'Hold')::integer AS hold_records,
           COALESCE(sum(df.qty) FILTER (WHERE df.disposition = 'Hold'), 0) AS hold_pieces,
           COALESCE(sum(df.qty) FILTER (WHERE df.disposition = 'Rejected'), 0) AS rejected_pieces,
           COALESCE(sum(df.qty) FILTER (WHERE df.disposition = 'Repair'), 0) AS repair_pieces,
           COALESCE(sum(df.qty) FILTER (WHERE df.disposition = 'Used in another order'), 0) AS used_elsewhere_pieces,
           COALESCE(sum(df.qty) FILTER (WHERE df.disposition = 'Accept with concession'), 0) AS concession_pieces
      FROM defect_results df WHERE df.sample_id = x.id AND df.deleted_at IS NULL
  ) f
  CROSS JOIN LATERAL (
    SELECT count(*)::integer AS tested, count(*) FILTER (WHERE l.verdict = 'Reject / Repair')::integer AS rejected
      FROM pt_tested_lengths l JOIN pt_records pr ON pr.id = l.pt_record_id
     WHERE pr.sample_id = x.id AND pr.deleted_at IS NULL AND l.deleted_at IS NULL
  ) t
  CROSS JOIN LATERAL (
    SELECT string_agg(sc.coil_number, ', ' ORDER BY sc.coil_number) AS coils,
           CASE count(DISTINCT k.kind) FILTER (WHERE k.kind IN ('black', 'galvanized'))
             WHEN 0 THEN NULL
             WHEN 1 THEN max(k.kind) FILTER (WHERE k.kind IN ('black', 'galvanized'))
             ELSE 'mixed' END AS coil_material
      FROM sample_coils sc
      LEFT JOIN coils reg ON lower(reg.coil_number) = lower(sc.coil_number) AND reg.deleted_at IS NULL
      CROSS JOIN LATERAL (SELECT ai.material_kind(COALESCE(NULLIF(btrim(sc.grade), ''), NULLIF(btrim(reg.grade), ''))) AS kind) k
     WHERE sc.sample_id = x.id AND sc.deleted_at IS NULL
  ) c
  WHERE x.id = r.sample_id AND r.sample_id = ANY (ids);
  PERFORM refresh_session_rollups(ARRAY(SELECT DISTINCT x.session_id FROM inspection_samples x WHERE x.id = ANY (ids)));
END
$$;

/** The coil register: a coil's grade (and so its material) reaches the samples it was used in. Only a change that matters. */
CREATE OR REPLACE FUNCTION rollups_after_coils() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE numbers text[]; ids uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT lower(coil_number)) INTO numbers FROM new_rows;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT lower(coil_number)) INTO numbers FROM old_rows;
  ELSE
    SELECT array_agg(DISTINCT k) INTO numbers FROM (
      SELECT lower(n.coil_number) AS k FROM new_rows n JOIN old_rows o ON o.id = n.id
       WHERE n.coil_number IS DISTINCT FROM o.coil_number OR n.grade IS DISTINCT FROM o.grade OR n.deleted_at IS DISTINCT FROM o.deleted_at
      UNION
      SELECT lower(o.coil_number) FROM new_rows n JOIN old_rows o ON o.id = n.id
       WHERE n.coil_number IS DISTINCT FROM o.coil_number OR n.grade IS DISTINCT FROM o.grade OR n.deleted_at IS DISTINCT FROM o.deleted_at) u;
  END IF;
  IF numbers IS NULL THEN RETURN NULL; END IF;
  -- The numbers, held against the saves that read them (refresh_sample_rollups): a sample being saved with one of them
  -- is committed before its rows are looked for below, or waits for this change to be.
  PERFORM pg_advisory_xact_lock(67, n.k) FROM (SELECT DISTINCT hashtext(u) AS k FROM unnest(numbers) u ORDER BY 1) n;
  SELECT array_agg(DISTINCT sc.sample_id) INTO ids FROM sample_coils sc WHERE lower(sc.coil_number) = ANY (numbers);
  PERFORM refresh_sample_rollups(ids);
  RETURN NULL;
END
$$;
