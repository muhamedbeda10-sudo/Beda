// ============================================================================
// The HTTP application: middleware, routes, error translation, and — in
// production — the built client served from the same origin.
// ============================================================================

import path from 'node:path'
import { existsSync } from 'node:fs'
import express, { type ErrorRequestHandler, type Express } from 'express'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import type { ZodError } from 'zod'
import type { ApiErrorBody, HealthResponse } from '@qc/shared/api'
import type { AppContext } from './context'
import { HttpError } from './lib/errors'
import { PG, pgCode } from './db/pool'
import { authenticate } from './auth/middleware'
import { authRoutes } from './modules/auth.routes'
import { usersRoutes } from './modules/users.routes'
import { masterRoutes } from './modules/master.routes'
import { integrationsRoutes, orderSyncAgentRoutes } from './modules/integrations.routes'
import { ordersRoutes } from './modules/orders.routes'
import { coilsRoutes } from './modules/coils.routes'
import { mtcRoutes } from './modules/mtc.routes'
import { sessionsRoutes } from './modules/sessions.routes'
import { samplesRoutes } from './modules/samples.routes'
import { imagesRoutes } from './modules/images.routes'
import { workInstructionsRoutes } from './modules/workInstructions.routes'
import { pdiRoutes } from './modules/pdi.routes'
import { auditRoutes } from './modules/audit.routes'
import { kpiRoutes } from './modules/kpi.routes'
import { noticesRoutes } from './modules/notices.routes'
import { chatRoutes } from './modules/chat.routes'
import { releasesRoutes } from './modules/releases.routes'
import { aiRoutes } from './modules/ai.routes'
import { notificationsRoutes } from './modules/notifications.routes'
import { followUpsRoutes } from './modules/followUps.routes'
import { tasksRoutes } from './modules/tasks.routes'
import { automationsRoutes } from './modules/automations.routes'
import { productionRecordsRoutes } from './modules/productionRecords.routes'
import { pushRoutes } from './modules/push.routes'
import { reportStylesRoutes } from './modules/reportStyles.routes'
import { reportFormsRoutes } from './modules/reportForms.routes'
import { sharedReportsRoutes } from './modules/sharedReports.routes'
import { keepSlowQueries } from './ai/slowQueries'

export function createApp(ctx: AppContext): Express {
  const app = express()
  const { config, db } = ctx
  // §20 — every query of the assistant that takes 10 s or more is kept for the owner to see (slowQueries.ts).
  keepSlowQueries(db)

  app.disable('x-powered-by')
  if (config.TRUST_PROXY) app.set('trust proxy', 1)
  app.use(
    helmet({
      // The client is a same-origin SPA with inline Tailwind styles; images
      // arrive as data: thumbnails and as same-origin blob: URLs.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  )
  // A batch of an ERP export (up to 1,000 rows of the order sheet's 57 columns) is larger than any other request:
  // its own limit, on its own routes; every other body keeps the small one.
  app.use(
    ['/api/orders/import', '/api/orders/import/compare', '/api/production-records/import', '/api/production-records/import/compare'],
    express.json({ limit: '8mb' }),
  )
  // Pages of a sample report, as pictures, for the assistant to read a style from (REPORT_STYLE_SAMPLE_MAX_CHARS).
  app.use('/api/report-styles/draft', express.json({ limit: '6mb' }))
  app.use(express.json({ limit: '2mb' }))
  app.use(cookieParser())

  app.get('/api/health', async (_req, res) => {
    let database: HealthResponse['database'] = 'down'
    try {
      await db.query('SELECT 1')
      database = 'up'
    } catch {
      /* reported below */
    }
    const body: HealthResponse = { ok: database === 'up', version: ctx.version, database }
    res.status(body.ok ? 200 : 503).json(body)
  })

  app.use('/api/auth', authRoutes(ctx))

  const guard = authenticate(db, config.JWT_SECRET)
  app.use('/api/users', guard, usersRoutes(ctx))
  app.use('/api/master', guard, masterRoutes(ctx))
  app.use('/api/integrations', guard, integrationsRoutes(ctx))
  // The Access sync agent signs in with an integration key, not a person's session.
  app.use('/api/agent/order-sync', orderSyncAgentRoutes(ctx))
  app.use('/api/orders', guard, ordersRoutes(ctx))
  app.use('/api/coils', guard, coilsRoutes(ctx))
  app.use('/api/mtc', guard, mtcRoutes(ctx))
  app.use('/api/sessions', guard, sessionsRoutes(ctx))
  app.use('/api/samples', guard, samplesRoutes(ctx))
  app.use('/api/images', guard, imagesRoutes(ctx))
  app.use('/api/work-instructions', guard, workInstructionsRoutes(ctx))
  app.use('/api/pdi', guard, pdiRoutes(ctx))
  app.use('/api/audit', guard, auditRoutes(ctx))
  app.use('/api/kpi', guard, kpiRoutes(ctx))
  app.use('/api/notices', guard, noticesRoutes(ctx))
  app.use('/api/chat', guard, chatRoutes(ctx))
  app.use('/api/releases', guard, releasesRoutes(ctx))
  app.use('/api/ai', guard, aiRoutes(ctx))
  app.use('/api/notifications', guard, notificationsRoutes(ctx))
  app.use('/api/follow-ups', guard, followUpsRoutes(ctx))
  app.use('/api/tasks', guard, tasksRoutes(ctx))
  app.use('/api/automations', guard, automationsRoutes(ctx))
  app.use('/api/production-records', guard, productionRecordsRoutes(ctx))
  app.use('/api/push', guard, pushRoutes(ctx))
  app.use('/api/report-styles', guard, reportStylesRoutes(ctx))
  app.use('/api/report-forms', guard, reportFormsRoutes(ctx))
  // The saved reports shared with a person: signed in is enough, the assistant or not (ai/reportShares.ts).
  app.use('/api/reports/shared', guard, sharedReportsRoutes(ctx))

  app.all('/api/{*rest}', (_req, res) => {
    const body: ApiErrorBody = { error: { code: 'not_found', message: 'No such endpoint.' } }
    res.status(404).json(body)
  })

  // ---- The client ----------------------------------------------------------
  const staticDir = path.resolve(config.STATIC_DIR)
  if (existsSync(path.join(staticDir, 'index.html'))) {
    // Hashed assets are immutable; index.html must always be re-checked so a
    // deploy is picked up on the next load.
    app.use(
      express.static(staticDir, {
        index: false,
        setHeaders: (res, file) => {
          if (/[/\\]assets[/\\]/.test(file)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
          else res.setHeader('Cache-Control', 'no-cache')
        },
      }),
    )
    app.get('{*rest}', (req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next()
      res.setHeader('Cache-Control', 'no-cache')
      res.sendFile(path.join(staticDir, 'index.html'))
    })
  }

  app.use(errorHandler)
  return app
}

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (res.headersSent) {
    res.destroy()
    return
  }
  let status = 500
  let body: ApiErrorBody = { error: { code: 'internal', message: 'Something went wrong on the server. Nothing was saved.' } }

  if (err instanceof HttpError) {
    status = err.status
    body = { error: { code: err.code, message: err.message, details: err.details } }
  } else if (isZodError(err)) {
    status = 400
    body = { error: { code: 'validation', message: err.issues[0]?.message ?? 'Invalid request.', details: err.issues } }
  } else if (bodyErrorType(err) !== null) {
    // The JSON body parser refused the request before any route saw it.
    const type = bodyErrorType(err)
    status = type === 'entity.too.large' ? 413 : 400
    body =
      type === 'entity.too.large'
        ? { error: { code: 'payload_too_large', message: 'The request is too large to accept.' } }
        : { error: { code: 'validation', message: type === 'entity.parse.failed' ? 'The request body is not valid JSON.' : 'The request body could not be read.' } }
  } else if (isMulterError(err)) {
    // An upload (a photo, a PDF, a spreadsheet) the multipart parser refused.
    const refused = multerRefusal(err.code)
    status = refused.status
    body = { error: { code: refused.status === 413 ? 'payload_too_large' : 'validation', message: refused.message } }
  } else if (pgCode(err) === PG.DEADLOCK_DETECTED || pgCode(err) === PG.SERIALIZATION_FAILURE) {
    // Two changes to the same records crossed and the database undid this one: sent again, it goes through.
    status = 409
    res.setHeader('Retry-After', '1')
    body = { error: { code: 'conflict', message: 'Someone else was changing the same records at the same moment. Nothing was saved: try again.' } }
  } else if (pgCode(err) === PG.UNIQUE_VIOLATION && pgConstraint(err) === 'inspection_sessions_one_open_per_line') {
    status = 409
    body = { error: { code: 'duplicate', message: 'Another session is already open on this order line. One session per line is open at a time.' } }
  } else if (pgCode(err) === PG.UNIQUE_VIOLATION) {
    status = 409
    body = { error: { code: 'duplicate', message: 'A record with the same key already exists.' } }
  } else if (pgCode(err) === PG.CHECK_VIOLATION || pgCode(err) === PG.FOREIGN_KEY_VIOLATION) {
    status = 400
    body = { error: { code: 'validation', message: 'The database rejected one of the values.' } }
  }

  // A deliberate 503 (the AI assistant cannot answer now) is not a fault worth a stack trace.
  if (status >= 500 && !(err instanceof HttpError)) console.error('[api] unhandled error', err)
  res.status(status).json(body)
}

function isZodError(e: unknown): e is ZodError {
  return typeof e === 'object' && e !== null && (e as { name?: string }).name === 'ZodError' && Array.isArray((e as ZodError).issues)
}

/** A body-parser error's type ('entity.too.large', 'entity.parse.failed', …): a client error it raised itself, or null. */
function bodyErrorType(e: unknown): string | null {
  if (typeof e !== 'object' || e === null) return null
  const { type, status } = e as { type?: unknown; status?: unknown }
  return typeof type === 'string' && typeof status === 'number' && status >= 400 && status < 500 ? type : null
}

function isMulterError(e: unknown): e is { code: string } {
  return typeof e === 'object' && e !== null && (e as { name?: string }).name === 'MulterError' && typeof (e as { code?: unknown }).code === 'string'
}

/** What an upload multer refused is told: too large or too many is a 413, a malformed form a 400. Any file, not only a photo. */
function multerRefusal(code: string): { status: 400 | 413; message: string } {
  switch (code) {
    case 'LIMIT_FILE_SIZE':
      return { status: 413, message: 'That file is too large to upload.' }
    case 'LIMIT_FILE_COUNT':
      return { status: 413, message: 'Too many files in one upload: send them one at a time.' }
    case 'LIMIT_PART_COUNT':
    case 'LIMIT_FIELD_COUNT':
    case 'LIMIT_FIELD_KEY':
    case 'LIMIT_FIELD_VALUE':
      return { status: 413, message: 'The upload carries more than it may: send the file with its usual details only.' }
    case 'LIMIT_UNEXPECTED_FILE':
      return { status: 400, message: 'The upload has a file where none is expected: attach it as the "file" field.' }
    default:
      return { status: 400, message: 'The upload could not be read. Try again.' }
  }
}

function pgConstraint(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'constraint' in e ? String((e as { constraint: unknown }).constraint) : undefined
}
