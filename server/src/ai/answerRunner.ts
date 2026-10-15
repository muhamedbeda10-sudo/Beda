// ============================================================================
// §20 — the assistant's answers, written on the server whatever happens to
// the request that asked for them (migration 0054).
//
//   • An answer belongs to the instance that writes it (ai_turns.runner),
//     which says so every HEARTBEAT_MS (heartbeat_at), with how long the
//     answer has run and a line on what it is doing. Closing the page only
//     detaches whoever was watching; the answer goes on.
//   • Stop is a mark on the turn (stop_requested_at). The instance writing it
//     sees it at once when it is its own, else at its next heartbeat or model
//     call, and stops the answer as the asker's Stop always did.
//   • An answer whose heartbeat is older than LEASE_MS was lost with its
//     instance. sweep() takes it over and continues it from what is stored:
//     a step whose tools had not all run is finished from there, each tool
//     once (assistant.ts), never asked of the model again. Its model calls,
//     pauses and time run are counted on the turn, so its limits hold across
//     hand-overs; one handed over more than MAX_RESUMES times is ended.
//   • Every write of an answer first checks the turn is still this
//     instance's (the fence). An instance that cannot say it is alive for
//     GIVE_UP_MS stops its answers itself, before another can take them over.
//   • Stopping (a deploy, a restart), the instance hands its answers back at
//     once: another instance — or this one, started again — continues them
//     without waiting out the lease.
//   • An answer that ends while nobody is watching it (no stream attached
//     here, nobody polling it lately) tells its asker in the bell, which also
//     pushes to their phone. Once per answer, however often it is closed.
// ============================================================================

import { randomUUID } from 'node:crypto'
import { AI_JOBS, AI_ROUTER_FALLBACK, isAiEffort, isAiModel, type AiEffort, type AiModelId, type AiStreamEvent } from '@qc/shared/ai'
import type { ApiErrorCode } from '@qc/shared/api'
import type { Config } from '../config'
import { withTransaction, type Db, type Queryable } from '../db/pool'
import type { ImageStorage } from '../images/storage'
import type { RateLimiter } from '../lib/rateLimit'
import { clipText, createNotifications } from '../automations/notify'
import { isolate } from '../automations/text'
import { HANDED_OVER, NOT_AVAILABLE_MESSAGE, TURN_DEADLINE_MS, TurnLost, answerQuestion, describeModelFailure, type Outcome, type Question, type TurnControl } from './assistant'
import { AttachmentExpander } from './attachments'
import { turnToolHandlers } from './conversationTools'
import { WRAP_UP_TAG } from './prompt'
import type { AiModelClient } from './model'
import { currentAiOwner } from './owner'
import type { AiReader } from './reader'
import { loadAvailability } from './settings'
import { finishTurn, findConversation, loadDisplayMessages, loadReplay, pendingStep, repairDanglingToolUse } from './transcript'

/** How often an instance says its answers are alive. */
export const HEARTBEAT_MS = 5_000
/** An answer that has not said so for this long was lost with its instance: another takes it over. */
export const LEASE_MS = 30_000
/** An instance that has not managed to say so for this long stops its answers itself, before another takes them over. */
const GIVE_UP_MS = 20_000
/** An answer handed over more often than this is ended: something in it keeps bringing its instance down. */
export const MAX_RESUMES = 3
/** How often an instance looks for answers to take over. */
const SWEEP_MS = 10_000
/** Answers taken over in one look. */
const SWEEP_BATCH = 10
/**
 * An answer left running by the version before hand-overs (no heartbeat ever) may still be written by it until its
 * own limit passed (its 15 minutes, and one more): never taken before, never continued after — closed as cut off.
 */
export const UNTRACKED_STALE_MINUTES = 16
/**
 * A running turn lost with its instance, over ai_turns: its heartbeat older than the lease (or handed back), or — left
 * by the version before hand-overs, with no heartbeat ever — past that version's own limit.
 */
export const LOST_TURN = `status = 'running' AND (heartbeat_at < now() - make_interval(secs => ${LEASE_MS / 1000})
  OR (heartbeat_at IS NULL AND created_at < now() - make_interval(mins => ${UNTRACKED_STALE_MINUTES})))`
/** Someone polling the conversation this recently is watching the answer: no bell. */
const WATCHING_SECONDS = 15
/** A heartbeat after the server stopped: older than any lease, so the answer is taken over at once. */
const HANDED_BACK = '-infinity'
/** The reason a run is aborted with on Stop (anything but HANDED_OVER reads as the asker's). */
const STOPPED = 'stopped'

export const CUT_OFF_NOTICE = 'This answer was cut off (the server restarted).'
export const TOO_MANY_RESUMES_NOTICE = 'This answer was interrupted too many times and was stopped. Ask again.'
const CONVERSATION_GONE_NOTICE = 'The conversation was deleted while the answer was being written.'
const NO_KEY_NOTICE = 'The assistant has no API key to answer with. Set one under Administration → AI assistant.'

/** How a run ended, for the stream that started it: answered (or stopped), failed, or handed over to another run. */
export type RunEnd = { kind: 'done'; outcome: Outcome } | { kind: 'error'; code: ApiErrorCode; message: string } | { kind: 'handed-over' }

export interface AnswerRunnerDeps {
  db: Db
  config: Config
  readers: AiReader
  model: AiModelClient
  images: ImageStorage
  /** Excel files and report runs, per person (ctx.aiReportLimiter). */
  reportLimiter: RateLimiter
}

interface LocalRun {
  turnId: string
  conversationId: string
  userId: string
  ac: AbortController
  /** Streams watching it on this instance: they get every event, and an answer with one is being watched. */
  subscribers: Set<(event: AiStreamEvent) => void>
  /** What it is doing now, written with the heartbeat. */
  progress: string | null
  /** The line last written, so an unchanged one is not written again. */
  progressWritten: string | null
  /** When its running time was last added to the turn. */
  countedAt: number
  /** The asker controls the assistant: told precisely why it failed. */
  owner: boolean
  done: Promise<RunEnd>
}

/** A run of a turn, as the stream that started it holds it. */
export interface RunHandle {
  readonly turnId: string
  /** Every event from now on; returns how to stop listening (the answer goes on). */
  subscribe(listener: (event: AiStreamEvent) => void): () => void
  readonly done: Promise<RunEnd>
}

export class AnswerRunner {
  /** This instance, as ai_turns.runner names it: a new one every start. */
  readonly id = randomUUID()
  private readonly runs = new Map<string, LocalRun>()
  private beatTimer: NodeJS.Timeout | null = null
  private sweepTimer: NodeJS.Timeout | null = null
  private lastBeatOk = Date.now()
  /** A beat under way: the clock's next is skipped, rather than count the same time twice or pile up on a slow pool. */
  private beating: Promise<void> | null = null
  private stopping = false
  private sweeping: Promise<number> | null = null

  constructor(private readonly deps: AnswerRunnerDeps) {}

  /** Look for answers lost with another instance now and every SWEEP_MS (index.ts; the tests sweep themselves). */
  start(): void {
    if (this.sweepTimer) return
    void this.sweepNow()
    this.sweepTimer = setInterval(() => void this.sweepNow(), SWEEP_MS)
    this.sweepTimer.unref()
  }

  /** Look soon: a question found its conversation's answer lost. */
  kick(): void {
    if (!this.stopping) setImmediate(() => void this.sweepNow())
  }

  /**
   * Stop: every answer here is handed back at once — not stopped, not closed — for another instance (or this one,
   * started again) to continue.
   */
  async stop(): Promise<void> {
    this.stopping = true
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
    for (const run of this.runs.values()) run.ac.abort(HANDED_OVER)
    // A look under way takes no more once it sees `stopping`; what it took meanwhile is handed back below, with the rest.
    await this.sweeping?.catch(() => undefined)
    const runs = [...this.runs.values()]
    for (const run of runs) run.ac.abort(HANDED_OVER)
    await Promise.allSettled(runs.map((r) => r.done))
    this.stopBeat()
    await this.deps.db
      .query(`UPDATE ai_turns SET runner = NULL, heartbeat_at = $2::timestamptz WHERE runner = $1 AND status = 'running'`, [this.id, HANDED_BACK])
      .catch((e) => console.warn('[ai] answers could not be handed back:', e instanceof Error ? e.message : String(e)))
  }

  /** Write a turn this instance has just created (its runner and heartbeat set as it was inserted). */
  begin(turn: { turnId: string; conversationId: string; userId: string }): RunHandle {
    if (this.stopping) {
      // Asked as the server stops: handed back before it starts, for the next instance to write.
      const handedBack = this.deps.db
        .query(`UPDATE ai_turns SET runner = NULL, heartbeat_at = $2::timestamptz WHERE id = $1 AND runner = $3 AND status = 'running'`, [turn.turnId, HANDED_BACK, this.id])
        .then((): RunEnd => ({ kind: 'handed-over' }))
        .catch((): RunEnd => ({ kind: 'handed-over' }))
      return { turnId: turn.turnId, subscribe: () => () => undefined, done: handedBack }
    }
    const run = this.launch(turn)
    return {
      turnId: run.turnId,
      subscribe: (listener) => {
        run.subscribers.add(listener)
        return () => run.subscribers.delete(listener)
      },
      done: run.done,
    }
  }

  /** Whether the answer is being written on this instance (the tests use it). */
  isRunning(turnId: string): boolean {
    return this.runs.has(turnId)
  }

  /**
   * Stop the answer being written in a conversation, wherever it is written. Returns whether one was. Seen at once
   * here; elsewhere at that instance's next heartbeat or model call; a lost answer, when it is taken over.
   */
  async requestStop(conversationId: string, userId: string): Promise<boolean> {
    const { rows } = await this.deps.db.query<{ id: string }>(
      `UPDATE ai_turns SET stop_requested_at = COALESCE(stop_requested_at, now())
        WHERE conversation_id = $1 AND user_id = $2 AND status = 'running' RETURNING id`,
      [conversationId, userId],
    )
    const id = rows[0]?.id
    if (!id) return false
    this.runs.get(id)?.ac.abort(STOPPED)
    return true
  }

  /** Someone has the conversation on screen: an answer ending now is seen, not told in the bell. */
  async watched(conversationId: string): Promise<void> {
    await this.deps.db.query(`UPDATE ai_turns SET watched_at = now() WHERE conversation_id = $1 AND status = 'running'`, [conversationId])
  }

  /**
   * Take over the answers lost with their instance and continue them. Returns how many were taken (continued or,
   * when they cannot be, closed). One look at a time per instance.
   */
  sweep(): Promise<number> {
    return this.sweepNow()
  }

  private sweepNow(): Promise<number> {
    if (this.stopping) return Promise.resolve(0)
    if (!this.sweeping) {
      this.sweeping = this.takeOver()
        .catch((e) => {
          console.warn('[ai] answers could not be taken over:', e instanceof Error ? e.message : String(e))
          return 0
        })
        .finally(() => {
          this.sweeping = null
        })
    }
    return this.sweeping
  }

  private async takeOver(): Promise<number> {
    let taken = 0
    while (taken < SWEEP_BATCH && !this.stopping) {
      // One at a time, each under its row's lock: two instances never take the same answer.
      // Never one still written here: an answer cut short whose tool is still running keeps its place until it ends.
      const { rows } = await this.deps.db.query<{ id: string; conversationId: string; userId: string; resumes: number; untracked: boolean }>(
        `WITH lost AS (
           SELECT id, heartbeat_at FROM ai_turns
            WHERE ${LOST_TURN} AND NOT (id = ANY($2::uuid[]))
            ORDER BY heartbeat_at NULLS FIRST, created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
         UPDATE ai_turns t SET runner = $1, heartbeat_at = now(), resumes = t.resumes + 1
           FROM lost WHERE t.id = lost.id
         RETURNING t.id, t.conversation_id AS "conversationId", t.user_id AS "userId", t.resumes, (lost.heartbeat_at IS NULL) AS untracked`,
        [this.id, [...this.runs.keys()]],
      )
      const turn = rows[0]
      if (!turn) break
      taken++
      if (this.stopping) {
        // Stopping since it was taken: given back as it was, for the next instance, without counting a hand-over.
        await this.deps.db
          .query(`UPDATE ai_turns SET runner = NULL, heartbeat_at = $2::timestamptz, resumes = resumes - 1 WHERE id = $1 AND runner = $3 AND status = 'running'`, [
            turn.id,
            HANDED_BACK,
            this.id,
          ])
          .catch((e) => console.warn('[ai] an answer could not be handed back:', e instanceof Error ? e.message : String(e)))
        break
      }
      if (turn.untracked) {
        // Left by the version before hand-overs, past its own limit: closed as it would have been, without a word in the bell.
        await this.close(this.bare(turn), { stopReason: 'error', notice: CUT_OFF_NOTICE }, false)
      } else if (turn.resumes > MAX_RESUMES) {
        await this.close(this.bare(turn), { stopReason: 'error', notice: TOO_MANY_RESUMES_NOTICE })
      } else {
        this.launch({ turnId: turn.id, conversationId: turn.conversationId, userId: turn.userId })
      }
    }
    return taken
  }

  /** A turn as closing it needs, without a run. */
  private bare(turn: { id: string; conversationId: string; userId: string }): Pick<LocalRun, 'turnId' | 'conversationId' | 'userId' | 'subscribers'> {
    return { turnId: turn.id, conversationId: turn.conversationId, userId: turn.userId, subscribers: new Set() }
  }

  private launch(turn: { turnId: string; conversationId: string; userId: string }): LocalRun {
    const { turnId } = turn
    const run: LocalRun = {
      turnId,
      conversationId: turn.conversationId,
      userId: turn.userId,
      ac: new AbortController(),
      subscribers: new Set(),
      progress: null,
      progressWritten: null,
      countedAt: Date.now(),
      owner: false,
      done: Promise.resolve({ kind: 'handed-over' }),
    }
    this.runs.set(turnId, run)
    this.startBeat()
    run.done = this.execute(run).finally(() => {
      if (this.runs.get(turnId) === run) this.runs.delete(turnId)
      if (this.runs.size === 0) this.stopBeat()
    })
    return run
  }

  private async execute(run: LocalRun): Promise<RunEnd> {
    try {
      const prepared = await this.prepare(run)
      if ('end' in prepared) {
        await this.close(run, prepared.end)
        return { kind: 'done', outcome: prepared.end }
      }
      const outcome = await answerQuestion(prepared.question)
      if (outcome.handedOver) return { kind: 'handed-over' }
      // Most endings were closed already, with the answer's last message; this closes the rest (a limit, a cap, Stop).
      await this.close(run, outcome)
      return { kind: 'done', outcome }
    } catch (e) {
      if (e instanceof TurnLost || run.ac.signal.reason === HANDED_OVER) return { kind: 'handed-over' }
      const failure = describeModelFailure(e, run.conversationId, run.owner)
      await this.close(run, { stopReason: 'error', notice: failure.message }).catch((err) => console.error('[ai] could not close a failed answer', err))
      return { kind: 'error', code: failure.code, message: failure.message }
    }
  }

  /** Everything the loop needs, from the database alone: the same for a turn just asked and one taken over. */
  private async prepare(run: LocalRun): Promise<{ question: Question } | { end: Outcome }> {
    const { db, config } = this.deps
    const { rows } = await db.query<{ model: string | null; effort: string | null; calls: number; pauses: number; elapsedMs: number; stop: boolean; userName: string }>(
      `SELECT t.model, t.effort, t.calls, t.pauses, t.elapsed_ms AS "elapsedMs", (t.stop_requested_at IS NOT NULL) AS stop, u.name AS "userName"
         FROM ai_turns t JOIN users u ON u.id = t.user_id
        WHERE t.id = $1 AND t.runner = $2 AND t.status = 'running'`,
      [run.turnId, this.id],
    )
    const turn = rows[0]
    if (!turn) throw new TurnLost()
    run.owner = (await currentAiOwner(db, config)) === run.userId
    if (turn.stop) return { end: { stopReason: 'stopped', notice: 'Stopped before the answer was finished.' } }
    const conversation = await findConversation(db, run.conversationId, run.userId)
    if (!conversation) return { end: { stopReason: 'stopped', notice: CONVERSATION_GONE_NOTICE } }
    const availability = await loadAvailability(db, config, this.deps.readers.ready)
    if (!availability.apiKey) return { end: { stopReason: 'error', notice: run.owner ? NO_KEY_NOTICE : NOT_AVAILABLE_MESSAGE } }
    // As asked: the model and effort of the question's level when it was sent; a turn that carries none, the standard level's.
    const fallback = AI_JOBS[AI_ROUTER_FALLBACK]
    const modelId: AiModelId = turn.model && isAiModel(turn.model) ? turn.model : fallback.model
    const effort: AiEffort = turn.effort && isAiEffort(turn.effort) ? turn.effort : fallback.effort

    // A step stored before its tools ran is finished first; otherwise a call left without its result (a crash under
    // the version before hand-overs) is answered as interrupted, as a new question would.
    const pending = await pendingStep(db, run.turnId)
    if (!pending) await withTransaction(db, (tx) => repairDanglingToolUse(tx, run.conversationId, run.turnId))
    const messages = await loadReplay(db, run.conversationId)
    const retried = await db.query(`SELECT 1 FROM ai_messages WHERE turn_id = $1 AND kind = 'repair' AND content::text LIKE '%"type":"text"%' LIMIT 1`, [run.turnId])
    // Told to close already: the app's note is the text after a step's results, never inside one.
    const wrapped = await db.query(
      `SELECT 1 FROM ai_messages
        WHERE turn_id = $1 AND kind = 'tool_results' AND json_typeof(content) = 'array'
          AND content -> -1 ->> 'type' = 'text' AND starts_with(content -> -1 ->> 'text', $2) LIMIT 1`,
      [run.turnId, `<${WRAP_UP_TAG}>`],
    )

    const emit = (event: AiStreamEvent) => {
      run.progress = progressOf(event) ?? run.progress
      for (const listener of run.subscribers) listener(event)
    }
    const control: TurnControl = {
      calls: turn.calls,
      pauses: turn.pauses,
      emptyRetried: (retried.rowCount ?? 0) > 0,
      wrappedUp: (wrapped.rowCount ?? 0) > 0,
      beforeCall: async () => {
        const { rows: counted } = await db.query<{ calls: number; stop: boolean }>(
          `UPDATE ai_turns SET calls = calls + 1, heartbeat_at = now() WHERE id = $1 AND runner = $2 AND status = 'running'
           RETURNING calls, (stop_requested_at IS NOT NULL) AS stop`,
          [run.turnId, this.id],
        )
        return counted[0] ? { calls: counted[0].calls, stopRequested: counted[0].stop } : null
      },
      paused: async () => {
        await db.query(`UPDATE ai_turns SET pauses = pauses + 1 WHERE id = $1 AND runner = $2`, [run.turnId, this.id])
      },
      fence: (tx) => this.fence(tx, run.turnId),
      finish: (tx, outcome) => this.finishIn(tx, run, outcome),
    }
    return {
      question: {
        db,
        readers: this.deps.readers,
        model: this.deps.model,
        apiKey: availability.apiKey,
        config,
        userId: run.userId,
        modelId,
        effort,
        owner: run.owner,
        conversation,
        turnId: run.turnId,
        messages,
        attachments: new AttachmentExpander(db, this.deps.images),
        emit,
        signal: run.ac.signal,
        // The time it has run already counts, wherever it ran; the time between, while nobody wrote it, does not.
        deadlineMs: Math.max(0, TURN_DEADLINE_MS - turn.elapsedMs),
        tools: turnToolHandlers({
          db,
          config,
          readers: this.deps.readers,
          images: this.deps.images,
          reportLimiter: this.deps.reportLimiter,
          userId: run.userId,
          userName: turn.userName,
          conversation,
          turnId: run.turnId,
          emit,
        }),
        control,
        pending: pending ? { messageId: pending.id, content: pending.content } : undefined,
      },
    }
  }

  /** First in a transaction that writes the answer: the turn must still be this instance's. */
  private async fence(tx: Queryable, turnId: string): Promise<void> {
    const { rowCount } = await tx.query(`SELECT 1 FROM ai_turns WHERE id = $1 AND runner = $2 AND status = 'running' FOR UPDATE`, [turnId, this.id])
    if (!rowCount) throw new TurnLost()
  }

  /** Close the turn, when it is still this instance's: in a transaction of its own. */
  private async close(run: Pick<LocalRun, 'turnId' | 'conversationId' | 'userId' | 'subscribers'>, outcome: Outcome, tell = true): Promise<void> {
    await withTransaction(this.deps.db, async (tx) => {
      const { rowCount } = await tx.query(`SELECT 1 FROM ai_turns WHERE id = $1 AND runner = $2 AND status = 'running' FOR UPDATE`, [run.turnId, this.id])
      if (rowCount) await this.finishIn(tx, run, outcome, tell)
    })
  }

  /** The turn closed in this transaction, and its asker told in the bell when nobody was watching it end. */
  private async finishIn(tx: Queryable, run: Pick<LocalRun, 'turnId' | 'conversationId' | 'userId' | 'subscribers'>, outcome: Outcome, tell = true): Promise<void> {
    const closed = await finishTurn(tx, run.turnId, outcome.stopReason, outcome.notice)
    // Stopped by the asker: they know. Watched as it ended: it is on their screen.
    if (!closed || !tell || outcome.stopReason === 'stopped' || run.subscribers.size > 0) return
    const { rows } = await tx.query<{ watched: boolean; title: string }>(
      `SELECT COALESCE(t.watched_at > now() - make_interval(secs => $2), false) AS watched, c.title
         FROM ai_turns t JOIN ai_conversations c ON c.id = t.conversation_id WHERE t.id = $1`,
      [run.turnId, WATCHING_SECONDS],
    )
    if (!rows[0] || rows[0].watched) return
    const answer = (await loadDisplayMessages(tx, run.conversationId, run.turnId)).find((m) => m.role === 'assistant')
    // The answer itself: what it wrote last, after its queries, not the line on what it would check first.
    const text = answer?.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).at(-1) ?? ''
    const finished = outcome.stopReason === 'end_turn' || outcome.stopReason === 'max_tokens'
    await createNotifications(tx, [run.userId], {
      kind: 'ai-answer',
      severity: finished ? 'info' : 'warning',
      title: `${finished ? 'Answer ready' : 'Answer not finished'}: ${isolate(rows[0].title)}`,
      body: finished ? answerExcerpt(text) || 'The assistant finished answering.' : (outcome.notice ?? 'The answer could not be finished.'),
      link: `/ai?c=${run.conversationId}`,
      aiTurnId: run.turnId,
    })
  }

  private startBeat(): void {
    if (this.beatTimer) return
    this.lastBeatOk = Date.now()
    this.beatTimer = setInterval(() => void this.beatNow(), HEARTBEAT_MS)
    this.beatTimer.unref()
  }

  private stopBeat(): void {
    if (this.beatTimer) clearInterval(this.beatTimer)
    this.beatTimer = null
  }

  /**
   * Say the answers here are alive, with how long each has run; learn which were stopped, and which are no longer this
   * instance's (taken over), and stop those here. Then, apart, what each is doing: a line of the model's own words
   * never stands in the way of the lease.
   */
  async heartbeat(): Promise<void> {
    // Asked for (the tests beat themselves): after the beat under way, one of its own.
    while (this.beating) await this.beating
    await this.beatNow()
  }

  private async beatNow(): Promise<void> {
    const runs = [...this.runs.values()]
    if (runs.length === 0) return
    const now = Date.now()
    // Silent too long (the beats failing, or hanging): they will be taken over, so stop writing them here first.
    if (now - this.lastBeatOk > GIVE_UP_MS) for (const run of runs) run.ac.abort(HANDED_OVER)
    if (this.beating) return
    this.beating = this.beat(runs, now).finally(() => {
      this.beating = null
    })
    await this.beating
  }

  private async beat(runs: LocalRun[], now: number): Promise<void> {
    let alive: Map<string, boolean>
    try {
      const { rows } = await this.deps.db.query<{ id: string; stop: boolean }>(
        `UPDATE ai_turns t SET heartbeat_at = now(), elapsed_ms = LEAST(t.elapsed_ms + u.add, 86400000)
           FROM unnest($2::uuid[], $3::int[]) AS u(id, add)
          WHERE t.id = u.id AND t.runner = $1 AND t.status = 'running'
          RETURNING t.id, (t.stop_requested_at IS NOT NULL) AS stop`,
        [this.id, runs.map((r) => r.turnId), runs.map((r) => Math.max(0, now - r.countedAt))],
      )
      this.lastBeatOk = now
      alive = new Map(rows.map((r) => [r.id, r.stop]))
    } catch (e) {
      console.warn("[ai] the answers' heartbeat failed:", e instanceof Error ? e.message : String(e))
      if (Date.now() - this.lastBeatOk > GIVE_UP_MS) for (const run of runs) run.ac.abort(HANDED_OVER)
      return
    }
    for (const run of runs) {
      run.countedAt = now
      const stop = alive.get(run.turnId)
      if (stop === undefined) run.ac.abort(HANDED_OVER)
      else if (stop) run.ac.abort(STOPPED)
    }
    const changed = runs.filter((r) => alive.has(r.turnId) && r.progress !== r.progressWritten)
    if (changed.length === 0) return
    const lines = changed.map((r) => r.progress)
    try {
      await this.deps.db.query(
        `UPDATE ai_turns t SET progress = u.progress FROM unnest($2::uuid[], $3::text[]) AS u(id, progress)
          WHERE t.id = u.id AND t.runner = $1 AND t.status = 'running'`,
        [this.id, changed.map((r) => r.turnId), lines],
      )
      changed.forEach((r, i) => (r.progressWritten = lines[i]))
    } catch (e) {
      console.warn("[ai] what the answers are doing could not be written:", e instanceof Error ? e.message : String(e))
    }
  }
}

/** The line a heartbeat stores of what an answer is doing, from one of its events; null leaves it as it was. */
export function progressOf(event: AiStreamEvent): string | null {
  switch (event.type) {
    case 'progress':
      return clipText(oneLine(event.text), 300)
    case 'query_start':
      return clipText(`Looking it up: ${oneLine(event.purpose)}`, 300)
    case 'text':
      return 'Writing the answer…'
    default:
      return null
  }
}

/** The model's words as one line of text: no control characters (Postgres keeps no NUL), no runs of spaces. */
const oneLine = (text: string) =>
  // eslint-disable-next-line no-control-regex
  text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()

/** The opening of an answer as a bell line: its words, without the markdown. */
export function answerExcerpt(markdown: string): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, ' ')
    .replace(/[#>*_`|~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return clipText(plain, 240)
}
