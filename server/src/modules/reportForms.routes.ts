// ============================================================================
// Excel forms kept with saved reports (shared/src/reportStyles.ts): the
// company's own workbook (QF-07, an inspection sheet…) and where each value
// goes. For people given the assistant (403 to anyone else): whoever may
// open the report sees its forms and fills them (ai.routes.ts and
// automations.routes.ts fill them); the report's owner adds, maps and removes
// them. The assistant proposes a mapping from the form's sheets and the
// report's sections; it is not saved until the owner saves it.
//
// A workbook is checked before it is opened (zipGuard.ts): an .xlsx, small
// unpacked, without macros. Additions, changes and removals are in the audit
// log (entity ReportForm), as the report's own are: which form, never its
// content.
// ============================================================================

import { createHash } from 'node:crypto'
import { Router, type Request, type RequestHandler } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { auditEvent } from '@qc/shared/audit'
import {
  REPORT_FORM_AGGREGATES,
  REPORT_FORM_FIELDS,
  REPORT_FORM_MAX_BYTES,
  REPORT_FORM_MAX_CELLS,
  REPORT_FORM_MAX_TABLES,
  REPORT_FORM_NAME_MAX,
  reportFormMappingProblems,
  type ReportForm,
  type ReportFormMapping,
  type ReportFormsResponse,
  type ReportFormSuggestResponse,
} from '@qc/shared/reportStyles'
import type { AppContext } from '../context'
import { withTransaction, type Queryable } from '../db/pool'
import { ConflictError, HttpError, badRequest, forbidden, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { sendWorkbook } from '../lib/download'
import { requireUser, type AuthUser } from '../auth/middleware'
import { auditCreate, auditDelete, writeAudit } from '../audit/service'
import { isGranted, loadAccess } from '../ai/access'
import { notGranted } from '../ai/refusals'
import { findReport } from '../ai/reports'
import { FORM_MAP_SCHEMA, FORM_MAP_SYSTEM, callForPerson, formMapInput, readFormMapping, structuredParams } from '../reportStyles/aiDrafts'
import { loadWorkbook, previewSheets } from '../reportForms/formBook'
import { FORMS_PER_REPORT, countForms, deleteForm, findForm, formBytes, insertForm, listForms, updateForm } from '../reportForms/forms'
import { FormFileError, checkWorkbookZip } from '../reportForms/zipGuard'

const uuid = z.string().uuid()

/** One line, short: a form's name as the list shows it. */
// eslint-disable-next-line no-control-regex
const formName = z.string().transform((s) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()).pipe(z.string().min(1, 'Give the form a name.').max(REPORT_FORM_NAME_MAX))

const ref = z.string().trim().toUpperCase().max(10)
const valueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('field'), field: z.enum(REPORT_FORM_FIELDS) }).strict(),
  z.object({ kind: z.literal('input'), name: z.string().max(100) }).strict(),
  z.object({ kind: z.literal('section'), section: z.number().int().min(0).max(99), column: z.string().max(200), aggregate: z.enum(REPORT_FORM_AGGREGATES) }).strict(),
  z.object({ kind: z.literal('text'), text: z.string().max(500) }).strict(),
])
const mappingSchema: z.ZodType<ReportFormMapping, z.ZodTypeDef, unknown> = z
  .object({
    sheet: z.string().max(31),
    cells: z.array(z.object({ ref, value: valueSchema }).strict()).max(REPORT_FORM_MAX_CELLS),
    tables: z
      .array(
        z
          .object({
            section: z.number().int().min(0).max(99),
            startRow: z.number().int().min(1).max(100_000),
            lastRow: z.number().int().min(1).max(100_000).optional(),
            overflow: z.enum(['insert', 'next-sheet']),
            columns: z.array(z.object({ col: ref, column: z.string().max(200) }).strict()).max(60),
          })
          .strict(),
      )
      .max(REPORT_FORM_MAX_TABLES),
  })
  .strict()

const saveSchema = z.object({ name: formName, mapping: mappingSchema.nullable(), version: z.number().int().positive() }).strict()

/** The columns each section had when the person last ran the report (null: not run, or it failed): the form is matched to them. */
const suggestSchema = z.object({ columns: z.array(z.array(z.string().max(200)).max(200).nullable()).max(100) }).strict()

export function reportFormsRoutes(ctx: AppContext): Router {
  const r = Router()
  const db = ctx.db

  async function formUser(req: Request): Promise<AuthUser> {
    const user = requireUser(req)
    if (!isGranted(await loadAccess(db, user.id))) throw notGranted()
    return user
  }

  const audit = (user: AuthUser, id: string) => ({ userId: user.id, userName: user.name, entity: 'ReportForm', entityId: id })

  /** The report a form belongs to, as the person may open it; only its owner changes its forms. */
  async function ownReport(q: Queryable, reportId: string, user: AuthUser) {
    const report = await findReport(q, reportId, user.id)
    if (!report) throw notFound('That report')
    if (!report.mine) throw forbidden("Only the report's owner adds and changes its forms.")
    return report
  }

  /** A form the person may change: one of their own report's. */
  async function ownForm(q: Queryable, id: string, user: AuthUser, lock = false): Promise<ReportForm> {
    const form = await findForm(q, id, user.id, lock)
    if (!form) throw notFound('That form')
    if (!form.mine) throw forbidden("Only the report's owner changes its forms.")
    return form
  }

  // Read only for someone given the assistant: the bytes of anyone else are never taken in.
  const uploadOptions: multer.Options & { defParamCharset: string } = {
    storage: multer.memoryStorage(),
    defParamCharset: 'utf8',
    limits: { fileSize: REPORT_FORM_MAX_BYTES, files: 1, fields: 3 },
  }
  const upload = multer(uploadOptions)
  const grantedOnly: RequestHandler = async (req, _res, next) => {
    await formUser(req)
    next()
  }
  const receiveFile: RequestHandler = (req, res, next) =>
    upload.single('file')(req, res, (err: unknown) => {
      if ((err as { code?: string } | undefined)?.code === 'LIMIT_FILE_SIZE') {
        return next(new HttpError(413, 'payload_too_large', `A form may be at most ${REPORT_FORM_MAX_BYTES / 1024 / 1024} MB. Remove pictures or sheets it does not need.`))
      }
      next(err)
    })

  r.get('/', async (req, res) => {
    const user = await formUser(req)
    const reportId = parse(uuid, req.query.reportId)
    if (!(await findReport(db, reportId, user.id))) throw notFound('That report')
    const body: ReportFormsResponse = { forms: await listForms(db, reportId, user.id) }
    res.json(body)
  })

  /** A workbook added to one's own report: checked, read, kept with its sheets as the app shows them. */
  r.post('/', grantedOnly, receiveFile, async (req, res) => {
    const user = await formUser(req)
    if (!req.file) throw badRequest('Attach the workbook as the "file" field.')
    const reportId = parse(uuid, req.body?.reportId)
    const bytes = req.file.buffer
    const fileName = (req.file.originalname || 'form.xlsx').replace(/[\u0000-\u001f]/g, '').slice(0, 255) || 'form.xlsx'
    let sheets
    try {
      checkWorkbookZip(bytes)
      sheets = previewSheets(await loadWorkbook(bytes))
    } catch (e) {
      if (e instanceof FormFileError) throw badRequest(e.message)
      console.warn('[report-forms] a workbook could not be read:', e instanceof Error ? e.message : String(e))
      throw badRequest('This workbook could not be read. Open it in Excel, save it as .xlsx, and upload it again.')
    }
    if (sheets.length === 0) throw badRequest('This workbook has no sheets.')
    const name = parse(formName, typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name : fileName.replace(/\.xlsx$/i, ''))
    const form = await withTransaction(db, async (tx) => {
      // The report locked: two uploads at once cannot pass the limit together.
      await tx.query(`SELECT 1 FROM ai_reports WHERE id = $1 FOR UPDATE`, [reportId])
      await ownReport(tx, reportId, user)
      if ((await countForms(tx, reportId)) >= FORMS_PER_REPORT)
        throw new HttpError(409, 'conflict', `A report keeps at most ${FORMS_PER_REPORT} forms. Delete one it no longer needs first.`)
      const saved = await insertForm(tx, {
        reportId,
        owner: { id: user.id, name: user.name },
        name,
        fileName,
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sheets,
      })
      await auditCreate(tx, audit(user, saved.id))
      return saved
    })
    res.status(201).json(form)
  })

  r.get('/:id', async (req, res) => {
    const user = await formUser(req)
    const id = parse(uuid, req.params.id)
    const form = await findForm(db, id, user.id)
    if (!form) throw notFound('That form')
    res.json(form)
  })

  /** The workbook as it was added, empty. */
  r.get('/:id/file', async (req, res) => {
    const user = await formUser(req)
    const id = parse(uuid, req.params.id)
    const form = await findForm(db, id, user.id)
    if (!form) throw notFound('That form')
    sendWorkbook(res, form.fileName, await formBytes(db, id))
  })

  /** Its name and where each value goes; refused when it changed since it was read. */
  r.put('/:id', async (req, res) => {
    const user = await formUser(req)
    const id = parse(uuid, req.params.id)
    const body = parse(saveSchema, req.body)
    const form = await withTransaction(db, async (tx) => {
      const current = await ownForm(tx, id, user, true)
      if (current.version !== body.version) throw new ConflictError(current)
      if (body.mapping) {
        const report = await ownReport(tx, current.reportId, user)
        // The columns are known when the form is filled (a section's columns are its query's): checked then.
        const problems = reportFormMappingProblems(
          body.mapping,
          current.sheets,
          report.sections.map((s) => ({ title: s.title, columns: null })),
          report.inputs.map((i) => i.name),
        )
        if (problems.length > 0) throw badRequest(problems.join(' '), problems)
      }
      const saved = await updateForm(tx, id, { name: body.name, mapping: body.mapping }, { id: user.id, name: user.name })
      const at = new Date().toISOString()
      await writeAudit(tx, [
        ...(current.name !== saved.name ? [auditEvent('update', audit(user, id), at, { field: 'name' })] : []),
        ...(JSON.stringify(current.mapping) !== JSON.stringify(saved.mapping) ? [auditEvent('update', audit(user, id), at, { field: 'mapping' })] : []),
      ])
      return saved
    })
    res.json(form)
  })

  r.delete('/:id', async (req, res) => {
    const user = await formUser(req)
    const id = parse(uuid, req.params.id)
    await withTransaction(db, async (tx) => {
      await ownForm(tx, id, user, true)
      await deleteForm(tx, id, user.id)
      await auditDelete(tx, audit(user, id))
    })
    res.status(204).end()
  })

  /** Where each value goes, as the assistant proposes it from the form's sheets and the report's sections; not saved. */
  r.post('/:id/suggest', async (req, res) => {
    const user = await formUser(req)
    const id = parse(uuid, req.params.id)
    const { columns } = parse(suggestSchema, req.body)
    const form = await ownForm(db, id, user)
    const report = await ownReport(db, form.reportId, user)
    if (columns.length !== report.sections.length) throw badRequest('Run the report again, then ask: its sections changed.')
    if (columns.every((c) => !c)) throw badRequest('Run the report first: the form is matched to the columns its sections show.')
    const sections = report.sections.map((s, i) => ({ title: s.title, columns: columns[i] ?? [], display: s.display ?? 'table' }))
    const params = structuredParams({
      job: 'report-form',
      system: FORM_MAP_SYSTEM,
      schema: FORM_MAP_SCHEMA,
      content: [{ type: 'text', text: formMapInput({ sheets: form.sheets, sections, inputs: report.inputs.map((i) => ({ name: i.name, label: i.label })) }) }],
    })
    const raw = await callForPerson(ctx, user.id, params, 'Matching the form')
    const read = readFormMapping(raw, form.sheets)
    // What would not save is left out here, so the person starts from a mapping that does.
    const problems = reportFormMappingProblems(
      read.mapping,
      form.sheets,
      sections.map((s, i) => ({ title: s.title, columns: columns[i] })),
      report.inputs.map((i) => i.name),
    )
    const mapping = problems.length === 0 ? read.mapping : keepWhatReads(read.mapping, form.sheets, sections, columns, report.inputs.map((i) => i.name))
    const body: ReportFormSuggestResponse = {
      mapping,
      notes: problems.length === 0 ? read.notes : [read.notes, 'Some of what the assistant proposed did not fit the form or the report and was left out.'].filter(Boolean).join(' '),
    }
    res.json(body)
  })

  return r
}

/** A mapping with each entry that is wrong on its own taken out, then each table that still clashes. */
function keepWhatReads(
  mapping: ReportFormMapping,
  sheets: ReportForm['sheets'],
  sections: { title: string }[],
  columns: (string[] | null)[],
  inputs: string[],
): ReportFormMapping {
  const known = sections.map((s, i) => ({ title: s.title, columns: columns[i] }))
  const fine = (m: ReportFormMapping) => reportFormMappingProblems(m, sheets, known, inputs).length === 0
  const out: ReportFormMapping = { sheet: mapping.sheet, cells: [], tables: [] }
  // The first table's way of taking more rows is the form's; a table that takes them another way is left out.
  for (const t of mapping.tables) {
    const next = { ...out, tables: [...out.tables, t] }
    if (fine(next)) out.tables = next.tables
  }
  for (const c of mapping.cells) {
    const next = { ...out, cells: [...out.cells, c] }
    if (fine(next)) out.cells = next.cells
  }
  return out
}
