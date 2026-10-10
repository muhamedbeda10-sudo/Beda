// ============================================================================
// §21 — automations: the Automations page's routes. Only people who may
// create automations reach them — the assistant's owner, and those the owner
// allowed — and to anyone else every one answers 404, as an endpoint that
// does not exist would (read again on every request). A creator sees and
// changes their own automations; the owner sees everyone's and may pause,
// change or delete any. Runs are recorded, never audited; every change a
// person makes is (entity 'Automation', visible to the owner only). A run or
// a test asked for reads the database as a saved report's run does: one of a
// person's at a time, counted against the same per-person limit.
//
// The exception is a delivered report: the people it went to may open it
// whether or not they may create automations, as may its creator and the
// owner; to anyone else it does not exist.
// ============================================================================

import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import type { AiReportSectionRun } from '@qc/shared/ai'
import type {
  AutomationDelivery,
  AutomationLanguage,
  AutomationPeopleResponse,
  AutomationsResponse,
} from '@qc/shared/automation'
import { ROLES, type Role } from '@qc/shared/types'
import type { AppContext } from '../context'
import { HttpError, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { requireUser, type AuthUser } from '../auth/middleware'
import { loadAccess, mayAutomate, type AccessRecord } from '../ai/access'
import { aiOwner } from '../ai/owner'
import { EditsInput } from '../automations/draft'
import { blockedNote, runNow, testAutomation, type EngineDeps } from '../automations/engine'
import { automationFor, deleteAutomation, pauseAutomation, resumeAutomation, updateAutomation } from '../automations/lifecycle'
import { listRuns } from '../automations/runs'
import { AUTOMATION_COLUMNS, AUTOMATION_FROM, appState, findAutomation, toAutomations, type AutomationRow } from '../automations/views'

const uuid = z.string().uuid()
const listQuery = z.object({ creator: uuid.optional() })
const runsQuery = z.object({ before: uuid.optional() })

/** What anyone who may not create automations gets: what an endpoint that does not exist answers. */
const noSuchEndpoint = () => new HttpError(404, 'not_found', 'No such endpoint.')

/** Someone allowed to create automations, as of this request. */
interface Automator {
  user: AuthUser
  access: AccessRecord
  owner: boolean
}

export function automationsRoutes(ctx: AppContext): Router {
  const r = Router()
  const db = ctx.db
  const deps: EngineDeps = { db, config: ctx.config, readers: ctx.aiReader, model: ctx.ai }

  // ---- A delivered report: its recipients, its creator, the owner -------------------------

  r.get('/deliveries/:id', async (req, res) => {
    const user = requireUser(req)
    const id = parse(uuid, req.params.id)
    const owner = (await aiOwner(db, ctx.config)) === user.id
    const { rows } = await db.query<{
      id: string
      automationId: string
      automationName: string
      ranAt: string
      period: AutomationDelivery['period']
      summary: string | null
      summaryNote: string | null
      language: AutomationLanguage
      sections: AiReportSectionRun[]
    }>(
      `SELECT d.id, d.automation_id AS "automationId", d.automation_name AS "automationName", d.ran_at AS "ranAt", d.period, d.summary,
              d.summary_note AS "summaryNote", d.language, d.sections
         FROM ai_report_deliveries d JOIN ai_automations a ON a.id = d.automation_id
        WHERE d.id = $1
          AND ($3 OR a.creator_id = $2 OR EXISTS (SELECT 1 FROM ai_report_delivery_recipients x WHERE x.delivery_id = d.id AND x.user_id = $2))`,
      [id, user.id, owner],
    )
    const d = rows[0]
    if (!d) throw notFound('That report')
    const body: AutomationDelivery = {
      id: d.id,
      automationId: d.automationId,
      automationName: d.automationName,
      ranAt: d.ranAt,
      period: d.period ?? null,
      language: d.language,
      sections: d.sections,
    }
    if (d.summary) body.summary = d.summary
    if (d.summaryNote) body.summaryNote = d.summaryNote
    res.json(body)
  })

  // ---- Everything else: people who may create automations ----------------------------------

  // Gated by path, ahead of every route below, whatever the method: to anyone else none of them exists.
  r.use(async (req, res, next) => {
    const user = requireUser(req)
    const ownerId = await aiOwner(db, ctx.config)
    const access = await loadAccess(db, user.id)
    const owner = ownerId === user.id
    if (!mayAutomate(access, owner)) return next(noSuchEndpoint())
    const me: Automator = { user, access, owner }
    res.locals.automator = me
    next()
  })

  const automator = (res: Response): Automator => res.locals.automator as Automator

  /** One automation the viewer may see and change: their own, or any for the owner. */
  async function mine(req: Request, res: Response): Promise<{ me: Automator; row: AutomationRow }> {
    const me = automator(res)
    const id = parse(uuid, req.params.id)
    const row = await findAutomation(db, id)
    if (!row || (!me.owner && row.creatorId !== me.user.id)) throw notFound('That automation')
    return { me, row }
  }

  const actor = (me: Automator) => ({ id: me.user.id, name: me.user.name })

  r.get('/', async (req, res) => {
    const me = automator(res)
    const q = parse(listQuery, req.query)
    // The owner sees everyone's (or one person's); anyone else, their own.
    const creator = me.owner ? (q.creator ?? null) : me.user.id
    const { rows } = await db.query<AutomationRow>(
      `SELECT ${AUTOMATION_COLUMNS} FROM ${AUTOMATION_FROM}
        WHERE a.deleted_at IS NULL AND ($1::uuid IS NULL OR a.creator_id = $1)
        ORDER BY a.created_at DESC, a.id DESC`,
      [creator],
    )
    const body: AutomationsResponse = { automations: await toAutomations(db, rows, me.user.id, await appState(db, ctx.config, ctx.aiReader.ready)) }
    res.json(body)
  })

  /** Whom an automation can tell: live accounts (never the system sender), and the roles. */
  r.get('/people', async (_req, res) => {
    const { rows } = await db.query<{ id: string; name: string; username: string; role: Role }>(
      `SELECT u.id, u.name, u.username, u.role::text AS role FROM users u
        WHERE u.is_active AND u.deleted_at IS NULL AND NOT u.is_system
        ORDER BY lower(u.name), u.username`,
    )
    const body: AutomationPeopleResponse = { people: rows, roles: [...ROLES] }
    res.json(body)
  })

  r.get('/:id', async (req, res) => {
    const { me, row } = await mine(req, res)
    res.json(await automationFor(deps, row.id, me.user.id))
  })

  /** Change its words, people, channels, actions, interval or schedule: its queries change only through the assistant. */
  r.patch('/:id', async (req, res) => {
    const { me, row } = await mine(req, res)
    const edits = parse(EditsInput, req.body)
    await updateAutomation(deps, row.id, actor(me), edits)
    res.json(await automationFor(deps, row.id, me.user.id))
  })

  r.post('/:id/pause', async (req, res) => {
    const { me, row } = await mine(req, res)
    await pauseAutomation(deps, row.id, actor(me))
    res.json(await automationFor(deps, row.id, me.user.id))
  })

  r.post('/:id/resume', async (req, res) => {
    const { me, row } = await mine(req, res)
    await resumeAutomation(deps, row.id, actor(me))
    res.json(await automationFor(deps, row.id, me.user.id))
  })

  /** Removed from the list (kept, out of sight); its follow-ups and history stay. */
  r.delete('/:id', async (req, res) => {
    const { me, row } = await mine(req, res)
    await deleteAutomation(deps, row.id, actor(me))
    res.status(204).end()
  })

  /**
   * People with a run or a test they asked for under way: one at a time each,
   * as either may hold one of the few connections of their domains' readers —
   * shared with the engine's runs and everyone's chat — for minutes. One
   * process serves the API, as the limiters assume.
   */
  const busy = new Set<string>()

  /**
   * A run or a test, as a person asked: one of theirs at a time, and counted
   * against the per-person limit of saved reports' runs, since it reads the
   * database as one does.
   */
  async function asked<T>(me: Automator, work: () => Promise<T>): Promise<T> {
    if (busy.has(me.user.id)) throw new HttpError(409, 'conflict', 'A run or test of yours is still going. Wait for it to finish.')
    const wait = ctx.aiReportLimiter.hit(me.user.id)
    if (wait > 0) throw new HttpError(429, 'rate_limited', `Too many runs and tests in a short time. Try again in ${wait} seconds.`)
    busy.add(me.user.id)
    try {
      return await work()
    } finally {
      busy.delete(me.user.id)
    }
  }

  /** A real run, now: it tells people and records what it found. */
  r.post('/:id/run', async (req, res) => {
    const { me, row } = await mine(req, res)
    const outcome = await asked(me, () => runNow(deps, row.id))
    if (!outcome) throw notFound('That automation')
    if ('refused' in outcome) {
      if (outcome.refused === 'blocked') throw new HttpError(409, 'conflict', blockedNote(outcome.reason))
      if (outcome.refused === 'running') throw new HttpError(409, 'conflict', 'It is running right now. Wait for that run to finish.')
      throw new HttpError(429, 'rate_limited', 'It was run less than a minute ago. Try again in a moment.')
    }
    res.json(outcome)
  })

  /** A dry run: what it would find and whom it would tell now. Nothing is sent or recorded; the person leaving stops it. */
  r.post('/:id/test', async (req, res) => {
    const ac = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) ac.abort()
    })
    const { me, row } = await mine(req, res)
    res.json(await asked(me, () => testAutomation(deps, row, { signal: ac.signal })))
  })

  r.get('/:id/runs', async (req, res) => {
    const { row } = await mine(req, res)
    const q = parse(runsQuery, req.query)
    res.json(await listRuns(db, row.id, q.before ?? null))
  })

  return r
}
