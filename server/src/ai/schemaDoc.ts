// ============================================================================
// §20 — the data dictionary the model reads: every view in schema ai with its
// columns, and the helper functions, written from the catalog and the
// comments migration 0031 puts on them. So the description can never drift
// from what the views really are.
//
// Deterministic on purpose (names sorted byte-wise, columns in their order):
// it is part of the system prompt, which the prompt cache and every stored
// conversation rely on staying byte-identical.
// ============================================================================

import type { Queryable } from '../db/pool'
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

/** The views and functions of schema ai, as text. Read with the API's own pool, not the reader's. */
export async function describeAiSchema(q: Queryable): Promise<string> {
  const views = await q.query<ViewRow>(
    `SELECT c.relname AS name, obj_description(c.oid, 'pg_class') AS comment
       FROM pg_class c
      WHERE c.relnamespace = 'ai'::regnamespace AND c.relkind IN ('v', 'm')
      ORDER BY c.relname COLLATE "C"`,
  )
  const columns = await q.query<ColumnRow>(
    `SELECT c.relname AS view, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
            col_description(c.oid, a.attnum) AS comment
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relnamespace = 'ai'::regnamespace AND c.relkind IN ('v', 'm') AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname COLLATE "C", a.attnum`,
  )
  // The runner's row check lives in ai so the reader may call it, but the model never needs it.
  const functions = await q.query<FunctionRow>(
    `SELECT p.proname AS name, pg_get_function_arguments(p.oid) AS args, pg_get_function_result(p.oid) AS result,
            obj_description(p.oid, 'pg_proc') AS comment
       FROM pg_proc p
      WHERE p.pronamespace = 'ai'::regnamespace AND p.proname <> $1
      ORDER BY p.proname COLLATE "C", pg_get_function_arguments(p.oid) COLLATE "C"`,
    [ROW_SIZE_CHECK],
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
