// ============================================================================
// §23 — the values a notice can be aimed at, from the same sources the
// Notices page's editor offers: the machine register (machines, factories),
// the processes, the shifts, the roles that receive notices, the live
// accounts, and the order sheet (order numbers, order lines, item codes,
// customers). find_notice_targets looks them up for the assistant; a card's
// targets are resolved against them, so a notice never names a value that
// does not exist, and each target carries the label people read — the
// assistant never writes one.
// ============================================================================

import { z } from 'zod'
import { normaliseMachineCode, shiftName } from '@qc/shared/rules'
import { NOTICE_TARGET_KINDS, PROCESSES, PROCESS_LABEL, type NoticeTarget, type NoticeTargetKind, type Process, type Role } from '@qc/shared/types'
import type { Queryable } from '../db/pool'
import { cancelledSql } from '../lib/orderStatus'
import { isUuid } from '../automations/people'
import { NOTICE_READER_ROLES } from './view'

/** At most this many values a lookup hands back. */
export const MAX_TARGET_CANDIDATES = 50
const ORDER_QUERY_MIN_CHARS = 2

/** A value a notice can be aimed at, as the editor lists it. */
export interface TargetCandidate {
  value: string
  label: string
  /** What tells two alike apart: a machine's factory, a person's username and role, an order's customer and machine. */
  detail?: string
}

const SHIFTS = ['A', 'B', 'C'] as const
const roleLabel = (r: string) => r.charAt(0).toUpperCase() + r.slice(1)
const shiftLabel = (s: (typeof SHIFTS)[number]) => `${s} · ${shiftName(s)}`

/** A LIKE pattern matching values that start with `term`, wildcards escaped (the order sheet's indexes serve it). */
const likePrefix = (term: string) => `${term.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
/** A LIKE pattern matching values that contain `term`, wildcards escaped. */
const likeAnywhere = (term: string) => `%${term.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`

const contains = (haystack: string, needle: string) => haystack.toLowerCase().includes(needle.toLowerCase())

const NOT_CANCELLED = `NOT ${cancelledSql('erp_status')}`

export const FindTargetsInput = z
  .object({
    kind: z.enum(NOTICE_TARGET_KINDS as unknown as [NoticeTargetKind, ...NoticeTargetKind[]]),
    query: z
      .string()
      .max(120)
      .nullish()
      .transform((v) => v?.trim() || undefined),
  })
  .strict()

/** What a lookup found: the values (at most MAX_TARGET_CANDIDATES), or why it needs more to go on. */
export type TargetLookup = { candidates: TargetCandidate[]; truncated: boolean } | { needsQuery: string }

/**
 * The values of one kind, narrowed by `query` (any part of the value or its
 * label; the start of it for the order sheet's numbers and codes, which are
 * tens of thousands). The order sheet is searched only with a query.
 */
export async function findTargets(q: Queryable, kind: NoticeTargetKind, query?: string): Promise<TargetLookup> {
  const term = query ?? ''
  const narrow = (list: TargetCandidate[]) => (term ? list.filter((c) => contains(`${c.value} ${c.label} ${c.detail ?? ''}`, term)) : list)
  const bounded = (list: TargetCandidate[]) => ({ candidates: list.slice(0, MAX_TARGET_CANDIDATES), truncated: list.length > MAX_TARGET_CANDIDATES })
  const orderQuery = () => (term.length >= ORDER_QUERY_MIN_CHARS ? null : { needsQuery: `Give query: at least ${ORDER_QUERY_MIN_CHARS} characters of the ${kind === 'customer' ? "customer's name" : kind === 'item-code' ? 'item code' : 'order number'}.` })
  switch (kind) {
    case 'process':
      return bounded(narrow(PROCESSES.map((p) => ({ value: p, label: PROCESS_LABEL[p] }))))
    case 'shift':
      return bounded(narrow(SHIFTS.map((s) => ({ value: s, label: shiftLabel(s) }))))
    case 'role':
      return bounded(narrow(NOTICE_READER_ROLES.map((r) => ({ value: r, label: roleLabel(r) }))))
    case 'factory':
      return bounded(narrow((await factories(q)).map((f) => ({ value: f, label: f }))))
    case 'machine': {
      const rows = await machines(q)
      return bounded(narrow(rows.map((m) => ({ value: m.code, label: m.displayName, ...(m.factory ? { detail: m.factory } : {}) }))))
    }
    case 'user': {
      const { rows } = await q.query<{ id: string; name: string; username: string; role: Role }>(
        `SELECT id, name, username, role FROM users WHERE is_active AND deleted_at IS NULL AND NOT is_system ORDER BY lower(name), username`,
      )
      return bounded(narrow(rows.map((u) => ({ value: u.id, label: u.name, detail: `${u.username} · ${u.role}` }))))
    }
    case 'order-number': {
      const needs = orderQuery()
      if (needs) return needs
      const { rows } = await q.query<{ orderNumber: string; customer: string; items: number; machines: string }>(
        `SELECT order_number AS "orderNumber", max(customer) AS customer, count(*)::int AS items,
                string_agg(DISTINCT work_center_code, ', ' ORDER BY work_center_code) AS machines
           FROM production_orders
          WHERE deleted_at IS NULL AND ${NOT_CANCELLED} AND lower(order_number) LIKE $1
          GROUP BY order_number ORDER BY order_number LIMIT $2`,
        [likePrefix(term), MAX_TARGET_CANDIDATES + 1],
      )
      return bounded(rows.map((o) => ({ value: o.orderNumber, label: o.orderNumber, detail: `${o.customer || '—'} · ${o.items} line${o.items === 1 ? '' : 's'} · machine ${o.machines || '—'}` })))
    }
    case 'order-line': {
      const needs = orderQuery()
      if (needs) return needs
      const { rows } = await q.query<{ id: string; orderNumber: string; item: string; itemCode: string; workCenterCode: string; lineKey: string | null }>(
        `SELECT id, order_number AS "orderNumber", item, item_code AS "itemCode", work_center_code AS "workCenterCode", line_key AS "lineKey"
           FROM production_orders
          WHERE deleted_at IS NULL AND ${NOT_CANCELLED}
            AND (lower(order_number) LIKE $1 OR lower(item_code) LIKE $1 OR lower(line_key) LIKE $1)
          ORDER BY order_number, item_code, work_center_code LIMIT $2`,
        [likePrefix(term), MAX_TARGET_CANDIDATES + 1],
      )
      return bounded(rows.map((o) => ({ value: o.id, label: orderLineLabel(o), detail: `machine ${o.workCenterCode || '—'}${o.lineKey ? ` · line ${o.lineKey}` : ''}` })))
    }
    case 'item-code': {
      const needs = orderQuery()
      if (needs) return needs
      const { rows } = await q.query<{ itemCode: string; item: string }>(
        `SELECT item_code AS "itemCode", max(item) AS item FROM production_orders
          WHERE deleted_at IS NULL AND btrim(item_code) <> '' AND lower(item_code) LIKE $1
          GROUP BY item_code ORDER BY item_code LIMIT $2`,
        [likePrefix(term), MAX_TARGET_CANDIDATES + 1],
      )
      return bounded(rows.map((o) => ({ value: o.itemCode, label: o.itemCode, ...(o.item ? { detail: o.item } : {}) })))
    }
    case 'customer': {
      const needs = orderQuery()
      if (needs) return needs
      const { rows } = await q.query<{ customer: string; lines: number }>(
        `SELECT btrim(customer) AS customer, count(*)::int AS lines FROM production_orders
          WHERE deleted_at IS NULL AND btrim(customer) <> '' AND lower(customer) LIKE $1
          GROUP BY btrim(customer) ORDER BY btrim(customer) LIMIT $2`,
        [likeAnywhere(term), MAX_TARGET_CANDIDATES + 1],
      )
      return bounded(rows.map((c) => ({ value: c.customer, label: c.customer, detail: `${c.lines} order line${c.lines === 1 ? '' : 's'}` })))
    }
  }
}

const orderLineLabel = (o: { orderNumber: string; item: string; itemCode: string }) => `${o.orderNumber} · ${o.item} (${o.itemCode})`

async function machines(q: Queryable): Promise<{ code: string; displayName: string; factory: string | null }[]> {
  const { rows } = await q.query<{ code: string; displayName: string; factory: string | null }>(
    `SELECT code, display_name AS "displayName", NULLIF(btrim(factory), '') AS factory FROM machines WHERE deleted_at IS NULL ORDER BY lower(display_name), code`,
  )
  return rows
}

async function factories(q: Queryable): Promise<string[]> {
  const { rows } = await q.query<{ factory: string }>(
    `SELECT DISTINCT btrim(factory) AS factory FROM machines WHERE deleted_at IS NULL AND btrim(COALESCE(factory, '')) <> '' ORDER BY 1`,
  )
  return rows.map((r) => r.factory)
}

/** A target as the assistant wrote it: a kind and a value (any label it added is not taken). */
export interface TargetAsked {
  kind: NoticeTargetKind
  value: string
}

const keyOf = (t: { kind: string; value: string }) => `${t.kind}:${t.value.trim().toLowerCase()}`

/**
 * The targets with the values as the sources write them and the labels people
 * read, each once; or, for each one that names nothing that exists, what to do
 * instead. A target the notice already has (`kept`: a change) stays as it was
 * saved, label and all, even when its value is gone from the register since.
 */
export async function resolveTargets(q: Queryable, asked: readonly TargetAsked[], kept: readonly NoticeTarget[] = []): Promise<{ targets: NoticeTarget[]; errors: string[] }> {
  const targets: NoticeTarget[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  const keptByKey = new Map(kept.map((t) => [keyOf(t), t]))
  let machineList: Awaited<ReturnType<typeof machines>> | null = null
  let factoryList: string[] | null = null
  const add = (t: NoticeTarget) => {
    // The same value written twice (two spellings of one machine, say) is one target.
    const key = keyOf(t)
    if (seen.has(key)) return
    seen.add(key)
    targets.push(t)
  }
  for (const [i, t] of asked.entries()) {
    const where = `targets.${i}`
    const value = t.value.trim()
    const already = keptByKey.get(keyOf({ kind: t.kind, value }))
    if (already) {
      add(already)
      continue
    }
    const missing = (what: string) => errors.push(`${where}: ${what} Find the value with find_notice_targets (kind "${t.kind}") and use it exactly as it returns it.`)
    switch (t.kind) {
      case 'process': {
        const p = PROCESSES.find((x) => x === value.toLowerCase())
        if (p) add({ kind: 'process', value: p, label: PROCESS_LABEL[p as Process] })
        else missing(`"${value}" is not a process (they are ${PROCESSES.join(', ')}).`)
        break
      }
      case 'shift': {
        const s = SHIFTS.find((x) => x === value.toUpperCase())
        if (s) add({ kind: 'shift', value: s, label: shiftLabel(s) })
        else missing(`"${value}" is not a shift (they are A, B and C).`)
        break
      }
      case 'role': {
        const r = NOTICE_READER_ROLES.find((x) => x === value.toLowerCase())
        if (r) add({ kind: 'role', value: r, label: roleLabel(r) })
        else if (value.toLowerCase() === 'viewer') errors.push(`${where}: viewers do not receive notices, so a notice for them reaches nobody. Leave this target out.`)
        else missing(`"${value}" is not a role that receives notices (they are ${NOTICE_READER_ROLES.join(', ')}).`)
        break
      }
      case 'machine': {
        machineList ??= await machines(q)
        const m = machineList.find((x) => normaliseMachineCode(x.code) === normaliseMachineCode(value))
        if (m) add({ kind: 'machine', value: m.code, label: m.displayName })
        else missing(`no machine with the code "${value}" is in the register.`)
        break
      }
      case 'factory': {
        factoryList ??= await factories(q)
        const f = factoryList.find((x) => x.toLowerCase() === value.toLowerCase())
        if (f) add({ kind: 'factory', value: f, label: f })
        else missing(`no machine in the register is in a factory called "${value}".`)
        break
      }
      case 'user': {
        const { rows } = isUuid(value)
          ? await q.query<{ id: string; name: string }>(`SELECT id, name FROM users WHERE id = $1 AND is_active AND deleted_at IS NULL AND NOT is_system`, [value])
          : { rows: [] }
        if (rows[0]) add({ kind: 'user', value: rows[0].id, label: rows[0].name })
        else missing(isUuid(value) ? 'no active account has that id.' : `a person is named by their user id (a uuid), not "${value}".`)
        break
      }
      case 'order-line': {
        const { rows } = isUuid(value)
          ? await q.query<{ id: string; orderNumber: string; item: string; itemCode: string }>(
              `SELECT id, order_number AS "orderNumber", item, item_code AS "itemCode" FROM production_orders WHERE id = $1 AND deleted_at IS NULL`,
              [value],
            )
          : { rows: [] }
        if (rows[0]) add({ kind: 'order-line', value: rows[0].id, label: orderLineLabel(rows[0]) })
        else missing(isUuid(value) ? 'no order line has that id.' : `an order line is named by its id (a uuid), not "${value}".`)
        break
      }
      case 'order-number': {
        const { rows } = await q.query<{ v: string }>(`SELECT order_number AS v FROM production_orders WHERE deleted_at IS NULL AND lower(order_number) = lower($1) LIMIT 1`, [value])
        if (rows[0]) add({ kind: 'order-number', value: rows[0].v, label: rows[0].v })
        else missing(`no order "${value}" is in the order sheet.`)
        break
      }
      case 'item-code': {
        const { rows } = await q.query<{ v: string }>(`SELECT item_code AS v FROM production_orders WHERE deleted_at IS NULL AND lower(item_code) = lower($1) LIMIT 1`, [value])
        if (rows[0]) add({ kind: 'item-code', value: rows[0].v, label: rows[0].v })
        else missing(`no item code "${value}" is in the order sheet.`)
        break
      }
      case 'customer': {
        const { rows } = await q.query<{ v: string }>(
          `SELECT btrim(customer) AS v FROM production_orders WHERE deleted_at IS NULL AND lower(btrim(customer)) = lower($1) LIMIT 1`,
          [value],
        )
        if (rows[0]) add({ kind: 'customer', value: rows[0].v, label: rows[0].v })
        else missing(`no customer "${value}" is in the order sheet.`)
        break
      }
    }
  }
  return { targets, errors }
}
