// ============================================================================
// §20 — the data dictionary the model reads: the views in schema ai a person
// may read, with their columns, and the helper functions, written from the
// catalog and the comments migrations 0031–0039 put on them. So the
// description can never drift from what the views really are, nor promise
// views the person's roles cannot select: which objects are described is
// read from the grants of the base role and of the person's domain roles.
//
// Deterministic on purpose (names sorted byte-wise, columns in their order):
// it is part of the system prompt, which the prompt cache and every stored
// conversation rely on staying byte-identical.
// ============================================================================

import { AI_DOMAIN_IDS, type AiDomain } from '@qc/shared/ai'
import type { Queryable } from '../db/pool'
import { domainRole, type AiRoleDomain } from './domains'
import { ROW_SIZE_CHECK } from './runQuery'

interface ViewRow {
  name: string
  comment: string | null
}

interface ColumnRow {
  view: string
  name: string
  type: string
  comment: string | null
}

interface FunctionRow {
  name: string
  args: string
  result: string
  comment: string | null
}

/** One line of text: comments may hold line breaks. */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * The views and functions of schema ai that these domains may read (every
 * domain unless given), as text. Read with the API's own pool, not a
 * reader's: the grants are what decide, whoever reads them.
 */
export async function describeAiSchema(q: Queryable, domains: readonly AiDomain[] = AI_DOMAIN_IDS): Promise<string> {
  const { rows } = await q.query<{ database: string }>(`SELECT current_database() AS database`)
  const roles = (['base', ...domains] as AiRoleDomain[]).map((d) => domainRole(rows[0].database, d))
  const views = await q.query<ViewRow>(
    `SELECT c.relname AS name, obj_description(c.oid, 'pg_class') AS comment
       FROM pg_class c
      WHERE c.relnamespace = 'ai'::regnamespace AND c.relkind IN ('v', 'm')
        AND EXISTS (SELECT 1 FROM unnest($1::text[]) r(name) JOIN pg_roles g ON g.rolname = r.name WHERE has_table_privilege(g.oid, c.oid, 'SELECT'))
      ORDER BY c.relname COLLATE "C"`,
    [roles],
  )
  const columns = await q.query<ColumnRow>(
    `SELECT c.relname AS view, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
            col_description(c.oid, a.attnum) AS comment
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relnamespace = 'ai'::regnamespace AND c.relkind IN ('v', 'm') AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname COLLATE "C", a.attnum`,
  )
  // The runner's row check lives in ai so the readers may call it, but the model never needs it.
  const functions = await q.query<FunctionRow>(
    `SELECT p.proname AS name, pg_get_function_arguments(p.oid) AS args, pg_get_function_result(p.oid) AS result,
            obj_description(p.oid, 'pg_proc') AS comment
       FROM pg_proc p
      WHERE p.pronamespace = 'ai'::regnamespace AND p.proname <> $1
        AND EXISTS (SELECT 1 FROM unnest($2::text[]) r(name) JOIN pg_roles g ON g.rolname = r.name WHERE has_function_privilege(g.oid, p.oid, 'EXECUTE'))
      ORDER BY p.proname COLLATE "C", pg_get_function_arguments(p.oid) COLLATE "C"`,
    [ROW_SIZE_CHECK, roles],
  )

  const byView = new Map<string, ColumnRow[]>()
  for (const c of columns.rows) {
    const list = byView.get(c.view)
    if (list) list.push(c)
    else byView.set(c.view, [c])
  }

  const out: string[] = ['## Views (schema ai)', '']
  for (const v of views.rows) {
    out.push(`### ai.${v.name}`)
    if (v.comment) out.push(oneLine(v.comment))
    for (const c of byView.get(v.name) ?? []) {
      out.push(c.comment ? `- ${c.name} ${c.type}: ${oneLine(c.comment)}` : `- ${c.name} ${c.type}`)
    }
    out.push('')
  }
  out.push('## Functions (schema ai)', '')
  for (const f of functions.rows) {
    out.push(`### ai.${f.name}(${f.args}) returns ${f.result}`)
    if (f.comment) out.push(oneLine(f.comment))
    out.push('')
  }
  return out.join('\n').trimEnd()
}
