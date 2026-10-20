// ============================================================================
// The Reports page: the saved reports their owners shared with this person
// (ai/reportShares.ts), whether or not they have the AI assistant. Signed in
// is all it takes; a report not shared with them answers 404, as one that does
// not exist would, and unsharing or deleting it takes effect at the next
// request.
//
// A recipient opens it (what it shows and asks for, never its SQL), runs it
// with the values its inputs take and, when its period can change, other
// days — checked exactly as its owner's run is — and takes it to Excel in its
// style with the app's permission to export records. It runs as its owner's
// domains as they are now; an owner who no longer has the assistant runs it
// for no one, and the page says so. Each run counts against the person's
// report-run limit, its queries are known as theirs for this report, and it is
// recorded for the owner (ai_report_runs).
// ============================================================================

import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import type { SharedReport, SharedReportRunResponse, SharedReportsResponse, SharedReportsStatus } from '@qc/shared/reportShares'
import { BUILTIN_RESOLVED_STYLE } from '@qc/shared/reportStyles'
import type { AppContext } from '../context'
import { withTransaction } from '../db/pool'
import { HttpError, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { sendWorkbook } from '../lib/download'
import { requireUser, userCan, type AuthUser } from '../auth/middleware'
import { readRunRequest, runOf } from '../ai/reportRequest'
import { exportReportSections, markReportRun, runReportSections } from '../ai/reports'
import {
  SHARED_NO_ACCESS,
  anySharedReports,
  findSharedReport,
  keepRunPhotos,
  listSharedReports,
  ownerGone,
  ownerMayRun,
  ownerReader,
  recordRecipientRun,
  toSharedReport,
  type SharedRecord,
} from '../ai/reportShares'
import { withQueryOrigin } from '../ai/slowQueries'
import { styleOfReport } from '../reportStyles/styles'
import { styledWorkbook } from '../reportStyles/styledWorkbook'
import { reportFileName, reportWorkbookDoc } from '../reportStyles/documents'

const uuid = z.string().uuid()

const listQuery = z.object({
  before: z.string().datetime({ offset: true }).optional(),
  /** With `before`, the last report of the page read: two changed in one millisecond are both reached. */
  beforeId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  q: z.string().trim().max(200).optional(),
})

/** Excel of a shared report: for whoever may export records in the app. */
const mayExport = (user: AuthUser) => userCan(user, 'export-records')

export function sharedReportsRoutes(ctx: AppContext): Router {
  const r = Router()
  const db = ctx.db
  const tz = ctx.config.FACTORY_TIMEZONE

  /** Whether anything is shared with the person: whether the Reports page is in their menu. */
  r.get('/status', async (req, res) => {
    const body: SharedReportsStatus = { any: await anySharedReports(db, requireUser(req).id) }
    res.json(body)
  })

  r.get('/', async (req, res) => {
    const user = requireUser(req)
    const q = parse(listQuery, req.query)
    const body: SharedReportsResponse = await listSharedReports(db, user.id, { before: q.before ?? null, beforeId: q.beforeId ?? null, limit: q.limit, search: q.q || null })
    res.json(body)
  })

  /** The report shared with the person, as they see it; 404 to anyone it is not shared with. */
  async function shared(req: Request): Promise<{ user: AuthUser; report: SharedRecord }> {
    const user = requireUser(req)
    const report = await findSharedReport(db, parse(uuid, req.params.id).toLowerCase(), user.id)
    if (!report) throw notFound('That report')
    return { user, report }
  }

  r.get('/:id', async (req, res) => {
    const { user, report } = await shared(req)
    const body: SharedReport = toSharedReport(report, { available: await ownerMayRun(db, report), excel: mayExport(user) })
    res.json(body)
  })

  /**
   * A run asked for: the report shared with the person, the days and values it runs with (checked as its owner's
   * run checks them), counted against their limit; refused while its owner cannot run it. Its sections run as the
   * owner's domains as they are when each starts.
   */
  async function toRun(req: Request, res: Response, may: (user: AuthUser) => void = () => {}) {
    // The browser leaving stops the queries still to run, inside PostgreSQL too.
    const ac = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) ac.abort()
    })
    const { user, report } = await shared(req)
    may(user)
    const { period, values } = runOf(report, readRunRequest(req.query as Record<string, unknown>), tz)
    const wait = ctx.aiReportLimiter.hit(user.id)
    if (wait > 0) throw new HttpError(429, 'rate_limited', `Too many report runs in a short time. Try again in ${wait} seconds.`)
    if (!(await ownerMayRun(db, report))) throw new HttpError(409, 'conflict', ownerGone(report.ownerName))
    if (!ctx.aiReader.ready) throw new HttpError(503, 'ai_unavailable', 'The reports cannot reach their data right now. Try again later.')
    const reader = ownerReader(db, ctx.aiReader, report)
    // Known as this person's queries, for this report: the slow-query list and the logs name both.
    const origin = { source: 'report' as const, userId: user.id, purpose: `Shared report "${report.title}" (${report.id})` }
    return { user, report, period, values, reader, origin, signal: ac.signal }
  }

  r.get('/:id/run', async (req, res) => {
    const { user, report, period, values, reader, origin, signal } = await toRun(req, res)
    const ranAt = new Date().toISOString()
    const sections = await withQueryOrigin(origin, () => runReportSections(reader, report, period, { timeZone: tz, signal, values, noAccess: SHARED_NO_ACCESS }))
    // Recorded for the owner; the photos it showed are this person's to open for a while.
    await withTransaction(db, async (tx) => {
      await recordRecipientRun(tx, report.id, user.id, 'run')
      await keepRunPhotos(tx, report.id, user.id, sections)
    })
    await markReportRun(db, report)
    const style = (await styleOfReport(db, report.styleId)) ?? BUILTIN_RESOLVED_STYLE
    const body: SharedReportRunResponse = { report: toSharedReport(report, { available: true, excel: mayExport(user) }), period, sections, inputs: values, ranAt, style }
    res.json(body)
  })

  /** The report run now in full, as a workbook drawn in its style — without its SQL; for whoever may export records. */
  r.get('/:id/workbook', async (req, res) => {
    // Who may not export is told so only about a report shared with them: to anyone else it does not exist.
    const { user, report, period, values, reader, origin, signal } = await toRun(req, res, (user) => {
      if (!mayExport(user)) throw new HttpError(403, 'forbidden', 'You may not export records to Excel. Ask an administrator for that permission.')
    })
    const ranAt = new Date().toISOString()
    const sections = await withQueryOrigin({ ...origin, source: 'export' }, () => exportReportSections(reader, report, period, { timeZone: tz, signal, values, noAccess: SHARED_NO_ACCESS }))
    await recordRecipientRun(db, report.id, user.id, 'export')
    await markReportRun(db, report)
    const style = (await styleOfReport(db, report.styleId)) ?? BUILTIN_RESOLVED_STYLE
    const doc = reportWorkbookDoc({ report, period, values, sections, ranAt, style, madeBy: user.name, timeZone: tz }, { withSql: false })
    sendWorkbook(res, reportFileName(report.title, ranAt, tz), await styledWorkbook(doc, style))
  })

  return r
}
