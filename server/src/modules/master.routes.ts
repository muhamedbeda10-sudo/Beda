// ============================================================================
// §7 — master data the wizard depends on. One generic CRUD over seven small
// tables, each described by a definition below: its columns, its validation
// schema and which filters a screen may apply. Reads are open to every
// signed-in role (the wizard pre-fills from them); writes are admin-only and
// audited; deletes are soft.
// ============================================================================

import { Router } from 'express'
import { z, type ZodTypeAny } from 'zod'
import { MASTER_KINDS, type ImportResult, type MasterKind } from '@qc/shared/api'
import { PT_CONSUMABLE_KINDS } from '@qc/shared/types'
import type { AppContext } from '../context'
import { withTransaction, PG, pgCode, type Queryable } from '../db/pool'
import { badRequest, duplicate, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { requireCapability, requireUser } from '../auth/middleware'
import { auditChanges, auditCreate, auditDelete, writeAudit } from '../audit/service'
import { dropNulls } from '../lib/rows'

interface ColumnDef {
  /** camelCase name in the domain model */
  field: string
  /** snake_case column */
  column: string
}

interface MasterDef {
  table: string
  entity: string
  columns: ColumnDef[]
  schema: ZodTypeAny
  filters: Record<string, string>
  orderBy: string
  /** Human name of the business key, for the duplicate message. */
  keyLabel: string
}

const text = (max = 200) => z.string().trim().min(1).max(max)
const optText = (max = 500) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null))
const num = () => z.coerce.number().finite()
const optNum = () => z.union([z.coerce.number().finite(), z.literal(''), z.null()]).optional().transform((v) => (v === '' || v === undefined ? null : v))

const DEFS: Record<MasterKind, MasterDef> = {
  machines: {
    table: 'machines',
    entity: 'Machine',
    keyLabel: 'display name',
    columns: [
      { field: 'code', column: 'code' },
      { field: 'name', column: 'name' },
      { field: 'line', column: 'line' },
      { field: 'displayName', column: 'display_name' },
      { field: 'machineNumber', column: 'machine_number' },
      { field: 'factory', column: 'factory' },
    ],
    schema: z.object({
      code: text(20),
      name: text(120),
      line: z.string().trim().max(60).default(''),
      displayName: text(200),
      machineNumber: optText(60),
      factory: optText(120),
    }),
    filters: {},
    orderBy: 'code, line',
  },
  'item-dimension-order': {
    table: 'item_dimension_order',
    entity: 'ItemDimensionOrder',
    keyLabel: 'item + dimension name',
    columns: [
      { field: 'item', column: 'item' },
      { field: 'dimensionName', column: 'dimension_name' },
      { field: 'sequence', column: 'sequence' },
      { field: 'nominal', column: 'nominal' },
      { field: 'tolPlus', column: 'tol_plus' },
      { field: 'tolMinus', column: 'tol_minus' },
      { field: 'unit', column: 'unit' },
    ],
    schema: z.object({
      item: text(200),
      dimensionName: text(200),
      sequence: z.coerce.number().int().min(1),
      nominal: optNum(),
      tolPlus: num().min(0),
      tolMinus: num().min(0),
      unit: z.string().trim().max(20).default('mm'),
    }),
    filters: { item: 'item' },
    orderBy: 'item, sequence',
  },
  'item-dimension-master': {
    table: 'item_dimension_master',
    entity: 'ItemDimensionMaster',
    keyLabel: 'item + dimension name',
    columns: [
      { field: 'item', column: 'item' },
      { field: 'dimensionName', column: 'dimension_name' },
      { field: 'nominal', column: 'nominal' },
      { field: 'tolPlus', column: 'tol_plus' },
      { field: 'tolMinus', column: 'tol_minus' },
      { field: 'unit', column: 'unit' },
    ],
    schema: z.object({
      item: text(200),
      dimensionName: text(200),
      nominal: optNum(),
      tolPlus: num().min(0),
      tolMinus: num().min(0),
      unit: z.string().trim().max(20).default('mm'),
    }),
    filters: { item: 'item' },
    orderBy: 'item, dimension_name',
  },
  'item-reference-images': {
    table: 'item_reference_images',
    entity: 'ItemReferenceImage',
    keyLabel: 'reference image',
    columns: [
      { field: 'item', column: 'item' },
      { field: 'imageId', column: 'image_id' },
      { field: 'caption', column: 'caption' },
    ],
    schema: z.object({ item: text(200), imageId: z.string().uuid(), caption: optText(300) }),
    filters: { item: 'item' },
    orderBy: 'item, created_at',
  },
  'work-center-defects': {
    table: 'work_center_defects',
    entity: 'WorkCenterDefect',
    keyLabel: 'work centre + defect name',
    columns: [
      { field: 'workCenterCode', column: 'work_center_code' },
      { field: 'defectName', column: 'defect_name' },
    ],
    schema: z.object({ workCenterCode: text(20), defectName: text(200) }),
    filters: { workCenterCode: 'work_center_code' },
    orderBy: 'work_center_code, defect_name',
  },
  'grade-mappings': {
    table: 'grade_mappings',
    entity: 'GradeMapping',
    keyLabel: 'grade pair',
    columns: [
      { field: 'gradeA', column: 'grade_a' },
      { field: 'gradeB', column: 'grade_b' },
    ],
    schema: z.object({ gradeA: text(60), gradeB: text(60) }),
    filters: {},
    orderBy: 'grade_a, grade_b',
  },
  'pt-consumables': {
    table: 'pt_consumables',
    entity: 'PTConsumableProduct',
    keyLabel: 'consumable',
    columns: [
      { field: 'kind', column: 'kind' },
      { field: 'productName', column: 'product_name' },
      { field: 'lotBatch', column: 'lot_batch' },
    ],
    schema: z.object({
      kind: z.enum(PT_CONSUMABLE_KINDS as unknown as [string, ...string[]]),
      productName: text(200),
      lotBatch: text(100),
    }),
    filters: {},
    orderBy: 'kind, product_name, lot_batch',
  },
}

function selectList(def: MasterDef): string {
  return ['id', ...def.columns.map((c) => `${c.column} AS "${c.field}"`), 'deleted_at AS "deletedAt"'].join(', ')
}

function kindOf(param: string): MasterDef {
  if (!(MASTER_KINDS as readonly string[]).includes(param)) throw notFound('That master-data table')
  return DEFS[param as MasterKind]
}

async function fetchOne(q: Queryable, def: MasterDef, id: string, lock = false) {
  const { rows } = await q.query<Record<string, unknown>>(
    `SELECT ${selectList(def)} FROM ${def.table} WHERE id = $1 AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [id],
  )
  return rows[0] ? dropNulls(rows[0]) : null
}

function translateWriteError(e: unknown, def: MasterDef): never {
  const code = pgCode(e)
  if (code === PG.UNIQUE_VIOLATION) throw duplicate(`A record with that ${def.keyLabel} already exists.`)
  if (code === PG.FOREIGN_KEY_VIOLATION) throw badRequest('That record refers to something that does not exist.')
  if (code === PG.CHECK_VIOLATION) throw badRequest('One of the values is out of range.')
  throw e
}

export function masterRoutes(ctx: AppContext): Router {
  const r = Router()
  const uuid = z.string().uuid()

  r.get('/:kind', async (req, res) => {
    const def = kindOf(String(req.params.kind))
    const where: string[] = ['deleted_at IS NULL']
    const params: unknown[] = []
    for (const [q, column] of Object.entries(def.filters)) {
      const v = req.query[q]
      if (typeof v === 'string' && v !== '') {
        params.push(v)
        where.push(`${column} = $${params.length}`)
      }
    }
    const { rows } = await ctx.db.query<Record<string, unknown>>(
      `SELECT ${selectList(def)} FROM ${def.table} WHERE ${where.join(' AND ')} ORDER BY ${def.orderBy} LIMIT 5000`,
      params,
    )
    res.json(rows.map(dropNulls))
  })

  r.post('/:kind', requireCapability('manage-admin-data'), async (req, res) => {
    const def = kindOf(String(req.params.kind))
    const user = requireUser(req)
    const body = parse(def.schema, req.body) as Record<string, unknown>
    const row = await withTransaction(ctx.db, async (tx) => {
      const cols = def.columns.map((c) => c.column)
      const vals = def.columns.map((c) => body[c.field] ?? null)
      let created: Record<string, unknown>
      try {
        created = (
          await tx.query<Record<string, unknown>>(
            `INSERT INTO ${def.table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING ${selectList(def)}`,
            vals,
          )
        ).rows[0]
      } catch (e) {
        translateWriteError(e, def)
      }
      await auditCreate(tx, { userId: user.id, userName: user.name, entity: def.entity, entityId: String(created.id) })
      return dropNulls(created)
    })
    res.status(201).json(row)
  })

  r.put('/:kind/:id', requireCapability('manage-admin-data'), async (req, res) => {
    const def = kindOf(String(req.params.kind))
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const body = parse(def.schema, req.body) as Record<string, unknown>
    const row = await withTransaction(ctx.db, async (tx) => {
      const before = await fetchOne(tx, def, id, true)
      if (!before) throw notFound('That record')
      const sets = def.columns.map((c, i) => `${c.column} = $${i + 2}`)
      const vals = def.columns.map((c) => body[c.field] ?? null)
      let after: Record<string, unknown>
      try {
        after = (
          await tx.query<Record<string, unknown>>(
            `UPDATE ${def.table} SET ${sets.join(', ')} WHERE id = $1 RETURNING ${selectList(def)}`,
            [id, ...vals],
          )
        ).rows[0]
      } catch (e) {
        translateWriteError(e, def)
      }
      await auditChanges(tx, { userId: user.id, userName: user.name, entity: def.entity, entityId: id }, before, dropNulls(after))
      return dropNulls(after)
    })
    res.json(row)
  })

  /**
   * §7.7 — bulk upsert of the per-item dimension configuration ("production
   * data"), matched on item + dimension name without regard to case. Rows the
   * file does not mention are left alone; a field the file does not carry
   * keeps its stored value.
   */
  r.post('/item-dimension-order/import', requireCapability('manage-admin-data'), async (req, res) => {
    const user = requireUser(req)
    const rowSchema = z.object({
      item: text(200),
      dimensionName: text(200),
      sequence: z.coerce.number().int().min(1).optional(),
      nominal: z.coerce.number().finite().optional(),
      tolPlus: z.coerce.number().min(0).optional(),
      tolMinus: z.coerce.number().min(0).optional(),
      unit: z.string().trim().max(20).optional(),
    })
    const { rows } = parse(z.object({ rows: z.array(rowSchema).min(1).max(1000) }), req.body)
    const byKey = new Map<string, z.infer<typeof rowSchema>>()
    for (const row of rows) byKey.set(`${row.item.toLowerCase()}||${row.dimensionName.toLowerCase()}`, row)
    const payload = JSON.stringify(
      Array.from(byKey.values()).map((d) => ({
        item: d.item,
        dimension_name: d.dimensionName,
        sequence: d.sequence ?? null,
        nominal: d.nominal ?? null,
        tol_plus: d.tolPlus ?? null,
        tol_minus: d.tolMinus ?? null,
        unit: d.unit ?? null,
      })),
    )
    const recordset = `jsonb_to_recordset($1::jsonb) AS i(
      item text, dimension_name text, sequence integer, nominal numeric, tol_plus numeric, tol_minus numeric, unit text)`
    const result = await withTransaction(ctx.db, async (tx) => {
      const updated = await tx.query(
        `UPDATE item_dimension_order t SET
            sequence = COALESCE(i.sequence, t.sequence), nominal = COALESCE(i.nominal, t.nominal),
            tol_plus = COALESCE(i.tol_plus, t.tol_plus), tol_minus = COALESCE(i.tol_minus, t.tol_minus),
            unit = COALESCE(i.unit, t.unit)
          FROM ${recordset}
         WHERE t.deleted_at IS NULL AND lower(t.item) = lower(i.item) AND lower(t.dimension_name) = lower(i.dimension_name)`,
        [payload],
      )
      const inserted = await tx.query(
        `INSERT INTO item_dimension_order (item, dimension_name, sequence, nominal, tol_plus, tol_minus, unit)
         SELECT i.item, i.dimension_name, COALESCE(i.sequence, 1), i.nominal, COALESCE(i.tol_plus, 0), COALESCE(i.tol_minus, 0), COALESCE(i.unit, 'mm')
           FROM ${recordset}
          WHERE NOT EXISTS (
            SELECT 1 FROM item_dimension_order t
             WHERE t.deleted_at IS NULL AND lower(t.item) = lower(i.item) AND lower(t.dimension_name) = lower(i.dimension_name))`,
        [payload],
      )
      await writeAudit(tx, [
        {
          at: new Date().toISOString(),
          userId: user.id,
          userName: user.name,
          action: 'update',
          entity: 'ItemDimensionOrder',
          entityId: 'bulk-import',
          field: 'import',
          newValue: `${inserted.rowCount ?? 0} inserted, ${updated.rowCount ?? 0} updated`,
        },
      ])
      const body: ImportResult = { inserted: inserted.rowCount ?? 0, updated: updated.rowCount ?? 0 }
      return body
    })
    res.json(result)
  })

  r.delete('/:kind/:id', requireCapability('manage-admin-data'), async (req, res) => {
    const def = kindOf(String(req.params.kind))
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    await withTransaction(ctx.db, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE ${def.table} SET deleted_at = now(), deleted_by_id = $2 WHERE id = $1 AND deleted_at IS NULL`,
        [id, user.id],
      )
      if (!rowCount) throw notFound('That record')
      await auditDelete(tx, { userId: user.id, userName: user.name, entity: def.entity, entityId: id })
    })
    res.status(204).end()
  })

  return r
}
