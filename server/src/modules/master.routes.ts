// ============================================================================
// §7 — master data the wizard depends on. One generic CRUD over seven small
// tables, each described by a definition below: its columns, its validation
// schema and which filters a screen may apply. Reads are open to every
// signed-in role (the wizard pre-fills from them); writes are admin-only and
// audited; deletes are soft.
// ============================================================================

import { Router } from 'express'
import { z, type ZodTypeAny } from 'zod'
import { EXISTING_KEYS_MAX, MASTER_KINDS, type ExistingKeysResponse, type ImportResult, type MasterKind } from '@qc/shared/api'
import { PROCESSES, PT_CONSUMABLE_KINDS, type Process } from '@qc/shared/types'
import type { AppContext } from '../context'
import { withTransaction, PG, pgCode, type Queryable } from '../db/pool'
import { badRequest, duplicate, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { requirePermission, requireUser } from '../auth/middleware'
import { auditChanges, auditCreate, auditDelete, writeAudit } from '../audit/service'
import { dropNulls, normaliseKey } from '../lib/rows'

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
/** The process a machine runs, accepted in any case and with the shop's synonyms. */
const processSchema = z.preprocess(
  (v) => (typeof v === 'string' ? normaliseProcess(v) : v),
  z.enum(PROCESSES as unknown as [Process, ...Process[]]),
)
/**
 * The floor's four kinds of machine. Universal is everything that is not
 * welding, painting or roll forming: presses, benders, mast machines, others.
 */
export function normaliseProcess(raw: string): string {
  const v = raw.trim().toLowerCase()
  if (['universal', 'يونيفرسال', 'mast', 'ماست', 'press', 'مكبس', 'مكابس', 'bend', 'تناي', 'ثني', 'punch', 'other', 'أخرى', 'اخرى'].some((k) => v.includes(k))) return 'universal'
  if (['weld', 'welding', 'لحام'].some((k) => v.includes(k))) return 'welding'
  if (['paint', 'painting', 'coat', 'دهان'].some((k) => v.includes(k))) return 'paint'
  if (['form', 'forming', 'fabrication', 'roll', 'تشكيل'].some((k) => v.includes(k))) return 'forming'
  return v
}
/** A machine sheet without a process column: guess from the machine name, else universal — anything that is not the other three. */
function processFromName(name: string): Process {
  const guessed = normaliseProcess(name)
  return (PROCESSES as readonly string[]).includes(guessed) ? (guessed as Process) : 'universal'
}
const optText = (max = 500) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null))
const num = () => z.coerce.number().finite()
const optNum = () => z.union([z.coerce.number().finite(), z.literal(''), z.null()]).optional().transform((v) => (v === '' || v === undefined ? null : v))

const DEFS: Record<MasterKind, MasterDef> = {
  machines: {
    table: 'machines',
    entity: 'Machine',
    keyLabel: 'machine code or display name',
    columns: [
      { field: 'code', column: 'code' },
      { field: 'name', column: 'name' },
      { field: 'line', column: 'line' },
      { field: 'displayName', column: 'display_name' },
      { field: 'machineNumber', column: 'machine_number' },
      { field: 'factory', column: 'factory' },
      { field: 'process', column: 'process' },
      { field: 'usesItemDimensions', column: 'uses_item_dimensions' },
      { field: 'onDashboard', column: 'on_dashboard' },
      { field: 'coilRequired', column: 'coil_required' },
    ],
    schema: z.object({
      code: text(40),
      name: text(120),
      line: z.string().trim().max(60).default(''),
      displayName: text(200),
      machineNumber: optText(60),
      factory: optText(120),
      process: processSchema.default('forming'),
      usesItemDimensions: z.boolean().default(true),
      onDashboard: z.boolean().default(true),
      coilRequired: z.boolean().default(false),
    }),
    filters: { factory: 'factory' },
    orderBy: 'factory, code, line',
  },
  'item-dimension-order': {
    table: 'item_dimension_order',
    entity: 'ItemDimensionOrder',
    keyLabel: 'item code + dimension name + machine',
    columns: [
      { field: 'itemCode', column: 'item_code' },
      { field: 'item', column: 'item' },
      { field: 'workCenterCode', column: 'work_center_code' },
      { field: 'dimensionName', column: 'dimension_name' },
      { field: 'sequence', column: 'sequence' },
      { field: 'nominal', column: 'nominal' },
      { field: 'tolPlus', column: 'tol_plus' },
      { field: 'tolMinus', column: 'tol_minus' },
      { field: 'unit', column: 'unit' },
    ],
    schema: z.object({
      itemCode: text(120),
      item: z.string().trim().max(300).default(''),
      workCenterCode: optText(40),
      dimensionName: text(200),
      sequence: z.coerce.number().int().min(1),
      nominal: optNum(),
      tolPlus: num().min(0),
      tolMinus: num().min(0),
      unit: z.string().trim().max(20).default('mm'),
    }),
    filters: { itemCode: 'lower(item_code)', workCenterCode: 'lower(work_center_code)' },
    orderBy: 'lower(item_code), work_center_code NULLS FIRST, sequence',
  },
  'item-reference-images': {
    table: 'item_reference_images',
    entity: 'ItemReferenceImage',
    keyLabel: 'reference image',
    columns: [
      { field: 'itemCode', column: 'item_code' },
      { field: 'item', column: 'item' },
      { field: 'workCenterCode', column: 'work_center_code' },
      { field: 'imageId', column: 'image_id' },
      { field: 'caption', column: 'caption' },
    ],
    schema: z.object({
      itemCode: text(120),
      item: z.string().trim().max(300).default(''),
      workCenterCode: optText(40),
      imageId: z.string().uuid(),
      caption: optText(300),
    }),
    filters: { itemCode: 'lower(item_code)', workCenterCode: 'lower(work_center_code)' },
    orderBy: 'lower(item_code), work_center_code NULLS FIRST, created_at',
  },
  'work-center-defects': {
    table: 'work_center_defects',
    entity: 'WorkCenterDefect',
    keyLabel: 'machine + defect name',
    columns: [
      { field: 'workCenterCode', column: 'work_center_code' },
      { field: 'defectName', column: 'defect_name' },
    ],
    schema: z.object({ workCenterCode: text(40), defectName: text(200) }),
    filters: { workCenterCode: 'lower(work_center_code)' },
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

/** The importer's composite key for a dimension row, normalised like the API compares it. */
function dimensionKey(itemCode: string, dimensionName: string, workCenterCode: string | undefined): string {
  return `${normaliseKey(itemCode)}||${normaliseKey(dimensionName)}||${normaliseKey(workCenterCode ?? '')}`
}

/** The label the shop floor recognises: "58-A. Welding Line-LM4". */
export function machineDisplayName(code: string, name: string, line: string | undefined): string {
  return [code.trim(), name.trim(), (line ?? '').trim()].filter(Boolean).join('-')
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
    for (const [q, expression] of Object.entries(def.filters)) {
      const v = req.query[q]
      if (typeof v === 'string' && v !== '') {
        // Codes are matched without regard to case (the expression says so).
        params.push(expression.startsWith('lower(') ? v.trim().toLowerCase() : v)
        where.push(`${expression} = $${params.length}`)
      }
    }
    const { rows } = await ctx.db.query<Record<string, unknown>>(
      `SELECT ${selectList(def)} FROM ${def.table} WHERE ${where.join(' AND ')} ORDER BY ${def.orderBy} LIMIT 5000`,
      params,
    )
    res.json(rows.map(dropNulls))
  })

  r.post('/:kind', requirePermission('manage-configuration'), async (req, res) => {
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

  r.put('/:kind/:id', requirePermission('manage-configuration'), async (req, res) => {
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

  // ---- Bulk importers (§7.7) ----------------------------------------------
  // Each is an idempotent upsert on its business key, matched without regard
  // to case. Rows the file does not mention are left alone; a field the file
  // does not carry keeps its stored value; a soft-deleted row named by the
  // file comes back, because the sheet says it is current.

  const existingKeysSchema = z.object({ keys: z.array(z.string().trim().min(1)).max(EXISTING_KEYS_MAX) })
  const importAudit = (userId: string, userName: string, entity: string, inserted: number, updated: number) =>
    ({
      at: new Date().toISOString(),
      userId,
      userName,
      action: 'update' as const,
      entity,
      entityId: 'bulk-import',
      field: 'import',
      newValue: `${inserted} inserted, ${updated} updated`,
    })

  /** Dimension configuration, keyed by item code + dimension name + machine
   *  (empty machine = every machine). */
  r.post('/item-dimension-order/import', requirePermission('manage-configuration'), async (req, res) => {
    const user = requireUser(req)
    const rowSchema = z.object({
      itemCode: text(120),
      item: z.string().trim().max(300).optional(),
      workCenterCode: z.string().trim().max(40).optional(),
      dimensionName: text(200),
      sequence: z.coerce.number().int().min(1).optional(),
      nominal: z.coerce.number().finite().optional(),
      tolPlus: z.coerce.number().min(0).optional(),
      tolMinus: z.coerce.number().min(0).optional(),
      unit: z.string().trim().max(20).optional(),
    })
    const { rows } = parse(z.object({ rows: z.array(rowSchema).min(1).max(1000) }), req.body)
    const byKey = new Map<string, z.infer<typeof rowSchema>>()
    for (const row of rows) byKey.set(dimensionKey(row.itemCode, row.dimensionName, row.workCenterCode), row)
    const payload = JSON.stringify(
      Array.from(byKey.values()).map((d) => ({
        item_code: d.itemCode,
        item: d.item ?? null,
        work_center_code: d.workCenterCode ? d.workCenterCode : null,
        dimension_name: d.dimensionName,
        sequence: d.sequence ?? null,
        nominal: d.nominal ?? null,
        tol_plus: d.tolPlus ?? null,
        tol_minus: d.tolMinus ?? null,
        unit: d.unit ?? null,
      })),
    )
    const recordset = `jsonb_to_recordset($1::jsonb) AS i(
      item_code text, item text, work_center_code text, dimension_name text, sequence integer, nominal numeric, tol_plus numeric, tol_minus numeric, unit text)`
    const match = `lower(t.item_code) = lower(i.item_code) AND lower(t.dimension_name) = lower(i.dimension_name)
                   AND COALESCE(lower(t.work_center_code), '') = COALESCE(lower(i.work_center_code), '')`
    const result = await withTransaction(ctx.db, async (tx) => {
      const updated = await tx.query(
        `UPDATE item_dimension_order t SET
            item = COALESCE(i.item, t.item), sequence = COALESCE(i.sequence, t.sequence), nominal = COALESCE(i.nominal, t.nominal),
            tol_plus = COALESCE(i.tol_plus, t.tol_plus), tol_minus = COALESCE(i.tol_minus, t.tol_minus),
            unit = COALESCE(i.unit, t.unit)
          FROM ${recordset}
         WHERE t.deleted_at IS NULL AND ${match}`,
        [payload],
      )
      const inserted = await tx.query(
        `INSERT INTO item_dimension_order (item_code, item, work_center_code, dimension_name, sequence, nominal, tol_plus, tol_minus, unit)
         SELECT i.item_code, COALESCE(i.item, ''), i.work_center_code, i.dimension_name, COALESCE(i.sequence, 1), i.nominal,
                COALESCE(i.tol_plus, 0), COALESCE(i.tol_minus, 0), COALESCE(i.unit, 'mm')
           FROM ${recordset}
          WHERE NOT EXISTS (SELECT 1 FROM item_dimension_order t WHERE t.deleted_at IS NULL AND ${match})`,
        [payload],
      )
      await writeAudit(tx, [importAudit(user.id, user.name, 'ItemDimensionOrder', inserted.rowCount ?? 0, updated.rowCount ?? 0)])
      const body: ImportResult = { inserted: inserted.rowCount ?? 0, updated: updated.rowCount ?? 0 }
      return body
    })
    res.json(result)
  })

  r.post('/item-dimension-order/existing-keys', requirePermission('manage-configuration'), async (req, res) => {
    const { keys } = parse(existingKeysSchema, req.body)
    const wanted = Array.from(new Set(keys.map(normaliseKey)))
    const { rows } = await ctx.db.query<{ key: string }>(
      `SELECT lower(item_code) || '||' || lower(dimension_name) || '||' || COALESCE(lower(work_center_code), '') AS key
         FROM item_dimension_order
        WHERE deleted_at IS NULL
          AND lower(item_code) || '||' || lower(dimension_name) || '||' || COALESCE(lower(work_center_code), '') = ANY($1::text[])`,
      [wanted],
    )
    const body: ExistingKeysResponse = { existing: rows.map((x) => x.key) }
    res.json(body)
  })

  /** The machine register, keyed by machine code. */
  r.post('/machines/import', requirePermission('manage-configuration'), async (req, res) => {
    const user = requireUser(req)
    const rowSchema = z.object({
      code: text(40),
      name: text(120),
      line: z.string().trim().max(60).optional(),
      displayName: z.string().trim().max(200).optional(),
      machineNumber: z.string().trim().max(60).optional(),
      factory: z.string().trim().max(120).optional(),
      process: processSchema.optional(),
    })
    const { rows } = parse(z.object({ rows: z.array(rowSchema).min(1).max(1000) }), req.body)
    const byKey = new Map<string, z.infer<typeof rowSchema>>()
    for (const row of rows) byKey.set(normaliseKey(row.code), row)
    const payload = JSON.stringify(
      Array.from(byKey.values()).map((m) => ({
        code: m.code,
        name: m.name,
        line: m.line ?? null,
        // A display name the file carries is used as is; otherwise one is
        // derived — for an update, from the STORED spelling of the code.
        display_name: m.displayName || null,
        display_name_default: machineDisplayName(m.code, m.name, m.line),
        machine_number: m.machineNumber ?? null,
        factory: m.factory ?? null,
        // The sheet's process when it has one; a new machine without one is
        // guessed from its name, an existing one keeps what it has.
        process: m.process ?? null,
        process_default: m.process ?? processFromName(m.name),
      })),
    )
    const recordset = `jsonb_to_recordset($1::jsonb) AS i(
      code text, name text, line text, display_name text, display_name_default text, machine_number text, factory text,
      process text, process_default text)`
    const result = await withTransaction(ctx.db, async (tx) => {
      let updated: { rowCount: number | null }
      let inserted: { rowCount: number | null }
      try {
        updated = await tx.query(
          `UPDATE machines t SET
              name = i.name, line = COALESCE(i.line, t.line),
              display_name = COALESCE(i.display_name,
                t.code || '-' || i.name || CASE WHEN COALESCE(i.line, t.line) <> '' THEN '-' || COALESCE(i.line, t.line) ELSE '' END),
              machine_number = COALESCE(i.machine_number, t.machine_number), factory = COALESCE(i.factory, t.factory),
              process = COALESCE(i.process, t.process),
              deleted_at = NULL, deleted_by_id = NULL
            FROM ${recordset}
           WHERE lower(t.code) = lower(i.code)
             AND t.id = (SELECT m.id FROM machines m WHERE lower(m.code) = lower(i.code) ORDER BY m.deleted_at NULLS FIRST, m.created_at LIMIT 1)`,
          [payload],
        )
        inserted = await tx.query(
          `INSERT INTO machines (code, name, line, display_name, machine_number, factory, process)
           SELECT i.code, i.name, COALESCE(i.line, ''), COALESCE(i.display_name, i.display_name_default), i.machine_number, i.factory,
                  i.process_default
             FROM ${recordset}
            WHERE NOT EXISTS (SELECT 1 FROM machines t WHERE lower(t.code) = lower(i.code))`,
          [payload],
        )
      } catch (e) {
        translateWriteError(e, DEFS.machines)
      }
      await writeAudit(tx, [importAudit(user.id, user.name, 'Machine', inserted.rowCount ?? 0, updated.rowCount ?? 0)])
      const body: ImportResult = { inserted: inserted.rowCount ?? 0, updated: updated.rowCount ?? 0 }
      return body
    })
    res.json(result)
  })

  r.post('/machines/existing-keys', requirePermission('manage-configuration'), async (req, res) => {
    const { keys } = parse(existingKeysSchema, req.body)
    const wanted = Array.from(new Set(keys.map(normaliseKey)))
    const { rows } = await ctx.db.query<{ key: string }>(`SELECT DISTINCT lower(code) AS key FROM machines WHERE lower(code) = ANY($1::text[])`, [wanted])
    const body: ExistingKeysResponse = { existing: rows.map((x) => x.key) }
    res.json(body)
  })

  /** The defect names offered on each machine, keyed by machine + name. */
  r.post('/work-center-defects/import', requirePermission('manage-configuration'), async (req, res) => {
    const user = requireUser(req)
    const rowSchema = z.object({ workCenterCode: text(40), defectName: text(200) })
    const { rows } = parse(z.object({ rows: z.array(rowSchema).min(1).max(1000) }), req.body)
    const byKey = new Map<string, z.infer<typeof rowSchema>>()
    for (const row of rows) byKey.set(`${normaliseKey(row.workCenterCode)}||${normaliseKey(row.defectName)}`, row)
    const payload = JSON.stringify(Array.from(byKey.values()).map((d) => ({ work_center_code: d.workCenterCode, defect_name: d.defectName })))
    const recordset = `jsonb_to_recordset($1::jsonb) AS i(work_center_code text, defect_name text)`
    const match = `lower(t.work_center_code) = lower(i.work_center_code) AND lower(t.defect_name) = lower(i.defect_name)`
    const result = await withTransaction(ctx.db, async (tx) => {
      // A defect already offered on the machine is left exactly as it is —
      // there is nothing in the row to update but the key itself.
      const updated = await tx.query(`SELECT count(*)::int AS n FROM ${recordset} WHERE EXISTS (SELECT 1 FROM work_center_defects t WHERE t.deleted_at IS NULL AND ${match})`, [payload])
      const inserted = await tx.query(
        `INSERT INTO work_center_defects (work_center_code, defect_name)
         SELECT i.work_center_code, i.defect_name FROM ${recordset}
          WHERE NOT EXISTS (SELECT 1 FROM work_center_defects t WHERE t.deleted_at IS NULL AND ${match})`,
        [payload],
      )
      const updatedCount = (updated.rows[0] as { n: number }).n
      await writeAudit(tx, [importAudit(user.id, user.name, 'WorkCenterDefect', inserted.rowCount ?? 0, updatedCount)])
      const body: ImportResult = { inserted: inserted.rowCount ?? 0, updated: updatedCount }
      return body
    })
    res.json(result)
  })

  r.post('/work-center-defects/existing-keys', requirePermission('manage-configuration'), async (req, res) => {
    const { keys } = parse(existingKeysSchema, req.body)
    const wanted = Array.from(new Set(keys.map(normaliseKey)))
    const { rows } = await ctx.db.query<{ key: string }>(
      `SELECT lower(work_center_code) || '||' || lower(defect_name) AS key FROM work_center_defects
        WHERE deleted_at IS NULL AND lower(work_center_code) || '||' || lower(defect_name) = ANY($1::text[])`,
      [wanted],
    )
    const body: ExistingKeysResponse = { existing: rows.map((x) => x.key) }
    res.json(body)
  })

  /** Mark many records deleted at once — one transaction, one audit entry each. */
  r.post('/:kind/delete-many', requirePermission('manage-configuration'), async (req, res) => {
    const def = kindOf(String(req.params.kind))
    const user = requireUser(req)
    const { ids } = parse(z.object({ ids: z.array(uuid).min(1).max(1000) }), req.body)
    const deleted = await withTransaction(ctx.db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `UPDATE ${def.table} SET deleted_at = now(), deleted_by_id = $2 WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL RETURNING id`,
        [Array.from(new Set(ids)), user.id],
      )
      for (const row of rows) await auditDelete(tx, { userId: user.id, userName: user.name, entity: def.entity, entityId: row.id })
      return rows.length
    })
    res.json({ deleted })
  })

  r.delete('/:kind/:id', requirePermission('manage-configuration'), async (req, res) => {
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
