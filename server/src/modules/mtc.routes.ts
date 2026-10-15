// ============================================================================
// MTC — suppliers' certificates read into the material registers: coils,
// welding wire, mesh wire (their descriptions: shared/src/mtc.ts; their
// tables: mtc/registers.ts).
//
//   POST /extract              the PDF in; Claude tells which register it
//                              belongs to and lists its items. Streamed as
//                              Server-Sent Events: a long certificate takes
//                              minutes, and App Service drops a request silent
//                              for ~230 s. Nothing is written to a register,
//                              and the PDF is not kept: it lives in memory for
//                              the length of the call.
//   POST /:kind/existing       the registered items behind a list of
//                              identifiers, for the review to compare with.
//   POST /:kind/save           the reviewed items, in one transaction: new ones
//                              added, registered ones overwritten only where
//                              the person asked, every change audited.
//   GET  /:kind/table          a register as a table, a page at a time; and
//   GET  /:kind/options        its filters' choices. For everyone signed in.
//
// Reading and saving need the MTC permission, which the AI assistant's owner
// gives person by person with the rest of their AI settings (ai_access.mtc),
// read again on every request: taken away, the next request stops. It is not
// the chat: someone may upload certificates with the assistant off for them.
// Claude is called with the company's key, on the model the owner chose for
// certificates; each reading is logged (mtc_readings) with its cost, which the
// owner sees in Activity and which counts in the month's spend, the
// assistant's cap and the person's own, like any call.
// ============================================================================

import { Router, type RequestHandler } from 'express'
import multer from 'multer'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import {
  MTC_MAX_PDF_BYTES,
  MTC_MAX_ROWS,
  MTC_TABLE_PAGE,
  MTC_TABLE_PAGE_MAX,
  MTC_TABLE_SORTS,
  isMtcKind,
  mtcChangedFields,
  mtcDuplicateKeys,
  mtcIdField,
  mtcKeyLabel,
  mtcKeyOf,
  mtcMerged,
  mtcRowProblems,
  mtcValuesOf,
  type MtcExistingResponse,
  type MtcRegisterRow,
  type MtcSaveResponse,
  type MtcStreamEvent,
  type MtcTableOptionsResponse,
  type MtcTableResponse,
  type MtcValues,
} from '@qc/shared/mtc'
import { auditEvent, type AuditDraft } from '@qc/shared/audit'
import type { AppContext } from '../context'
import { withTransaction, PG, pgCode } from '../db/pool'
import { HttpError, badRequest, duplicate, forbidden, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { RateLimiter } from '../lib/rateLimit'
import { requireUser } from '../auth/middleware'
import { writeAudit } from '../audit/service'
import { isPdf } from '../ai/attachments'
import { describeModelFailure, usageOf } from '../ai/assistant'
import { modelPrice } from '../ai/models'
import { aiOwnerAccount } from '../ai/owner'
import { loadAccess, mayUploadMtc } from '../ai/access'
import { loadAiSettings } from '../ai/settings'
import { resolveApiKey } from '../ai/credentials'
import { monthSpend, personalMonthSpend, recordUsage } from '../ai/transcript'
import type { ModelMessage } from '../ai/model'
import { SseStream } from '../ai/sse'
import { MTC_MAX_TOKENS, MTC_PROMPT_TOKENS, MtcReadError, mtcMessages, mtcRequest, readMtcReply } from '../mtc/reader'
import { REGISTER_TABLES, col, rowSql, valuesSql, type RegisterTable } from '../mtc/registers'

/** Certificates one person may have read in an hour: far more than a delivery brings, few enough that a stuck client cannot run up the bill. */
const READS_PER_HOUR = 30
/** Audit entries per INSERT: under PostgreSQL's 65,535 parameters at 14 a row. */
const AUDIT_CHUNK = 2_000

/** How a reading ended, as the owner's Activity tells it. */
type ReadingOutcome = 'read' | 'not-certificate' | 'failed' | 'stopped'

/**
 * Log one reading and what it cost, in one transaction: the reading, then its
 * usage pointing at it. Only a reading that cost something is logged: one
 * refused before the call is no reading.
 */
async function logReading(
  ctx: AppContext,
  r: { userId: string; fileName: string; outcome: ReadingOutcome; kind: string | null; items: number | null; message: ModelMessage; model: string; requestId: string | null; partial: boolean },
): Promise<void> {
  const usage = usageOf(r.message, r.model)
  await withTransaction(ctx.db, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO mtc_readings (user_id, file_name, kind, items, outcome) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [r.userId, r.fileName, r.kind, r.items, r.outcome],
    )
    await recordUsage(tx, {
      userId: r.userId,
      conversationId: null,
      turnId: null,
      mtcReadingId: rows[0].id,
      model: usage.model,
      tokens: usage.tokens,
      costUsd: usage.costUsd,
      requestId: r.requestId,
      partial: r.partial,
    })
  })
}

/** The register a request names, or 404: the name never reaches SQL, its table does. */
function registerOf(kind: string): RegisterTable {
  if (!isMtcKind(kind)) throw notFound('That register')
  return REGISTER_TABLES[kind]
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

/** A reviewed item as the API takes it: every field cleaned by its kind; a value that is not one is kept as NaN so the checks refuse it. */
function reviewedValues(t: RegisterTable, raw: Record<string, unknown>): MtcValues {
  const values = mtcValuesOf(t.register, raw)
  for (const f of t.register.fields) {
    const v = raw[f.key]
    const blank = v === undefined || v === null || (typeof v === 'string' && v.trim() === '')
    if (blank || values[f.key] !== undefined) continue
    values[f.key] = Number.NaN
  }
  return values
}

/** An item's fields as the audit trail shows them, one value per field (the key fields name the item). */
const auditValues = (t: RegisterTable, v: MtcValues): Record<string, string> =>
  Object.fromEntries(t.register.fields.filter((f) => !f.identifies).map((f) => [f.key, v[f.key] === undefined ? '' : String(v[f.key])]))

const saveSchema = z.object({
  fileName: z
    .string()
    .max(500)
    .transform((v) => (v.replace(/\s+/g, ' ').trim() || 'certificate.pdf').slice(0, 255)),
  rows: z.array(z.object({ values: z.record(z.unknown()), overwrite: z.boolean() })).min(1).max(MTC_MAX_ROWS),
})

export function mtcRoutes(ctx: AppContext): Router {
  const r = Router()
  const reading = new Set<string>()
  const reads = new RateLimiter(READS_PER_HOUR, 60 * 60_000)

  /** Who may upload certificates is read from the database on every request, never from the token. */
  const uploaderOnly: RequestHandler = async (req, _res, next) => {
    const user = requireUser(req)
    const owner = (await aiOwnerAccount(ctx.db, ctx.config)) === user.id
    if (!mayUploadMtc(await loadAccess(ctx.db, user.id), owner, true)) {
      return next(forbidden('You are not allowed to upload certificates. The AI assistant’s owner can allow you in the AI settings.'))
    }
    next()
  }

  // A name in Arabic arrives as UTF-8: read it so, not as Latin-1 (multer's default; its types do not list the option yet).
  const uploadOptions: multer.Options & { defParamCharset: string } = {
    storage: multer.memoryStorage(),
    defParamCharset: 'utf8',
    limits: { fileSize: MTC_MAX_PDF_BYTES, files: 1, fields: 0 },
  }
  const upload = multer(uploadOptions)
  const receiveFile: RequestHandler = (req, res, next) =>
    upload.single('file')(req, res, (err: unknown) => {
      if ((err as { code?: string } | undefined)?.code === 'LIMIT_FILE_SIZE') {
        return next(new HttpError(413, 'payload_too_large', `A certificate may be at most ${MTC_MAX_PDF_BYTES / 1024 / 1024} MB. Split the PDF and upload the parts.`))
      }
      next(err)
    })

  /** One certificate at a time per person, and so many an hour: checked before the file is taken in. */
  const oneAtATime: RequestHandler = (req, _res, next) => {
    const user = requireUser(req)
    if (reading.has(user.id)) return next(new HttpError(429, 'rate_limited', 'A certificate of yours is still being read. Wait for it to finish.'))
    const wait = reads.hit(user.id)
    if (wait > 0) return next(new HttpError(429, 'rate_limited', `Too many certificates read in the last hour. Try again in ${Math.ceil(wait / 60)} min.`))
    next()
  }

  r.post('/extract', uploaderOnly, oneAtATime, receiveFile, async (req, res) => {
    const user = requireUser(req)
    if (!req.file) throw badRequest('Upload the certificate as the "file" field.')
    const pdf = req.file.buffer
    if (!isPdf(pdf)) throw badRequest('This is not a PDF. Upload the certificate as the supplier sent it, as a PDF.')
    const fileName = (req.file.originalname || 'certificate.pdf').replace(/[\u0000-\u001f]/g, '').slice(0, 255) || 'certificate.pdf'

    // Read one after another, as the answer loop does: the assistant's switch, its key, its monthly cap, the model for certificates.
    const owner = (await aiOwnerAccount(ctx.db, ctx.config)) === user.id
    const { settings } = await loadAiSettings(ctx.db)
    const { apiKey } = await resolveApiKey(ctx.db, ctx.config)
    if (!settings.enabled || !apiKey) {
      throw new HttpError(
        503,
        'ai_unavailable',
        owner
          ? 'Reading certificates uses the AI assistant, which is switched off or has no API key. Set it up under Administration → AI assistant.'
          : 'Certificates cannot be read right now: the AI service is not available. Ask your administrator.',
      )
    }
    const model = settings.mtcModel

    reading.add(user.id)
    try {
      // Counted first (free): it proves Claude can read the file, and prices the call's worst case for the cap.
      let tokens: number
      try {
        tokens = await ctx.ai.countTokens(apiKey, { model, messages: mtcMessages(pdf, fileName) })
      } catch (e) {
        if (e instanceof Anthropic.BadRequestError) {
          throw badRequest('Claude cannot read this PDF. It may be damaged, password-protected or longer than 100 pages: split it, or upload another copy.')
        }
        const failure = describeModelFailure(e, 'none (counting an MTC)', owner)
        throw new HttpError(failure.code === 'rate_limited' ? 429 : failure.code === 'ai_unavailable' ? 503 : 502, failure.code, failure.message)
      }
      const price = modelPrice(model)
      const worstUsd = ((tokens + MTC_PROMPT_TOKENS) * Math.max(price.input, price.cacheWrite5m) + MTC_MAX_TOKENS * price.output) / 1_000_000
      const spend = await monthSpend(ctx.db)
      if (Number(spend.spentUsd) + worstUsd > settings.monthlyCapUsd) {
        throw new HttpError(
          402,
          'ai_budget_reached',
          owner
            ? 'The AI assistant’s monthly limit is too close to read this certificate. You can raise it under Administration → AI assistant.'
            : 'The AI service’s monthly limit is reached, so certificates cannot be read until the 1st.',
        )
      }
      // The person's own monthly cap, set with the permission: certificates count in it like questions.
      const access = await loadAccess(ctx.db, user.id)
      if (access && (await personalMonthSpend(ctx.db, user.id)) + worstUsd > access.monthlyCapUsd) {
        throw new HttpError(
          402,
          'ai_budget_reached',
          owner
            ? 'Your own monthly AI limit is too close to read this certificate. You can raise it in the AI settings, under Who can use it.'
            : 'You have reached this month’s AI limit, so certificates cannot be read until the 1st. Ask the AI assistant’s owner to raise it.',
        )
      }

      const stream = new SseStream(res)
      stream.open()
      const send = (event: MtcStreamEvent) => stream.send(event)
      send({ type: 'reading' })

      // A person who closes the page lets go of the reading: it is stopped, so it costs no more.
      const abort = new AbortController()
      res.on('close', () => {
        if (!res.writableFinished) abort.abort()
      })
      const call = ctx.ai.stream(apiKey, mtcRequest(pdf, fileName, model), { signal: abort.signal })
      const log = { userId: user.id, fileName, model, requestId: call.request_id ?? null }
      let logged = false
      try {
        const message = await call.finalMessage()
        let result
        try {
          result = readMtcReply(message, fileName)
        } catch (e) {
          logged = true
          await logReading(ctx, { ...log, outcome: 'failed', kind: null, items: null, message, partial: false })
          throw e
        }
        logged = true
        await logReading(ctx, { ...log, outcome: result.kind ? 'read' : 'not-certificate', kind: result.kind, items: result.rows.length, message, partial: false })
        send({ type: 'result', result })
      } catch (e) {
        // Whatever was read before it failed or was stopped is still billed: kept as partial, like a cut-off answer.
        const partial = call.currentMessage
        if (partial && !logged) {
          await logReading(ctx, { ...log, outcome: abort.signal.aborted ? 'stopped' : 'failed', kind: null, items: null, message: partial, partial: true }).catch((err: unknown) =>
            console.error('[mtc] could not log a reading that did not finish', err),
          )
        }
        if (abort.signal.aborted) return
        if (e instanceof MtcReadError) send({ type: 'error', code: 'validation', message: e.message })
        else {
          const failure = describeModelFailure(e, 'none (reading an MTC)', owner)
          send({ type: 'error', code: failure.code, message: failure.message })
        }
      } finally {
        stream.end()
      }
    } finally {
      reading.delete(user.id)
    }
  })

  /** A register as a table, for everyone: words found anywhere in its text fields; the supplier and the filter field exactly. */
  r.get('/:kind/table', async (req, res) => {
    const t = registerOf(String(req.params.kind))
    const q = parse(
      z.object({
        search: z.string().trim().max(120).default(''),
        supplier: z.string().trim().max(200).default(''),
        filter: z.string().trim().max(60).default(''),
        sort: z.enum(MTC_TABLE_SORTS).default('key'),
        offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
        limit: z.coerce.number().int().min(1).max(MTC_TABLE_PAGE_MAX).default(MTC_TABLE_PAGE),
      }),
      req.query,
    )
    const where = ['deleted_at IS NULL']
    const params: unknown[] = []
    const p = (v: unknown) => {
      params.push(v)
      return `$${params.length}`
    }
    if (q.search) {
      const term = p(`%${escapeLike(q.search)}%`)
      const texts = t.register.fields.filter((f) => f.type === 'text').map((f) => `${col(t, f.key)} ILIKE ${term}`)
      where.push(`(${texts.join(' OR ')})`)
    }
    if (q.supplier) where.push(`lower(${col(t, 'supplier')}) = lower(${p(q.supplier)})`)
    if (q.filter) where.push(`lower(${col(t, t.register.filter)}) = lower(${p(q.filter)})`)
    const keyOrder = t.register.fields
      .filter((f) => f.identifies)
      .map((f) => (f.type === 'text' ? `lower(${col(t, f.key)})` : col(t, f.key)))
      .join(', ')
    const order = q.sort === 'newest' ? `created_at DESC, ${keyOrder}` : keyOrder
    const filter = where.join(' AND ')
    const total = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t.table} WHERE ${filter}`, params)
    const { rows } = await ctx.db.query<{ id: string; values: MtcValues }>(
      `SELECT id, ${valuesSql(t)} AS "values" FROM ${t.table} WHERE ${filter} ORDER BY ${order} LIMIT ${p(q.limit)} OFFSET ${p(q.offset)}`,
      params,
    )
    const body: MtcTableResponse = { rows, total: total.rows[0].n }
    res.json(body)
  })

  /** The table's filter choices: the suppliers and the filter field's values registered, once each whatever their case. */
  r.get('/:kind/options', async (req, res) => {
    const t = registerOf(String(req.params.kind))
    const distinct = (c: string) =>
      `(SELECT array_agg(v ORDER BY lower(v)) FROM (SELECT DISTINCT ON (lower(btrim(${c}))) btrim(${c}) AS v FROM ${t.table}
          WHERE deleted_at IS NULL AND btrim(COALESCE(${c}, '')) <> '' ORDER BY lower(btrim(${c})), btrim(${c})) x)`
    const { rows } = await ctx.db.query<{ suppliers: string[] | null; filterValues: string[] | null }>(
      `SELECT ${distinct(col(t, 'supplier'))} AS suppliers, ${distinct(col(t, t.register.filter))} AS "filterValues"`,
    )
    const body: MtcTableOptionsResponse = { suppliers: rows[0].suppliers ?? [], filterValues: rows[0].filterValues ?? [] }
    res.json(body)
  })

  /** The registered items behind these identifiers, removed ones included: what the review compares each row with. */
  r.post('/:kind/existing', async (req, res) => {
    const t = registerOf(String(req.params.kind))
    const { ids } = parse(z.object({ ids: z.array(z.string().max(500)).max(MTC_MAX_ROWS) }), req.body)
    const wanted = Array.from(new Set(ids.map((v) => v.trim().toLowerCase()).filter(Boolean)))
    if (wanted.length === 0) return res.json([])
    const { rows } = await ctx.db.query<MtcRegisterRow>(`SELECT ${rowSql(t)} FROM ${t.table} WHERE lower(${col(t, mtcIdField(t.register).key)}) = ANY($1::text[])`, [wanted])
    const body: MtcExistingResponse = rows.map((row) => (row.deletedAt ? row : { id: row.id, values: row.values }))
    res.json(body)
  })

  r.post('/:kind/save', uploaderOnly, async (req, res) => {
    const user = requireUser(req)
    const t = registerOf(String(req.params.kind))
    const { register } = t
    const body = parse(saveSchema, req.body)
    const rows = body.rows.map((row) => ({ values: reviewedValues(t, row.values), overwrite: row.overwrite }))
    const dup = mtcDuplicateKeys(
      register,
      rows.map((r) => r.values),
    )
    if (dup.size > 0) {
      const named = rows.filter((r) => dup.has(mtcKeyOf(register, r.values))).map((r) => mtcKeyLabel(register, r.values))
      throw badRequest(`Listed more than once: ${Array.from(new Set(named)).slice(0, 5).join(', ')}. Keep one row for each ${register.singular}.`)
    }
    for (const { values } of rows) {
      const blocking = mtcRowProblems(register, values).find((p) => p.blocking)
      if (blocking) {
        const field = register.fields.find((f) => f.key === blocking.field)!
        throw badRequest(`${mtcKeyLabel(register, values)} — ${field.label}: ${blocking.message}`)
      }
    }

    const result = await withTransaction(ctx.db, async (tx) => {
      // Locked, so an overwrite is judged against the item as it is now, not as the review saw it.
      const idField = mtcIdField(register).key
      const ids = Array.from(new Set(rows.map((r) => String(r.values[idField]).toLowerCase())))
      const { rows: found } = await tx.query<MtcRegisterRow>(`SELECT ${rowSql(t)} FROM ${t.table} WHERE lower(${col(t, idField)}) = ANY($1::text[]) FOR UPDATE`, [ids])
      const existing = new Map(found.map((row) => [mtcKeyOf(register, row.values), row]))

      const toInsert: MtcValues[] = []
      const toUpdate: { before: MtcRegisterRow; after: MtcValues }[] = []
      const out: MtcSaveResponse = { inserted: [], updated: [], skipped: [] }
      for (const { values, overwrite } of rows) {
        const current = existing.get(mtcKeyOf(register, values))
        if (!current) {
          toInsert.push(values)
          continue
        }
        if (!overwrite || (mtcChangedFields(register, current.values, values).length === 0 && !current.deletedAt)) {
          out.skipped.push(mtcKeyLabel(register, current.values))
          continue
        }
        toUpdate.push({ before: current, after: mtcMerged(register, current.values, values) })
      }

      const at = new Date().toISOString()
      const audit: AuditDraft[] = []
      const auditCtx = (id: string) => ({ userId: user.id, userName: user.name, entity: register.entity, entityId: id })
      const source = `MTC upload: ${body.fileName}`
      const fields = register.fields

      if (toInsert.length > 0) {
        const columns = fields.map((f) => col(t, f.key)).join(', ')
        const recordset = fields.map((f) => `${col(t, f.key)} ${f.type === 'number' ? 'numeric' : 'text'}`).join(', ')
        const payload = toInsert.map((v) => Object.fromEntries(fields.map((f) => [t.columns[f.key], v[f.key] ?? null])))
        let inserted: { id: string; values: MtcValues }[]
        try {
          inserted = (
            await tx.query<{ id: string; values: MtcValues }>(
              `INSERT INTO ${t.table} (${columns})
               SELECT ${columns} FROM jsonb_to_recordset($1::jsonb) AS i(${recordset})
               RETURNING id, ${valuesSql(t)} AS "values"`,
              [JSON.stringify(payload)],
            )
          ).rows
        } catch (e) {
          // Someone registered one of these items since the review was opened.
          if (pgCode(e) === PG.UNIQUE_VIOLATION) throw duplicate(`One of these ${register.plural} was registered by someone else meanwhile. Review the list again before saving.`)
          throw e
        }
        for (const row of inserted) {
          out.inserted.push(mtcKeyLabel(register, row.values))
          // One entry per item: where it came from and what it was registered with.
          const values = Object.entries(auditValues(t, row.values))
            .filter(([, v]) => v !== '')
            .map(([k, v]) => `${k} ${v}`)
            .join('; ')
          audit.push(auditEvent('create', auditCtx(row.id), at, { field: 'source', newValue: `${source}${values ? ` — ${values}` : ''}` }))
        }
      }

      const changing = fields.filter((f) => !f.identifies)
      for (const u of toUpdate) {
        await tx.query(
          `UPDATE ${t.table} SET ${changing.map((f, i) => `${col(t, f.key)} = $${i + 2}`).join(', ')}, deleted_at = NULL, deleted_by_id = NULL WHERE id = $1`,
          [u.before.id, ...changing.map((f) => u.after[f.key] ?? null)],
        )
        out.updated.push(mtcKeyLabel(register, u.before.values))
        if (u.before.deletedAt) audit.push(auditEvent('restore', auditCtx(u.before.id), at, { field: 'source', newValue: source }))
        const before = auditValues(t, u.before.values)
        const after = auditValues(t, u.after)
        for (const field of Object.keys(after)) {
          if (before[field] !== after[field]) audit.push(auditEvent('update', auditCtx(u.before.id), at, { field, oldValue: before[field], newValue: after[field] }))
        }
        audit.push(auditEvent('update', auditCtx(u.before.id), at, { field: 'source', newValue: source }))
      }

      for (let i = 0; i < audit.length; i += AUDIT_CHUNK) await writeAudit(tx, audit.slice(i, i + AUDIT_CHUNK))
      return out
    })
    res.json(result)
  })

  return r
}
