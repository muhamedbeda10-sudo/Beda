// ============================================================================
// MTC — a mill test certificate read into the coil register.
//
//   POST /extract   the PDF in, Claude's list of its coils out. Streamed as
//                   Server-Sent Events: a long certificate takes minutes, and
//                   App Service drops a request silent for ~230 s. Nothing is
//                   written to the register, and the PDF is not kept: it lives
//                   in memory for the length of the call.
//   POST /existing  the registered coils behind a list of coil numbers, for
//                   the review to compare with.
//   POST /save      the reviewed coils, in one transaction: new ones added,
//                   registered ones overwritten only where the person asked,
//                   every change in the audit trail.
//
// Reading and saving need the MTC permission (users.mtc_upload), read again on
// every request: an administrator taking it away stops the next request. It is
// not the AI assistant's access: Claude is called with the company's key, the
// call is counted in the assistant's spend and held to its monthly cap, and the
// assistant's switch turns it off too, but nobody needs the assistant to use it.
// ============================================================================

import { Router, type RequestHandler } from 'express'
import multer from 'multer'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import {
  MTC_MAX_PDF_BYTES,
  MTC_MAX_ROWS,
  MTC_MODEL,
  MTC_TEXT_MAX,
  cleanMtcNumber,
  cleanMtcText,
  mtcChangedFields,
  mtcCoilKey,
  mtcCoilOf,
  mtcDuplicateKeys,
  mtcMerged,
  mtcRowProblems,
  type MtcCoil,
  type MtcExistingResponse,
  type MtcSaveResponse,
  type MtcStreamEvent,
} from '@qc/shared/mtc'
import { auditEvent, type AuditDraft } from '@qc/shared/audit'
import type { Coil } from '@qc/shared/types'
import type { AppContext } from '../context'
import { withTransaction, PG, pgCode } from '../db/pool'
import { HttpError, badRequest, duplicate, forbidden } from '../lib/errors'
import { parse } from '../lib/validate'
import { dropNulls } from '../lib/rows'
import { RateLimiter } from '../lib/rateLimit'
import { requireUser } from '../auth/middleware'
import { writeAudit } from '../audit/service'
import { isPdf } from '../ai/attachments'
import { describeModelFailure, usageOf } from '../ai/assistant'
import { modelPrice } from '../ai/models'
import { aiOwnerAccount } from '../ai/owner'
import { loadAiSettings } from '../ai/settings'
import { resolveApiKey } from '../ai/credentials'
import { monthSpend, recordUsage } from '../ai/transcript'
import { SseStream } from '../ai/sse'
import { MTC_MAX_TOKENS, MTC_PROMPT_TOKENS, MtcReadError, mtcMessages, mtcRequest, readMtcReply } from '../mtc/reader'

const COIL_SELECT = `id, coil_number AS "coilNumber", grade, sm_type AS "smType", supplier, thickness, width, yield, notes, deleted_at AS "deletedAt"`

/** Certificates one person may have read in an hour: far more than a delivery brings, few enough that a stuck client cannot run up the bill. */
const READS_PER_HOUR = 30
/** Audit entries per INSERT: under PostgreSQL's 65,535 parameters at 14 a row. */
const AUDIT_CHUNK = 2_000

/** Who may upload certificates is read from the database on every request, never from the token. */
async function mayUploadMtc(ctx: AppContext, userId: string): Promise<boolean> {
  const { rows } = await ctx.db.query<{ allowed: boolean }>(`SELECT mtc_upload AS allowed FROM users WHERE id = $1 AND deleted_at IS NULL AND is_active`, [userId])
  return rows[0]?.allowed === true
}

const text = (max: number) =>
  z
    .string()
    .max(max * 2)
    .optional()
    .transform((v) => cleanMtcText(v))
    .refine((v) => v === undefined || v.length <= max, `At most ${max} characters.`)
const measurement = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === null || v === undefined || v === '') return undefined
    const n = cleanMtcNumber(v)
    if (n === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Not a valid measurement.' })
    return n
  })

const saveRow = z.object({
  coilNumber: z
    .string()
    .transform((v) => cleanMtcText(v) ?? '')
    .refine((v) => v.length > 0, 'A coil number is required.')
    .refine((v) => v.length <= MTC_TEXT_MAX.coilNumber, `At most ${MTC_TEXT_MAX.coilNumber} characters.`),
  grade: text(MTC_TEXT_MAX.grade),
  smType: text(MTC_TEXT_MAX.smType),
  supplier: text(MTC_TEXT_MAX.supplier),
  thickness: measurement,
  width: measurement,
  yield: measurement,
  notes: text(MTC_TEXT_MAX.notes),
  overwrite: z.boolean(),
})

const saveSchema = z.object({
  fileName: z
    .string()
    .max(500)
    .transform((v) => (cleanMtcText(v) ?? 'certificate.pdf').slice(0, 255)),
  rows: z.array(saveRow).min(1).max(MTC_MAX_ROWS),
})

/** The register's columns, from a coil's fields. */
const columnsOf = (c: MtcCoil) => ({
  coil_number: c.coilNumber,
  grade: c.grade ?? null,
  sm_type: c.smType ?? null,
  supplier: c.supplier ?? null,
  thickness: c.thickness ?? null,
  width: c.width ?? null,
  yield: c.yield ?? null,
  notes: c.notes ?? null,
})

/** A coil's fields as the audit trail shows them, one value per field. */
const auditValues = (c: MtcCoil): Record<string, string> => ({
  grade: c.grade ?? '',
  smType: c.smType ?? '',
  supplier: c.supplier ?? '',
  thickness: c.thickness === undefined ? '' : String(c.thickness),
  width: c.width === undefined ? '' : String(c.width),
  yield: c.yield === undefined ? '' : String(c.yield),
  notes: c.notes ?? '',
})

export function mtcRoutes(ctx: AppContext): Router {
  const r = Router()
  const reading = new Set<string>()
  const reads = new RateLimiter(READS_PER_HOUR, 60 * 60_000)

  const uploaderOnly: RequestHandler = async (req, _res, next) => {
    const user = requireUser(req)
    if (!(await mayUploadMtc(ctx, user.id))) return next(forbidden('You are not allowed to upload certificates. An administrator can allow you under Users.'))
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
    if (!isPdf(pdf)) throw badRequest('This is not a PDF. Upload the certificate as the mill sent it, as a PDF.')
    const fileName = (req.file.originalname || 'certificate.pdf').replace(/[\u0000-\u001f]/g, '').slice(0, 255) || 'certificate.pdf'

    // Read one after another, as the answer loop does: the assistant's switch, its key and its monthly cap.
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

    reading.add(user.id)
    try {
      // Counted first (free): it proves Claude can read the file, and prices the call's worst case for the cap.
      let tokens: number
      try {
        tokens = await ctx.ai.countTokens(apiKey, { model: MTC_MODEL, messages: mtcMessages(pdf, fileName) })
      } catch (e) {
        if (e instanceof Anthropic.BadRequestError) {
          throw badRequest('Claude cannot read this PDF. It may be damaged, password-protected or longer than 100 pages: split it, or upload another copy.')
        }
        const failure = describeModelFailure(e, 'none (counting an MTC)', owner)
        throw new HttpError(failure.code === 'rate_limited' ? 429 : failure.code === 'ai_unavailable' ? 503 : 502, failure.code, failure.message)
      }
      const price = modelPrice(MTC_MODEL)
      const worstUsd = ((tokens + MTC_PROMPT_TOKENS) * Math.max(price.input, price.cacheWrite5m) + MTC_MAX_TOKENS * price.output) / 1_000_000
      const spend = await monthSpend(ctx.db)
      if (Number(spend.spentUsd) + worstUsd > settings.monthlyCapUsd) {
        throw new HttpError(402, 'ai_budget_reached', owner
          ? 'The AI assistant’s monthly limit is too close to read this certificate. You can raise it under Administration → AI assistant.'
          : 'The AI service’s monthly limit is reached, so certificates cannot be read until the 1st.')
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
      const call = ctx.ai.stream(apiKey, mtcRequest(pdf, fileName), { signal: abort.signal })
      let recorded = false
      try {
        const message = await call.finalMessage()
        const usage = usageOf(message, MTC_MODEL)
        recorded = true
        await recordUsage(ctx.db, {
          userId: user.id,
          conversationId: null,
          turnId: null,
          model: usage.model,
          tokens: usage.tokens,
          costUsd: usage.costUsd,
          requestId: call.request_id ?? null,
        })
        send({ type: 'result', result: readMtcReply(message, fileName) })
      } catch (e) {
        // Whatever was read before it failed is still billed: kept as partial, like a cut-off answer.
        const partial = call.currentMessage
        if (partial && !recorded) {
          const usage = usageOf(partial, MTC_MODEL)
          await recordUsage(ctx.db, {
            userId: user.id,
            conversationId: null,
            turnId: null,
            model: usage.model,
            tokens: usage.tokens,
            costUsd: usage.costUsd,
            requestId: call.request_id ?? null,
            partial: true,
          }).catch((err: unknown) => console.error('[mtc] could not record the usage of a failed reading', err))
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

  /** The registered coils behind these numbers, removed ones included: what the review compares each row with. */
  r.post('/existing', async (req, res) => {
    const { coilNumbers } = parse(z.object({ coilNumbers: z.array(z.string().max(500)).max(MTC_MAX_ROWS) }), req.body)
    const wanted = Array.from(new Set(coilNumbers.map(mtcCoilKey).filter(Boolean)))
    if (wanted.length === 0) return res.json([])
    const { rows } = await ctx.db.query<Coil>(`SELECT ${COIL_SELECT} FROM coils WHERE lower(coil_number) = ANY($1::text[])`, [wanted])
    const body: MtcExistingResponse = rows.map(dropNulls)
    res.json(body)
  })

  r.post('/save', uploaderOnly, async (req, res) => {
    const user = requireUser(req)
    const body = parse(saveSchema, req.body)
    const rows = body.rows.map((row) => {
      const { overwrite, ...coil } = row
      const c: MtcCoil = { coilNumber: coil.coilNumber }
      for (const [k, v] of Object.entries(coil)) if (v !== undefined) (c as unknown as Record<string, unknown>)[k] = v
      return { coil: c, overwrite }
    })
    const dup = mtcDuplicateKeys(rows.map((r) => r.coil))
    if (dup.size > 0) throw badRequest(`A coil number appears more than once: ${Array.from(dup).slice(0, 5).join(', ')}. Keep one row for each coil.`)
    for (const { coil } of rows) {
      const blocking = mtcRowProblems(coil).find((p) => p.blocking)
      if (blocking) throw badRequest(`Coil ${coil.coilNumber || '(no number)'}: ${blocking.message}`)
    }

    const result = await withTransaction(ctx.db, async (tx) => {
      // Locked, so an overwrite is judged against the coil as it is now, not as the review saw it.
      const keys = rows.map((r) => mtcCoilKey(r.coil.coilNumber))
      const { rows: existingRows } = await tx.query<Coil>(`SELECT ${COIL_SELECT} FROM coils WHERE lower(coil_number) = ANY($1::text[]) FOR UPDATE`, [keys])
      const existing = new Map(existingRows.map((c) => [mtcCoilKey(c.coilNumber), c]))

      const toInsert: MtcCoil[] = []
      const toUpdate: { id: string; before: Coil; after: MtcCoil }[] = []
      const out: MtcSaveResponse = { inserted: [], updated: [], skipped: [] }
      for (const { coil, overwrite } of rows) {
        const found = existing.get(mtcCoilKey(coil.coilNumber))
        if (!found) {
          toInsert.push(coil)
          continue
        }
        const current = mtcCoilOf(found)
        if (!overwrite || (mtcChangedFields(current, coil).length === 0 && !found.deletedAt)) {
          out.skipped.push(found.coilNumber)
          continue
        }
        toUpdate.push({ id: found.id, before: found, after: mtcMerged(current, coil) })
      }

      const at = new Date().toISOString()
      const audit: AuditDraft[] = []
      const auditCtx = (id: string) => ({ userId: user.id, userName: user.name, entity: 'Coil', entityId: id })

      if (toInsert.length > 0) {
        let inserted: { id: string; coilNumber: string }[]
        try {
          inserted = (
            await tx.query<{ id: string; coilNumber: string }>(
              `INSERT INTO coils (coil_number, grade, sm_type, supplier, thickness, width, yield, notes)
               SELECT i.coil_number, i.grade, i.sm_type, i.supplier, i.thickness, i.width, i.yield, i.notes
                 FROM jsonb_to_recordset($1::jsonb) AS i(coil_number text, grade text, sm_type text, supplier text, thickness numeric, width numeric, yield numeric, notes text)
               RETURNING id, coil_number AS "coilNumber"`,
              [JSON.stringify(toInsert.map(columnsOf))],
            )
          ).rows
        } catch (e) {
          // Someone registered one of these coils since the review was opened.
          if (pgCode(e) === PG.UNIQUE_VIOLATION) throw duplicate('One of these coils was registered by someone else meanwhile. Review the list again before saving.')
          throw e
        }
        const byNumber = new Map(toInsert.map((c) => [mtcCoilKey(c.coilNumber), c]))
        for (const row of inserted) {
          out.inserted.push(row.coilNumber)
          const c = byNumber.get(mtcCoilKey(row.coilNumber))!
          // One entry per coil: where it came from and what it was registered with.
          const values = Object.entries(auditValues(c))
            .filter(([, v]) => v !== '')
            .map(([k, v]) => `${k} ${v}`)
            .join('; ')
          audit.push(auditEvent('create', auditCtx(row.id), at, { field: 'source', newValue: `MTC upload: ${body.fileName}${values ? ` — ${values}` : ''}` }))
        }
      }

      for (const u of toUpdate) {
        await tx.query(
          `UPDATE coils SET grade = $2, sm_type = $3, supplier = $4, thickness = $5, width = $6, yield = $7, notes = $8,
                  deleted_at = NULL, deleted_by_id = NULL
            WHERE id = $1`,
          [u.id, u.after.grade ?? null, u.after.smType ?? null, u.after.supplier ?? null, u.after.thickness ?? null, u.after.width ?? null, u.after.yield ?? null, u.after.notes ?? null],
        )
        out.updated.push(u.before.coilNumber)
        if (u.before.deletedAt) audit.push(auditEvent('restore', auditCtx(u.id), at, { field: 'source', newValue: `MTC upload: ${body.fileName}` }))
        const before = auditValues(mtcCoilOf(u.before))
        const after = auditValues(u.after)
        for (const field of Object.keys(after)) {
          if (before[field] !== after[field]) audit.push(auditEvent('update', auditCtx(u.id), at, { field, oldValue: before[field], newValue: after[field] }))
        }
        audit.push(auditEvent('update', auditCtx(u.id), at, { field: 'source', newValue: `MTC upload: ${body.fileName}` }))
      }

      for (let i = 0; i < audit.length; i += AUDIT_CHUNK) await writeAudit(tx, audit.slice(i, i + AUDIT_CHUNK))
      return out
    })
    res.json(result)
  })

  return r
}
