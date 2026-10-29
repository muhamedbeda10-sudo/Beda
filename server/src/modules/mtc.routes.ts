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
  MTC_MAX_IMAGE_BYTES,
  MTC_MAX_IMAGES,
  MTC_MAX_PDF_BYTES,
  MTC_MAX_SHEET_CHARS,
  MTC_MAX_ROWS,
  MTC_TABLE_PAGE,
  MTC_TABLE_PAGE_MAX,
  MTC_ADDED_COLUMN,
  isMtcKind,
  MTC_REGISTERS,
  mtcChangedFields,
  mtcDoubtShare,
  mtcDuplicateKeys,
  mtcIdField,
  mtcKeyLabel,
  mtcKeyOf,
  mtcMerged,
  mtcInputFields,
  mtcRowProblems,
  mtcValuesOf,
  type DeliveryNoteExtractResult,
  type MtcExistingResponse,
  type MtcExtractResult,
  type MtcRegisterRow,
  type MtcSaveResponse,
  type MtcStandard,
  type MtcTableOptionsResponse,
  type MtcTableResponse,
  type MtcValues,
} from '@qc/shared/mtc'
import { AI_JOBS, AI_MTC_REREAD_SHARE, type AiEffort } from '@qc/shared/ai'
import type { ApiErrorCode } from '@qc/shared/api'
import { auditEvent, type AuditDraft } from '@qc/shared/audit'
import type { AppContext } from '../context'
import { withTransaction, PG, pgCode } from '../db/pool'
import { HttpError, badRequest, duplicate, forbidden, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { RateLimiter } from '../lib/rateLimit'
import { requireUser, userCan } from '../auth/middleware'
import { writeAudit } from '../audit/service'
import { isPdf } from '../ai/attachments'
import { describeModelFailure, usageOf } from '../ai/assistant'
import { modelPrice } from '../ai/models'
import { aiOwnerAccount } from '../ai/owner'
import { capPassed, holdUnderCaps, loadAccess, mayUploadMtc, releaseHold } from '../ai/access'
import { loadAiSettings } from '../ai/settings'
import { resolveApiKey } from '../ai/credentials'
import { recordUsage } from '../ai/transcript'
import type { ModelMessage, ModelParams, ModelStream } from '../ai/model'
import { SseStream } from '../ai/sse'
import { MTC_MAX_TOKENS, MTC_PROMPT_TOKENS, MtcReadError, mtcMessages, mtcRequest, readMtcReply, type MtcImageType, type MtcSource } from '../mtc/reader'
import { deliveryMessages, deliveryRequest, readDeliveryReply } from '../mtc/deliveryReader'
import { isXlsx, keepDocument } from '../mtc/documents'
import { judgeCoils } from '../mtc/standards'
import { mtcRecordRoutes } from './mtcRecords.routes'
import { sniffImageMime } from '../images/storage'
import { REGISTER_TABLES, col, rowSql, valuesSql, type RegisterTable } from '../mtc/registers'
import { columnFilterClauses, columnOrderBy, columnQuerySchema, columnValues, type SqlColumns } from '../lib/columnFilters'

/** Certificates one person may have read in an hour: far more than a delivery brings, few enough that a stuck client cannot run up the bill. */
const READS_PER_HOUR = 30
/** Audit entries per INSERT: under PostgreSQL's 65,535 parameters at 14 a row. */
const AUDIT_CHUNK = 2_000

/** How a reading ended, as the owner's Activity tells it. */
type ReadingOutcome = 'read' | 'not-certificate' | 'failed' | 'stopped'

/** One call of a reading, as far as it got: what it is billed for. */
interface ReadingCall {
  message: ModelMessage
  model: string
  requestId: string | null
  partial: boolean
  /** The hold the call was made under: settled as its cost is kept. */
  holdId: string
}

/**
 * Log one reading and what each of its calls cost (two when it was read
 * again), in one transaction: the reading, then each call's usage pointing at
 * it. Only a reading that cost something is logged: one refused before any
 * call is no reading.
 */
async function logReading(
  ctx: AppContext,
  r: {
    userId: string
    fileName: string
    outcome: ReadingOutcome
    kind: string | null
    items: number | null
    reread: boolean
    calls: ReadingCall[]
    documentId: string | null
  },
): Promise<void> {
  if (r.calls.length === 0) return
  await withTransaction(ctx.db, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO mtc_readings (user_id, file_name, kind, items, outcome, reread, document_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [r.userId, r.fileName, r.kind, r.items, r.outcome, r.reread, r.documentId],
    )
    for (const c of r.calls) {
      const usage = usageOf(c.message, c.model)
      await recordUsage(tx, {
        userId: r.userId,
        conversationId: null,
        turnId: null,
        mtcReadingId: rows[0].id,
        model: usage.model,
        tokens: usage.tokens,
        costUsd: usage.costUsd,
        requestId: c.requestId,
        partial: c.partial,
        holdId: c.holdId,
      })
    }
  })
}

/**
 * What one kind of document is read for: a certificate (into a register) or
 * a delivery note. The reading itself — counting, the caps, the stream, a
 * second reading on the stronger model, the log — is the same for both.
 */
interface ReadingJob<R> {
  /** "certificate", "delivery note": for the person's messages. */
  noun: string
  messages: (source: MtcSource, fileName: string) => Anthropic.Beta.BetaMessageParam[]
  request: (source: MtcSource, fileName: string, run: { model: string; effort: AiEffort }) => ModelParams
  /** The reply as the review's; throws MtcReadError when it is unusable. */
  read: (message: ModelMessage, fileName: string) => R
  /** Too doubtful to hand over as it is: read again on the stronger model. */
  doubtful: (r: R) => boolean
  /** What the log records: the kind it turned out to be (null: not what was asked for), and how many items. */
  tally: (r: R) => { kind: string | null; items: number }
  addProblem: (r: R, text: string) => void
  setDocument: (r: R, id: string) => void
}

/** The register a request names, or 404: the name never reaches SQL, its table does. */
function registerOf(kind: string): RegisterTable {
  if (!isMtcKind(kind)) throw notFound('That register')
  return REGISTER_TABLES[kind]
}

/** A table row as the API sends it: its certificate and its grade's limits only when there are any. */
const tableRow = (row: MtcRegisterRow & { documentId: string | null; standard: MtcStandard | null }): MtcRegisterRow => {
  const { documentId, standard, ...rest } = row
  return { ...rest, ...(documentId ? { documentId } : {}), ...(standard ? { standard } : {}) }
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

/** A reviewed item as the API takes it: every field cleaned by its kind; a value that is not one is kept as NaN so the checks refuse it. */
function reviewedValues(t: RegisterTable, raw: Record<string, unknown>): MtcValues {
  const values = mtcValuesOf(t.register, raw)
  for (const f of mtcInputFields(t.register)) {
    const v = raw[f.key]
    const blank = v === undefined || v === null || (typeof v === 'string' && v.trim() === '')
    if (blank || values[f.key] !== undefined) continue
    values[f.key] = Number.NaN
  }
  return values
}

/** An item's fields as the audit trail shows them, one value per field (the key fields name the item). */
const auditValues = (t: RegisterTable, v: MtcValues): Record<string, string> =>
  Object.fromEntries(mtcInputFields(t.register).filter((f) => !f.identifies).map((f) => [f.key, v[f.key] === undefined ? '' : String(v[f.key])]))

const saveSchema = z.object({
  fileName: z
    .string()
    .max(500)
    .transform((v) => (v.replace(/\s+/g, ' ').trim() || 'certificate.pdf').slice(0, 255)),
  documentId: z.string().uuid().optional(),
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

  /**
   * The registers are the MTC screen's (§14): read by those who may open it.
   * The welding wire register is also read by whoever records inspections —
   * the PT step suggests its batches; and an uploader compares a reading with
   * what is registered, whether or not they may open the screen.
   */
  const readerOnly =
    (forUploaders: boolean): RequestHandler =>
    async (req, _res, next) => {
      const user = requireUser(req)
      if (userCan(user, 'view-mtc')) return next()
      if (String(req.params.kind) === 'welding-wire' && userCan(user, 'record-inspection')) return next()
      if (forUploaders) {
        const owner = (await aiOwnerAccount(ctx.db, ctx.config)) === user.id
        if (mayUploadMtc(await loadAccess(ctx.db, user.id), owner, true)) return next()
      }
      next(forbidden())
    }

  // A name in Arabic arrives as UTF-8: read it so, not as Latin-1 (multer's default; its types do not list the option yet).
  // A certificate comes as one PDF ("file"), as photos of its pages ("images", in order), or as its spreadsheet's text read on
  // the device ("sheet", with "fileName"): one of the three.
  const uploadOptions: multer.Options & { defParamCharset: string } = {
    storage: multer.memoryStorage(),
    defParamCharset: 'utf8',
    limits: { fileSize: MTC_MAX_PDF_BYTES, files: MTC_MAX_IMAGES + 2, fields: 2, fieldSize: MTC_MAX_SHEET_CHARS * 4 },
  }
  const upload = multer(uploadOptions)
  const receiveFile: RequestHandler = (req, res, next) =>
    upload.fields([
      { name: 'file', maxCount: 1 },
      { name: 'images', maxCount: MTC_MAX_IMAGES },
      // A spreadsheet's workbook beside its text, to keep.
      { name: 'original', maxCount: 1 },
    ])(req, res, (err: unknown) => {
      const code = (err as { code?: string } | undefined)?.code
      if (code === 'LIMIT_FILE_SIZE') {
        return next(new HttpError(413, 'payload_too_large', `A certificate may be at most ${MTC_MAX_PDF_BYTES / 1024 / 1024} MB. Split the PDF and upload the parts.`))
      }
      if (code === 'LIMIT_FILE_COUNT' || code === 'LIMIT_UNEXPECTED_FILE') {
        return next(badRequest(`Upload one PDF, one spreadsheet, or up to ${MTC_MAX_IMAGES} photos of the certificate’s pages.`))
      }
      if (code === 'LIMIT_FIELD_VALUE') return next(badRequest('That spreadsheet is too long to read in one go. Split it and upload the parts.'))
      next(err)
    })

  /** The document as it was uploaded, checked by its bytes; its name for the review and the Activity; a spreadsheet's workbook, to keep. */
  const sourceOf = (req: Parameters<RequestHandler>[0], noun: string): { source: MtcSource; fileName: string; workbook: Buffer | null } => {
    const files = (req.files ?? {}) as Record<string, Express.Multer.File[] | undefined>
    const pdf = files.file?.[0]
    const images = files.images ?? []
    const original = files.original?.[0]
    // A form's text field arrives with its line breaks as CRLF: one LF each, as read.
    const sheet = typeof req.body?.sheet === 'string' ? (req.body.sheet as string).replace(/\r\n?/g, '\n').trim() : ''
    const named = (raw: string | undefined, fallback: string) => (raw ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 255) || fallback
    const given = [pdf ? 1 : 0, images.length ? 1 : 0, sheet ? 1 : 0].reduce((a, b) => a + b, 0)
    if (given === 0) throw badRequest(`Upload the ${noun}: its PDF, photos of its pages, or its spreadsheet.`)
    if (given > 1) throw badRequest(`Upload one ${noun} at a time: its PDF, its photos, or its spreadsheet.`)
    if (original && !sheet) throw badRequest('A workbook comes with its spreadsheet’s text.')
    if (pdf) {
      if (!isPdf(pdf.buffer)) throw badRequest(`This is not a PDF. Upload the ${noun} as the supplier sent it, or photos of its pages.`)
      return { source: { kind: 'pdf', data: pdf.buffer }, fileName: named(pdf.originalname, 'certificate.pdf'), workbook: null }
    }
    if (images.length) {
      const read = images.map((f) => {
        const type = sniffImageMime(f.buffer.subarray(0, 16))
        if (!type) throw badRequest(`“${named(f.originalname, 'photo')}” is not a photo Claude can read. Take or save it as JPEG or PNG.`)
        if (f.size > MTC_MAX_IMAGE_BYTES) throw badRequest(`“${named(f.originalname, 'photo')}” is larger than ${MTC_MAX_IMAGE_BYTES / 1024 / 1024} MB.`)
        return { type: type as MtcImageType, data: f.buffer }
      })
      const first = named(images[0].originalname, 'photo')
      return { source: { kind: 'images', images: read }, fileName: named(req.body?.fileName, images.length === 1 ? first : `${first} (+${images.length - 1} photos)`), workbook: null }
    }
    if (sheet.length > MTC_MAX_SHEET_CHARS) throw badRequest('That spreadsheet is too long to read in one go. Split it and upload the parts.')
    return { source: { kind: 'sheet', text: sheet }, fileName: named(req.body?.fileName, 'certificate.xlsx'), workbook: original && isXlsx(original.buffer) ? original.buffer : null }
  }

  /** The certificate taken in: its parts, as the upload's own checks let them through. */
  const receive = (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]): Promise<void> =>
    new Promise((resolve, reject) => {
      void receiveFile(req, res, (err?: unknown) => (err ? reject(err) : resolve()))
    })

  /** One upload at a time per person, and so many an hour: checked before the file is taken in. */
  const readingRoute =
    <R>(job: ReadingJob<R>): RequestHandler =>
    async (req, res) => {
      const user = requireUser(req)
      // The reading is marked as under way in the same tick as the check, before anything is awaited, so a second upload
      // sent meanwhile is refused; and let go however this request ends.
      if (reading.has(user.id)) throw new HttpError(429, 'rate_limited', `A ${job.noun} of yours is still being read. Wait for it to finish.`)
      const wait = reads.hit(user.id)
      if (wait > 0) throw new HttpError(429, 'rate_limited', `Too many documents read in the last hour. Try again in ${Math.ceil(wait / 60)} min.`)
      reading.add(user.id)
      try {
        await receive(req, res)
        await runReading(req, res, user, job)
      } finally {
        reading.delete(user.id)
      }
    }

  r.post(
    '/extract',
    uploaderOnly,
    readingRoute<MtcExtractResult>({
      noun: 'certificate',
      messages: mtcMessages,
      request: mtcRequest,
      read: readMtcReply,
      // Nothing listed, or too many values unsure.
      doubtful: (r) => !!r.kind && (r.rows.length === 0 || mtcDoubtShare(MTC_REGISTERS[r.kind], r.rows) > AI_MTC_REREAD_SHARE),
      tally: (r) => ({ kind: r.kind, items: r.rows.length }),
      addProblem: (r, text) => {
        r.problem = [r.problem, text].filter(Boolean).join(' ')
      },
      setDocument: (r, id) => {
        r.documentId = id
      },
    }),
  )

  r.post(
    '/delivery-notes/extract',
    uploaderOnly,
    readingRoute<DeliveryNoteExtractResult>({
      noun: 'delivery note',
      messages: deliveryMessages,
      request: deliveryRequest,
      read: readDeliveryReply,
      // No coils, or no day: read again.
      doubtful: (r) => !!r.note && (r.note.coils.length === 0 || !r.note.deliveryDate),
      tally: (r) => ({ kind: r.note ? 'delivery-note' : null, items: r.note?.coils.length ?? 0 }),
      addProblem: (r, text) => {
        r.problem = [r.problem, text].filter(Boolean).join(' ')
      },
      setDocument: (r, id) => {
        r.documentId = id
      },
    }),
  )

  /** Read the document taken in, streaming how it goes; each call's worst case held against the caps while it is under way. */
  async function runReading<R>(req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1], user: ReturnType<typeof requireUser>, job: ReadingJob<R>): Promise<void> {
    const { source, fileName, workbook } = sourceOf(req, job.noun)

    // Read one after another, as the answer loop does: the assistant's switch, its key, its monthly cap, the model for certificates.
    const owner = (await aiOwnerAccount(ctx.db, ctx.config)) === user.id
    const { settings } = await loadAiSettings(ctx.db)
    const { apiKey } = await resolveApiKey(ctx.db, ctx.config)
    if (!settings.enabled || !apiKey) {
      throw new HttpError(
        503,
        'ai_unavailable',
        owner
          ? `Reading a ${job.noun} uses the AI assistant, which is switched off or has no API key. Set it up under Administration → AI assistant.`
          : `The ${job.noun} cannot be read right now: the AI service is not available. Ask your administrator.`,
      )
    }
    // Read on Sonnet; a doubtful reading is read again on Opus (AI_JOBS).
    const first = AI_JOBS.mtc
    const rereadOn = AI_JOBS['mtc-reread'].model
    const access = await loadAccess(ctx.db, user.id)

    /** What Claude makes of the file on a model (free): it proves the file can be read, and prices the call's worst case. */
    const count = async (model: string): Promise<number> => {
      try {
        return await ctx.ai.countTokens(apiKey, { model, messages: job.messages(source, fileName) })
      } catch (e) {
        if (e instanceof Anthropic.BadRequestError) {
          throw badRequest(
            source.kind === 'pdf'
              ? 'Claude cannot read this PDF. It may be damaged, password-protected or longer than 100 pages: split it, or upload another copy.'
              : source.kind === 'images'
                ? 'Claude cannot read these photos. Take them again as JPEG or PNG, one page each.'
                : 'Claude cannot read this spreadsheet. Save it again as .xlsx and upload it.',
          )
        }
        const failure = describeModelFailure(e, `none (counting a ${job.noun})`, owner)
        throw new HttpError(failure.code === 'rate_limited' ? 429 : failure.code === 'ai_unavailable' ? 503 : 502, failure.code, failure.message)
      }
    }
    /**
     * A call of this many tokens on this model, its worst case held against the assistant's cap and the person's own
     * (certificates count in it like questions) while it is under way; or the cap it would pass.
     */
    const hold = async (model: string, tokens: number): Promise<{ holdId: string } | { refused: 'app' | 'personal' }> => {
      const price = modelPrice(model)
      const worstUsd = ((tokens + MTC_PROMPT_TOKENS) * Math.max(price.input, price.cacheWrite5m) + MTC_MAX_TOKENS * price.output) / 1_000_000
      return holdUnderCaps(ctx.db, user.id, worstUsd, async (tx) =>
        capPassed(tx, user.id, worstUsd, { appUsd: (await loadAiSettings(tx)).settings.monthlyCapUsd, personalUsd: access ? access.monthlyCapUsd : null }),
      )
    }

    const calls: ReadingCall[] = []
    const holds: string[] = []
    // Whether the calls' costs were kept (which settles their holds): until they are, the holds keep counting, and lapse.
    let logged = false
    try {
      const held = await hold(first.model, await count(first.model))
      if ('refused' in held && held.refused === 'app') {
        throw new HttpError(
          402,
          'ai_budget_reached',
          owner
            ? `The AI assistant’s monthly limit is too close to read this ${job.noun}. You can raise it under Administration → AI assistant.`
            : 'The AI service’s monthly limit is reached, so documents cannot be read until the 1st.',
        )
      }
      if ('refused' in held) {
        throw new HttpError(
          402,
          'ai_budget_reached',
          owner
            ? `Your own monthly AI limit is too close to read this ${job.noun}. You can raise it in the AI settings, under Who can use it.`
            : 'You have reached this month’s AI limit, so documents cannot be read until the 1st. Ask the AI assistant’s owner to raise it.',
        )
      }
      holds.push(held.holdId)

      const stream = new SseStream(res)
      stream.open()
      const send = (event: { type: 'reading' } | { type: 'rereading'; model: string } | { type: 'result'; result: R } | { type: 'error'; code: ApiErrorCode; message: string }) =>
        stream.send(event)
      send({ type: 'reading' })

      // A person who closes the page lets go of the reading: it is stopped, so it costs no more.
      const abort = new AbortController()
      res.on('close', () => {
        if (!res.writableFinished) abort.abort()
      })
      let current: { stream: ModelStream; model: string; holdId: string } | null = null
      /** One reading of the file under its hold: its reply, kept with what it cost. */
      const readOn = async (run: { model: string; effort: AiEffort }, holdId: string): Promise<ModelMessage> => {
        const call = ctx.ai.stream(apiKey, job.request(source, fileName, run), { signal: abort.signal })
        current = { stream: call, model: run.model, holdId }
        const message = await call.finalMessage()
        current = null
        calls.push({ message, model: run.model, requestId: call.request_id ?? null, partial: false, holdId })
        return message
      }
      const log = { userId: user.id, fileName }
      let reread = false
      try {
        let result: R | null = null
        let failed: unknown = null
        try {
          result = job.read(await readOn(first, held.holdId), fileName)
        } catch (e) {
          if (!(e instanceof MtcReadError)) throw e
          failed = e
        }
        // Too doubtful to hand over as it is — nothing usable, or the job's own doubt: read again on the stronger model.
        const doubtful = (failed instanceof MtcReadError && !failed.tooLong) || (result !== null && job.doubtful(result))
        if (doubtful) {
          const again = await hold(rereadOn, await count(rereadOn).catch(() => Number.POSITIVE_INFINITY))
          if ('refused' in again) {
            if (result) job.addProblem(result, 'Many values were unclear, and the monthly AI limit is too close to read it again on a stronger model: check every amber cell.')
          } else {
            holds.push(again.holdId)
            send({ type: 'rereading', model: rereadOn })
            try {
              result = job.read(await readOn(AI_JOBS['mtc-reread'], again.holdId), fileName)
              failed = null
              reread = true
            } catch (e) {
              // The second reading failed in its turn: the first stands, if there was one.
              if (!(e instanceof MtcReadError)) throw e
              if (!result) failed = e
            }
          }
        }
        if (!result) throw failed
        const { kind, items } = job.tally(result)
        // The file is kept to open again once it was read as what was asked; a failure to keep it costs the reading nothing.
        let documentId: string | null = null
        if (kind) {
          documentId = await keepDocument(ctx, source, workbook, fileName, user.id).catch((e: unknown) => {
            console.error(`[mtc] a ${job.noun} could not be kept`, e)
            return null
          })
          if (documentId) job.setDocument(result, documentId)
        }
        await logReading(ctx, { ...log, outcome: kind ? 'read' : 'not-certificate', kind, items, reread, calls, documentId })
        logged = true
        send({ type: 'result', result })
      } catch (e) {
        // Whatever was read before it failed or was stopped is still billed: kept as partial, like a cut-off answer.
        const cut = current as { stream: ModelStream; model: string; holdId: string } | null
        if (cut?.stream.currentMessage) calls.push({ message: cut.stream.currentMessage, model: cut.model, requestId: cut.stream.request_id ?? null, partial: true, holdId: cut.holdId })
        if (!logged) {
          await logReading(ctx, { ...log, outcome: abort.signal.aborted ? 'stopped' : 'failed', kind: null, items: null, reread, calls, documentId: null }).then(
            () => {
              logged = true
            },
            (err: unknown) => console.error('[mtc] could not log a reading that did not finish', err),
          )
        }
        if (abort.signal.aborted) return
        if (e instanceof MtcReadError) send({ type: 'error', code: 'validation', message: e.message })
        else {
          const failure = describeModelFailure(e, `none (reading a ${job.noun})`, owner)
          send({ type: 'error', code: failure.code, message: failure.message })
        }
      } finally {
        stream.end()
      }
    } finally {
      // Settled as the calls' costs were kept; a call that cost nothing (refused, never begun) lets its hold go. Costs
      // that could not be kept leave their holds counting until they lapse.
      if (logged || calls.length === 0) {
        for (const id of holds) await releaseHold(ctx.db, id).catch((e: unknown) => console.warn("[mtc] a call's hold could not be let go; it lapses on its own:", e instanceof Error ? e.message : String(e)))
      }
    }
  }

  /**
   * A register's columns for Excel's filter and sort: each field's text as the
   * table shows it (a measurement without trailing zeros), sorted by its value;
   * and when it was registered, as a factory day.
   */
  const sqlColumns = (t: RegisterTable): SqlColumns => {
    const out: SqlColumns = {}
    for (const f of t.register.fields) {
      out[f.key] =
        f.type === 'number'
          ? { text: `trim_scale(${col(t, f.key)})::text`, sort: col(t, f.key) }
          : f.type === 'date'
            ? { text: `to_char(${col(t, f.key)}, 'YYYY-MM-DD')`, sort: col(t, f.key) }
            : { text: col(t, f.key) }
    }
    out[MTC_ADDED_COLUMN] = { text: `to_char(created_at AT TIME ZONE '${ctx.config.FACTORY_TIMEZONE.replace(/'/g, "''")}', 'YYYY-MM-DD')`, sort: 'created_at' }
    return out
  }
  const tableQuery = z.object({ search: z.string().trim().max(120).default('') }).merge(columnQuerySchema)

  /** What the table's filters leave of a register: the words anywhere in its text fields, then each column's filter. */
  function tableWhere(t: RegisterTable, q: z.infer<typeof tableQuery>, params: unknown[], exceptColumn?: string): string[] {
    const p = (v: unknown) => `$${params.push(v)}`
    const where = ['deleted_at IS NULL']
    if (q.search) {
      const term = p(`%${escapeLike(q.search)}%`)
      where.push(`(${t.register.fields.filter((f) => f.type === 'text').map((f) => `${col(t, f.key)} ILIKE ${term}`).join(' OR ')})`)
    }
    return [...where, ...columnFilterClauses(sqlColumns(t), q.cf, p, exceptColumn)]
  }

  /** A register as a table, for those who may open the screen, a page at a time with the total, filtered and sorted as History is. */
  r.get('/:kind/table', readerOnly(false), async (req, res) => {
    const t = registerOf(String(req.params.kind))
    const q = parse(
      tableQuery.extend({
        offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
        limit: z.coerce.number().int().min(1).max(MTC_TABLE_PAGE_MAX).default(MTC_TABLE_PAGE),
      }),
      req.query,
    )
    const params: unknown[] = []
    const where = tableWhere(t, q, params).join(' AND ')
    const keyOrder = t.register.fields
      .filter((f) => f.identifies)
      .map((f) => (f.type === 'text' ? `lower(${col(t, f.key)})` : col(t, f.key)))
      .join(', ')
    const order = columnOrderBy(sqlColumns(t), q.sort, keyOrder)
    const total = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t.table} WHERE ${where}`, params)
    const { rows } = await ctx.db.query<MtcRegisterRow & { documentId: string | null; standard: MtcStandard | null }>(
      `SELECT id, ${valuesSql(t)} AS "values", created_at AS "createdAt", ${t.documentColumn} AS "documentId",
              ${t.standardSql ?? 'NULL::jsonb'} AS standard
         FROM ${t.table} WHERE ${where}
        ORDER BY ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, q.limit, q.offset],
    )
    const body: MtcTableResponse = { rows: rows.map(tableRow), total: total.rows[0].n }
    res.json(body)
  })

  /** One column's values under the table's other filters, for its menu. */
  r.get('/:kind/values', readerOnly(false), async (req, res) => {
    const t = registerOf(String(req.params.kind))
    const q = parse(tableQuery.extend({ column: z.string().max(60), columnSearch: z.string().max(200).optional() }), req.query)
    const params: unknown[] = []
    const where = tableWhere(t, { ...q, cf: {} }, params)
    res.json(await columnValues(ctx.db, { columns: sqlColumns(t), column: q.column, from: `FROM ${t.table}`, where, params, filters: q.cf, search: q.columnSearch }))
  })

  /** The table's filter choices: the suppliers and the filter field's values registered, once each whatever their case. */
  r.get('/:kind/options', readerOnly(false), async (req, res) => {
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
  r.post('/:kind/existing', readerOnly(true), async (req, res) => {
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
      const fields = mtcInputFields(register)
      const doc = body.documentId ?? null

      if (toInsert.length > 0) {
        const columns = fields.map((f) => col(t, f.key)).join(', ')
        const recordset = fields.map((f) => `${col(t, f.key)} ${f.type === 'number' ? 'numeric' : 'text'}`).join(', ')
        const payload = toInsert.map((v) => Object.fromEntries(fields.map((f) => [t.columns[f.key], v[f.key] ?? null])))
        let inserted: { id: string; values: MtcValues }[]
        try {
          inserted = (
            await tx.query<{ id: string; values: MtcValues }>(
              `INSERT INTO ${t.table} (${columns}, ${t.documentColumn})
               SELECT ${columns}, $2::uuid FROM jsonb_to_recordset($1::jsonb) AS i(${recordset})
               RETURNING id, ${valuesSql(t)} AS "values"`,
              [JSON.stringify(payload), doc],
            )
          ).rows
        } catch (e) {
          // Someone registered one of these items since the review was opened.
          if (pgCode(e) === PG.UNIQUE_VIOLATION) throw duplicate(`One of these ${register.plural} was registered by someone else meanwhile. Review the list again before saving.`)
          if (pgCode(e) === PG.FOREIGN_KEY_VIOLATION) throw badRequest('The certificate this list was read from is not on record. Upload it again.')
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
          `UPDATE ${t.table} SET ${changing.map((f, i) => `${col(t, f.key)} = $${i + 2}`).join(', ')},
                  ${t.documentColumn} = COALESCE($${changing.length + 2}::uuid, ${t.documentColumn}), deleted_at = NULL, deleted_by_id = NULL WHERE id = $1`,
          [u.before.id, ...changing.map((f) => u.after[f.key] ?? null), doc],
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
      // A coil's certified strengths are judged against its grade as it is saved (the table's green and red).
      if (register.kind === 'coils') {
        const { rows: saved } = await tx.query<{ id: string }>(`SELECT id FROM coils WHERE lower(coil_number) = ANY($1::text[])`, [ids])
        await judgeCoils(
          tx,
          saved.map((x) => x.id),
        )
      }
      return out
    })
    res.json(result)
  })

  // Delivery notes, kept documents, a coil's details and its slitting.
  const mayUpload = async (userId: string) => mayUploadMtc(await loadAccess(ctx.db, userId), (await aiOwnerAccount(ctx.db, ctx.config)) === userId, true)
  r.use(mtcRecordRoutes(ctx, { uploaderOnly, mayUpload }))

  return r
}
