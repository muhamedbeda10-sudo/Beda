// ============================================================================
// §7.7 — the order sheet synced from the factory's Access database.
//
// The Access file lives on the factory's network, out of reach of this
// server, so a small agent on a factory PC reads it and sends it here. It
// signs in with an integration key — a random secret kept only as its hash,
// good for this one job, revocable — never a person's password. The agent
// asks every minute whether a sync is due (the interval has passed, or an
// administrator asked for one now), then sends the table in batches and says
// how many rows it read. A run that received every row, read every one, and
// would not retire more than half the live lines retires the lines it did not
// see; anything less keeps them, and says why.
// ============================================================================

import { createHash, randomBytes } from 'node:crypto'
import { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import {
  ORDER_SYNC_BATCH_MAX,
  ORDER_SYNC_INTERVAL_MINUTES,
  ORDER_SYNC_RETIRE_MAX_SHARE,
  ORDER_SYNC_STALE_MINUTES,
  type CreateIntegrationKeyResponse,
  type IntegrationKeyInfo,
  type OrderSyncDueResponse,
  type OrderSyncRowError,
  type OrderSyncRowsResponse,
  type OrderSyncRun,
  type OrderSyncStartResponse,
  type OrderSyncStatusResponse,
} from '@qc/shared/api'
import { mapOrderRow, matchOrderColumns } from '@qc/shared/orderImport'
import { STOCK_ORDER_NUMBER } from '@qc/shared/rules'
import type { AppContext } from '../context'
import { withTransaction, type Queryable } from '../db/pool'
import { parse } from '../lib/validate'
import { badRequest, duplicate, notFound, unauthenticated } from '../lib/errors'
import { dropNulls } from '../lib/rows'
import { RateLimiter } from '../lib/rateLimit'
import { requirePermission, requireUser } from '../auth/middleware'
import { writeAudit } from '../audit/service'
import { importRow, upsertOrderLines, type OrderImportRow } from './orders.routes'

/** The keys' visible prefix; the rest is 32 random bytes. */
const KEY_PREFIX = 'qck_'
/** Row errors kept on a run: enough to see the pattern. */
const RUN_ERRORS_MAX = 50

const hashKey = (secret: string): string => createHash('sha256').update(secret, 'utf8').digest('hex')

interface IntegrationCaller {
  id: string
  name: string
  createdById: string
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      integration?: IntegrationCaller
    }
  }
}

const RUN_SELECT = `
  r.id, k.name AS "keyName", r.source, r.status, r.started_at AS "startedAt", r.finished_at AS "finishedAt",
  r.rows_received AS "rowsReceived", r.rows_expected AS "rowsExpected", r.inserted, r.updated, r.invalid, r.retired,
  r.unknown_columns AS "unknownColumns", r.errors, r.message`

const KEY_SELECT = `
  id, name, prefix, created_by_name AS "createdByName", created_at AS "createdAt", last_used_at AS "lastUsedAt", revoked_at AS "revokedAt"`

/** A run left running past ORDER_SYNC_STALE_MINUTES is given up: the agent died or lost its way. */
async function closeStaleRuns(q: Queryable): Promise<void> {
  await q.query(
    `UPDATE order_sync_runs SET status = 'failed', finished_at = now(),
            message = COALESCE(message, 'The agent stopped before finishing; nothing was retired.')
      WHERE status = 'running' AND started_at < now() - make_interval(mins => $1)`,
    [ORDER_SYNC_STALE_MINUTES],
  )
}

/** The agent's key, from `Authorization: Bearer qck_…`. Wrong keys are slowed down per address. */
function authenticateIntegration(ctx: AppContext) {
  const failures = new RateLimiter(30, 15 * 60_000)
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const header = req.headers.authorization ?? ''
      const secret = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
      const address = req.ip ?? 'unknown'
      if (!secret.startsWith(KEY_PREFIX)) throw unauthenticated('An integration key is required.')
      const { rows } = await ctx.db.query<IntegrationCaller>(
        `UPDATE integration_keys SET last_used_at = now()
          WHERE key_hash = $1 AND revoked_at IS NULL AND purpose = 'orders-sync'
          RETURNING id, name, created_by_id AS "createdById"`,
        [hashKey(secret)],
      )
      if (!rows[0]) {
        const wait = failures.hit(address)
        throw unauthenticated(wait > 0 ? `Too many wrong keys. Try again in ${wait} seconds.` : 'This integration key is not valid, or was revoked.')
      }
      req.integration = rows[0]
      next()
    } catch (e) {
      next(e)
    }
  }
}

function requireIntegration(req: Request): IntegrationCaller {
  if (!req.integration) throw unauthenticated('An integration key is required.')
  return req.integration
}

/** The administrator's side: the runs, a sync now, the keys. */
export function integrationsRoutes(ctx: AppContext): Router {
  const r = Router()
  const { db } = ctx
  r.use(requirePermission('import-data'))

  r.get('/order-sync', async (_req, res) => {
    await closeStaleRuns(db)
    const [runs, pending, keys] = await Promise.all([
      db.query<OrderSyncRun>(`SELECT ${RUN_SELECT} FROM order_sync_runs r JOIN integration_keys k ON k.id = r.key_id ORDER BY r.started_at DESC LIMIT 30`),
      db.query<{ requestedAt: string; requestedByName: string }>(
        `SELECT requested_at AS "requestedAt", requested_by_name AS "requestedByName" FROM order_sync_requests WHERE run_id IS NULL ORDER BY requested_at LIMIT 1`,
      ),
      db.query<IntegrationKeyInfo>(`SELECT ${KEY_SELECT} FROM integration_keys WHERE purpose = 'orders-sync' ORDER BY revoked_at NULLS FIRST, created_at DESC`),
    ])
    const body: OrderSyncStatusResponse = {
      intervalMinutes: ORDER_SYNC_INTERVAL_MINUTES,
      runs: runs.rows.map((x) => dropNulls(x) as OrderSyncRun),
      pendingRequest: pending.rows[0] ?? null,
      keys: keys.rows.map((x) => dropNulls(x) as IntegrationKeyInfo),
    }
    res.json(body)
  })

  /** Sync now: the agent picks the request up on its next check, within a minute. One request waits at a time. */
  r.post('/order-sync/request', async (req, res) => {
    const user = requireUser(req)
    await db.query(
      `INSERT INTO order_sync_requests (requested_by_id, requested_by_name)
       SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM order_sync_requests WHERE run_id IS NULL)`,
      [user.id, user.name],
    )
    res.status(204).end()
  })

  r.post('/keys', async (req, res) => {
    const user = requireUser(req)
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(80) }), req.body)
    const secret = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`
    const key = await withTransaction(db, async (tx) => {
      const { rows } = await tx.query<IntegrationKeyInfo>(
        `INSERT INTO integration_keys (name, purpose, prefix, key_hash, created_by_id, created_by_name)
         VALUES ($1, 'orders-sync', $2, $3, $4, $5) RETURNING ${KEY_SELECT}`,
        [name, secret.slice(0, 12), hashKey(secret), user.id, user.name],
      )
      await writeAudit(tx, [{ at: new Date().toISOString(), userId: user.id, userName: user.name, action: 'create', entity: 'IntegrationKey', entityId: rows[0].id, field: 'name', newValue: name }])
      return dropNulls(rows[0]) as IntegrationKeyInfo
    })
    const body: CreateIntegrationKeyResponse = { key, secret }
    res.status(201).json(body)
  })

  r.post('/keys/:id/revoke', async (req, res) => {
    const user = requireUser(req)
    const id = parse(z.string().uuid(), req.params.id)
    await withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ name: string }>(
        `UPDATE integration_keys SET revoked_at = now(), revoked_by_id = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING name`,
        [id, user.id],
      )
      if (!rows[0]) throw notFound('That key')
      await writeAudit(tx, [{ at: new Date().toISOString(), userId: user.id, userName: user.name, action: 'delete', entity: 'IntegrationKey', entityId: id, field: 'revoked', newValue: rows[0].name }])
    })
    res.status(204).end()
  })

  return r
}

const startSchema = z.object({ source: z.string().trim().max(300).default('') })
const rowsSchema = z.object({ rows: z.array(z.record(z.string().max(200), z.unknown())).min(1).max(ORDER_SYNC_BATCH_MAX) })
const finishSchema = z.object({ total: z.number().int().min(0) })
const failSchema = z.object({ message: z.string().trim().min(1).max(1000) })

interface RunRow {
  id: string
  keyId: string
  status: string
  rowsReceived: number
  invalid: number
  errorCount: number
}

/** The agent's side, signed in with an integration key. */
export function orderSyncAgentRoutes(ctx: AppContext): Router {
  const r = Router()
  const { db } = ctx
  r.use(authenticateIntegration(ctx))

  /** Lock this key's running run. */
  async function lockRun(tx: Queryable, id: string, keyId: string): Promise<RunRow> {
    const { rows } = await tx.query<RunRow>(
      `SELECT id, key_id AS "keyId", status, rows_received AS "rowsReceived", invalid, jsonb_array_length(errors) AS "errorCount"
         FROM order_sync_runs WHERE id = $1 FOR UPDATE`,
      [id],
    )
    const run = rows[0]
    if (!run || run.keyId !== keyId) throw notFound('That sync run')
    if (run.status !== 'running') throw badRequest('That sync run is already finished. Start a new one.')
    return run
  }

  r.get('/due', async (_req, res) => {
    requireIntegration(_req)
    await closeStaleRuns(db)
    const [running, pending, last] = await Promise.all([
      db.query(`SELECT 1 FROM order_sync_runs WHERE status = 'running' LIMIT 1`),
      db.query(`SELECT 1 FROM order_sync_requests WHERE run_id IS NULL LIMIT 1`),
      db.query<{ minutes: number }>(`SELECT EXTRACT(EPOCH FROM (now() - max(started_at))) / 60 AS minutes FROM order_sync_runs`),
    ])
    const since = last.rows[0]?.minutes
    const reason: OrderSyncDueResponse['reason'] =
      (running.rowCount ?? 0) > 0 ? 'running' : (pending.rowCount ?? 0) > 0 ? 'requested' : since === null || since === undefined ? 'first' : since >= ORDER_SYNC_INTERVAL_MINUTES ? 'interval' : 'not-yet'
    const body: OrderSyncDueResponse = { due: reason === 'requested' || reason === 'first' || reason === 'interval', reason, intervalMinutes: ORDER_SYNC_INTERVAL_MINUTES }
    res.json(body)
  })

  r.post('/runs', async (req, res) => {
    const caller = requireIntegration(req)
    const { source } = parse(startSchema, req.body)
    const runId = await withTransaction(db, async (tx) => {
      // One run at a time across every key: two agents must not retire each other's lines.
      await tx.query('SELECT pg_advisory_xact_lock($1)', [8_811_026])
      await closeStaleRuns(tx)
      const busy = await tx.query(`SELECT 1 FROM order_sync_runs WHERE status = 'running' LIMIT 1`)
      if ((busy.rowCount ?? 0) > 0) throw duplicate('A sync is already running.')
      const { rows } = await tx.query<{ id: string }>(`INSERT INTO order_sync_runs (key_id, source) VALUES ($1, $2) RETURNING id`, [caller.id, source])
      await tx.query(`UPDATE order_sync_requests SET run_id = $1 WHERE run_id IS NULL`, [rows[0].id])
      return rows[0].id
    })
    const body: OrderSyncStartResponse = { runId, batchMax: ORDER_SYNC_BATCH_MAX }
    res.status(201).json(body)
  })

  r.post('/runs/:id/rows', async (req, res) => {
    const caller = requireIntegration(req)
    const id = parse(z.string().uuid(), req.params.id)
    const { rows } = parse(rowsSchema, req.body)
    const result = await withTransaction(db, async (tx) => {
      const run = await lockRun(tx, id, caller.id)
      const columns = Array.from(new Set(rows.flatMap((x) => Object.keys(x))))
      const match = matchOrderColumns(columns)
      if (match.byField.lineKey === undefined) throw badRequest(`No column of the table is the Order ID. Columns sent: ${columns.join(', ')}.`)
      const errors: OrderSyncRowError[] = []
      const valid: { at: number; row: OrderImportRow }[] = []
      rows.forEach((raw, i) => {
        const at = run.rowsReceived + i + 1
        // The agent writes Access's moments without an offset: they are factory time, as the browser importer reads them.
        const mapped = mapOrderRow(raw, match, ctx.config.FACTORY_TIMEZONE)
        const lineKey = typeof raw[match.byField.lineKey] === 'string' || typeof raw[match.byField.lineKey] === 'number' ? String(raw[match.byField.lineKey]).trim() : undefined
        if ('error' in mapped) {
          errors.push({ row: at, lineKey, message: mapped.error })
          return
        }
        const checked = importRow.safeParse(mapped.values)
        if (!checked.success) {
          errors.push({ row: at, lineKey, message: checked.error.issues.map((x) => `${x.path.join('.') || 'row'}: ${x.message}`).join('; ') })
          return
        }
        valid.push({ at, row: checked.data })
      })
      // A line seen for the first time must name its order number: such a row is an error of its own, not the batch's.
      const known = new Set(
        (
          await tx.query<{ key: string }>(`SELECT lower(line_key) AS key FROM production_orders WHERE lower(line_key) = ANY($1::text[])`, [valid.map((v) => v.row.lineKey.toLowerCase())])
        ).rows.map((x) => x.key),
      )
      const usable = valid
        .filter((v) => {
          if (known.has(v.row.lineKey.toLowerCase()) || v.row.orderNumber) return true
          errors.push({ row: v.at, lineKey: v.row.lineKey, message: 'A new Order ID without its order number.' })
          return false
        })
        .map((v) => v.row)
      const counts = usable.length ? await upsertOrderLines(tx, usable, id) : { inserted: 0, updated: 0 }
      errors.sort((a, b) => a.row - b.row)
      const keep = errors.slice(0, Math.max(0, RUN_ERRORS_MAX - run.errorCount))
      await tx.query(
        `UPDATE order_sync_runs
            SET rows_received = rows_received + $2, inserted = inserted + $3, updated = updated + $4, invalid = invalid + $5,
                unknown_columns = ARRAY(SELECT DISTINCT unnest(unknown_columns || $6::text[]) ORDER BY 1),
                errors = errors || $7::jsonb
          WHERE id = $1`,
        [id, rows.length, counts.inserted, counts.updated, errors.length, match.unknown, JSON.stringify(keep)],
      )
      const body: OrderSyncRowsResponse = { received: rows.length, inserted: counts.inserted, updated: counts.updated, invalid: errors.length, unknownColumns: match.unknown }
      return body
    })
    res.json(result)
  })

  r.post('/runs/:id/finish', async (req, res) => {
    const caller = requireIntegration(req)
    const id = parse(z.string().uuid(), req.params.id)
    const { total } = parse(finishSchema, req.body)
    const run = await withTransaction(db, async (tx) => {
      const locked = await lockRun(tx, id, caller.id)
      let status: 'success' | 'warning' | 'failed' = 'success'
      let message: string | null = null
      let retired = 0
      if (locked.rowsReceived !== total) {
        status = 'failed'
        message = `The agent read ${total} rows but ${locked.rowsReceived} arrived; nothing was retired.`
      } else if (total === 0) {
        status = 'warning'
        message = 'The Access table was empty; nothing was retired.'
      } else if (locked.invalid > 0) {
        status = 'warning'
        message = `${locked.invalid} ${locked.invalid === 1 ? 'row' : 'rows'} could not be read; nothing was retired until every row reads cleanly.`
      } else {
        const { rows } = await tx.query<{ live: number; unseen: number }>(
          `SELECT count(*)::int AS live, count(*) FILTER (WHERE last_sync_run_id IS DISTINCT FROM $1)::int AS unseen
             FROM production_orders WHERE deleted_at IS NULL AND upper(btrim(order_number)) <> $2`,
          [id, STOCK_ORDER_NUMBER],
        )
        const { live, unseen } = rows[0]
        if (unseen > 0 && unseen > live * ORDER_SYNC_RETIRE_MAX_SHARE) {
          status = 'warning'
          message = `${unseen} of ${live} lines are not in the Access table: more than half, so none was retired. Check the table the agent reads.`
        } else if (unseen > 0) {
          const out = await tx.query(
            `UPDATE production_orders SET deleted_at = now()
              WHERE deleted_at IS NULL AND upper(btrim(order_number)) <> $2 AND last_sync_run_id IS DISTINCT FROM $1`,
            [id, STOCK_ORDER_NUMBER],
          )
          retired = out.rowCount ?? 0
        }
      }
      const { rows: done } = await tx.query<{ inserted: number; updated: number }>(
        `UPDATE order_sync_runs SET status = $2, finished_at = now(), rows_expected = $3, retired = $4, message = $5 WHERE id = $1 RETURNING inserted, updated`,
        [id, status, total, retired, message],
      )
      await writeAudit(tx, [
        {
          at: new Date().toISOString(),
          userId: caller.createdById,
          userName: `Access sync (${caller.name})`,
          action: 'update',
          entity: 'ProductionOrder',
          entityId: `sync:${id}`,
          field: 'sync',
          newValue: `${status}: ${done[0].inserted} inserted, ${done[0].updated} updated, ${retired} retired, ${locked.invalid} unreadable${message ? ` · ${message}` : ''}`,
        },
      ])
      const { rows: out } = await tx.query<OrderSyncRun>(`SELECT ${RUN_SELECT} FROM order_sync_runs r JOIN integration_keys k ON k.id = r.key_id WHERE r.id = $1`, [id])
      return dropNulls(out[0]) as OrderSyncRun
    })
    res.json(run)
  })

  /** The agent could not read the table (the file was locked, the driver missing): the run fails with its reason. */
  r.post('/runs/:id/fail', async (req, res) => {
    const caller = requireIntegration(req)
    const id = parse(z.string().uuid(), req.params.id)
    const { message } = parse(failSchema, req.body)
    await withTransaction(db, async (tx) => {
      await lockRun(tx, id, caller.id)
      await tx.query(`UPDATE order_sync_runs SET status = 'failed', finished_at = now(), message = $2 WHERE id = $1`, [id, message])
    })
    res.status(204).end()
  })

  return r
}
