import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TestApp } from './harness'
import { factoryDataSql } from './perf/factoryData'

// §20 — the assistant's views stay fast, whatever is added to them later
// (CLAUDE.md, "The assistant's views stay fast"). Every view in schema ai is
// found from the catalog, so a new one is held to the same rules without
// anyone listing it:
//   • no figure worked out row by row beyond the few allowed below, each a
//     single indexed lookup: a count or sum over another table is kept as the
//     record is written (sample_rollups, session_rollups — migration 0067);
//   • every view read whole, every column, within a few seconds on a factory's
//     worth of rows;
//   • a question about one machine reads only that machine's sessions.

/**
 * The subqueries each view may work out per row, and why each is cheap. A view
 * missing here, or with more, fails: keep the figure as the record is written
 * instead, or — when it is one indexed lookup — add it here with its reason.
 */
const SUBQUERIES_PER_ROW: Record<string, { allowed: number; why: string }> = {
  audit_log: { allowed: 0, why: '' },
  coils: { allowed: 2, why: 'samples_used_in, last_used_at: the coil’s own uses, by its number (indexed)' },
  defects: { allowed: 1, why: 'photos: the defect’s own, by its id' },
  dimension_measurements: { allowed: 0, why: '' },
  grade_equivalences: { allowed: 0, why: '' },
  inspection_samples: { allowed: 2, why: 'paint_notes, pt_verdict: the sample’s one paint and PT record (unique index)' },
  inspection_sessions: { allowed: 2, why: 'closed_by: one user by id; prior_defects_elsewhere: an EXISTS that stops at the first match' },
  inspection_photos: { allowed: 0, why: '' },
  item_dimension_specs: { allowed: 0, why: '' },
  machine_defect_list: { allowed: 0, why: '' },
  machines: { allowed: 0, why: '' },
  planning_setup_times: { allowed: 0, why: '' },
  planning_maintenance: { allowed: 0, why: '' },
  order_lines: { allowed: 8, why: 'the order line’s own sessions, samples, PDI lines, sync run and machine, each by its id (indexed); defect pieces from sample_rollups' },
  order_sync_runs: { allowed: 0, why: '' },
  pdi_documents: { allowed: 4, why: 'the document’s own photos and lines, by its id' },
  pdi_lines: { allowed: 0, why: '' },
  pdi_photos: { allowed: 0, why: '' },
  production_sessions: { allowed: 2, why: 'top_stage, stage_quantities: the session’s own few stage rows (unique index)' },
  production_task_records: { allowed: 0, why: '' },
  planning_calendar: { allowed: 0, why: '' },
  planning_item_routes: { allowed: 0, why: '' },
  planning_machines: { allowed: 0, why: '' },
  planning_operations: { allowed: 0, why: '' },
  planning_plans: { allowed: 0, why: '' },
  planning_rates: { allowed: 0, why: '' },
  pt_consumables: { allowed: 0, why: '' },
  pt_records: { allowed: 4, why: 'the record’s own tested lengths (unique index on record and seq)' },
  sample_coils: { allowed: 0, why: '' },
  session_notes: { allowed: 1, why: 'photos: the note’s own, by its id' },
  session_stage_quantities: { allowed: 1, why: 'recorded_by: one user by id' },
  suppliers: { allowed: 0, why: '' },
  users: { allowed: 0, why: '' },
  work_instructions: { allowed: 0, why: '' },
}

/** Sessions of made-up record: 7 500 samples, 90 000 dimensions; enough to tell a view that reads row by row from one that does not. */
const SESSIONS = 1500
/** The most any view may take read whole, every column: far under the 60 seconds a question's query has. */
const WHOLE_VIEW_BUDGET_MS = 5_000

interface PlanNode {
  'Parent Relationship'?: string
  'Node Type'?: string
  'Index Name'?: string
  Plans?: PlanNode[]
}

let app: TestApp
let views: string[]

beforeAll(async () => {
  app = await new TestApp().start()
  await app.resetDatabase()
  await app.db.query(factoryDataSql(SESSIONS))
  await app.db.query('ANALYZE')
  views = (
    await app.db.query<{ name: string }>(`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'ai' AND c.relkind = 'v' ORDER BY 1`)
  ).rows.map((r) => r.name)
}, 180_000)

afterAll(async () => {
  await app.stop()
})

async function plan(sql: string): Promise<PlanNode> {
  const { rows } = await app.db.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(`EXPLAIN (FORMAT JSON) ${sql}`)
  return rows[0]['QUERY PLAN'][0].Plan
}

const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodes)]

describe('§20 the assistant’s views stay fast', () => {
  it('works out no figure row by row beyond the few single lookups allowed', async () => {
    expect(views.length).toBeGreaterThan(20)
    for (const view of views) {
      const rule = SUBQUERIES_PER_ROW[view]
      expect(rule, `ai.${view} is new: add it to SUBQUERIES_PER_ROW in this file, with why each of its per-row subqueries is a single indexed lookup`).toBeDefined()
      const perRow = nodes(await plan(`SELECT * FROM ai.${view}`)).filter((n) => n['Parent Relationship'] === 'SubPlan').length
      expect(perRow, `ai.${view} works out ${perRow} subqueries per row, ${rule.allowed} allowed: keep the figure as the record is written (see migration 0067), or justify it here`).toBeLessThanOrEqual(rule.allowed)
    }
  })

  it('reads every view whole, every column, within seconds on a factory’s worth of rows', async () => {
    const slow: string[] = []
    for (const view of views) {
      const started = Date.now()
      await app.db.query(`SELECT sum(length(t::text)) FROM ai.${view} t`)
      const ms = Date.now() - started
      if (ms > WHOLE_VIEW_BUDGET_MS) slow.push(`ai.${view}: ${ms} ms`)
    }
    expect(slow, `read whole, more than ${WHOLE_VIEW_BUDGET_MS} ms`).toEqual([])
  }, 300_000)

  it('reads only one machine’s sessions for a question about that machine, written as the assistant writes it', async () => {
    const used = nodes(await plan(`SELECT count(*) FROM ai.dimension_measurements WHERE ai.machine_key(machine_code) = '24'`)).map((n) => n['Index Name'])
    expect(used).toContain('inspection_sessions_machine_key_idx')
  })
})
