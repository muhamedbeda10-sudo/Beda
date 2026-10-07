// ============================================================================
// Excel's column filter and sort, answered in SQL over the whole record. A
// list declares its columns once — the SQL that gives each cell's text (what
// the menu lists, ticks and searches) and, for figures and dates, the value it
// sorts by — and the request's filters become WHERE clauses and ORDER BY on
// those expressions, every value bound as a parameter. A column the list did
// not declare is refused.
// ============================================================================

import { z } from 'zod'
import { COLUMN_VALUES_LIMIT, type ColumnFilters, type ColumnSort, type ColumnValuesResponse } from '@qc/shared/api'
import type { Queryable } from '../db/pool'
import { badRequest } from './errors'

export interface SqlColumn {
  /** The cell's text, as the table shows it. */
  text: string
  /** What it sorts by when that is not the text: a number or a timestamp. */
  sort?: string
}

export type SqlColumns = Record<string, SqlColumn>

const filterSchema = z.object({
  values: z.array(z.string().max(4000)).max(2000).optional(),
  except: z.array(z.string().max(4000)).max(2000).optional(),
  contains: z.string().trim().max(200).optional(),
})

/** `cf` is the column filters as JSON; `sort` is "key:asc" or "key:desc". */
export const columnQuerySchema = z.object({
  cf: z
    .string()
    .max(200_000)
    .optional()
    .transform((v, ctx) => {
      if (!v) return {} as ColumnFilters
      try {
        const parsed = z.record(z.string().max(60), filterSchema).safeParse(JSON.parse(v))
        if (parsed.success) return parsed.data as ColumnFilters
      } catch {
        /* reported below */
      }
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'The column filters could not be read.' })
      return z.NEVER
    }),
  sort: z
    .string()
    .regex(/^[A-Za-z0-9_:.-]{1,60}:(asc|desc)$/, 'A sort is "column:asc" or "column:desc".')
    .optional()
    .transform((v): ColumnSort | undefined => {
      if (!v) return undefined
      const i = v.lastIndexOf(':')
      return { key: v.slice(0, i), dir: v.slice(i + 1) as 'asc' | 'desc' }
    }),
})

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

function columnOf(columns: SqlColumns, key: string): SqlColumn {
  const c = Object.prototype.hasOwnProperty.call(columns, key) ? columns[key] : undefined
  if (!c) throw badRequest(`There is no column "${key}" to filter or sort by.`)
  return c
}

/** The WHERE clauses of the column filters, all but `except` (a column's own list leaves its own filter out). */
export function columnFilterClauses(columns: SqlColumns, filters: ColumnFilters, p: (v: unknown) => string, except?: string): string[] {
  const out: string[] = []
  for (const [key, f] of Object.entries(filters)) {
    if (key === except) continue
    const c = columnOf(columns, key)
    if (f.values) out.push(f.values.length === 0 ? 'false' : `COALESCE(${c.text}, '') = ANY(${p(f.values)}::text[])`)
    if (f.except?.length) out.push(`COALESCE(${c.text}, '') <> ALL(${p(f.except)}::text[])`)
    if (f.contains) out.push(`COALESCE(${c.text}, '') ILIKE ${p(`%${escapeLike(f.contains)}%`)}`)
  }
  return out
}

/** The ORDER BY: the column chosen, blanks last either way, then the list's own order to break ties. */
export function columnOrderBy(columns: SqlColumns, sort: ColumnSort | undefined, fallback: string): string {
  if (!sort) return fallback
  const c = columnOf(columns, sort.key)
  const by = c.sort ?? `NULLIF(${c.text}, '')`
  return `${by} ${sort.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, ${fallback}`
}

/**
 * The values of one column under every filter but its own, with how many rows
 * carry each, in the column's order; `search` narrows them. `from` is the
 * list's FROM and joins; `where` its clauses so far, over `params`.
 */
export async function columnValues(
  db: Queryable,
  input: { columns: SqlColumns; column: string; from: string; where: string[]; params: unknown[]; filters: ColumnFilters; search?: string },
): Promise<ColumnValuesResponse> {
  const c = columnOf(input.columns, input.column)
  const params = [...input.params]
  const p = (v: unknown) => `$${params.push(v)}`
  const where = [...input.where, ...columnFilterClauses(input.columns, input.filters, p, input.column)]
  if (input.search?.trim()) where.push(`COALESCE(${c.text}, '') ILIKE ${p(`%${escapeLike(input.search.trim())}%`)}`)
  const order = c.sort ? `min(${c.sort}) NULLS LAST, 1` : `1`
  const { rows } = await db.query<{ value: string; count: number }>(
    `SELECT COALESCE(${c.text}, '') AS value, count(*)::int AS count
       ${input.from}
      WHERE ${where.length ? where.join(' AND ') : 'true'}
      GROUP BY 1
      ORDER BY ${order}
      LIMIT ${COLUMN_VALUES_LIMIT + 1}`,
    params,
  )
  return { values: rows.slice(0, COLUMN_VALUES_LIMIT), truncated: rows.length > COLUMN_VALUES_LIMIT }
}
