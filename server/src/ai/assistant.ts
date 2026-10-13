// ============================================================================
// §20 — answering one question. The model is called in a loop: it writes,
// asks for queries, reads their results and writes again, until it has
// answered (or a limit, the cap, the asker or an error stops it).
//
// What keeps a conversation sound across requests, restarts and deploys:
//   • the history is append-only and replayed byte for byte. An answer that
//     asked for queries is stored together with all their results, in one
//     transaction, so a request never sends a tool call without its result.
//     A refused answer is kept for display and never sent again; so is an
//     empty one, which the API would refuse anywhere but at the end.
//   • every call's cost is written the moment the call ends, and before every
//     call the month's spend plus the most that call could cost must stay
//     within both caps, the assistant's and the asker's own; the asker's
//     access is read again then too, so a person the owner stops (or an
//     account deactivated) gets no further call.
//   • each query the model asks for runs as the asker's domains as they are
//     when it runs, read again right before it: a domain the owner takes away
//     while the model was writing is gone for that query already, and a
//     person the owner stops meanwhile gets no query run at all.
//   • each question runs on the model and effort the owner set for the asker
//     when it was asked, shaped for that model (models.ts).
//   • the model's tool input is checked here (eager input streaming means the
//     API no longer does), and a query only ever runs through the sandbox. A
//     chart asked for with it is checked against the result (charts.ts); one
//     that does not fit is left out, with a word on why in the result.
//   • a conversation given more tools than run_sql (§21: the automations'
//     tools, for people allowed to create them; §23: the notices' tools) has
//     them run by name, by the handlers the request hands in; what they keep
//     (a proposal, a notice card) is stored in the same transaction as the
//     call and its result. A tool the conversation was never given is
//     answered as unknown.
//   • a question's files are stored by reference and become what Claude reads
//     right before each call (attachments.ts), read once per answer; the caps
//     price them at their counted tokens.
//   • an answer outlives its request (answerRunner.ts). Run under a TurnControl,
//     its limits (model calls, pauses) are counted on the turn, so they hold
//     across a hand-over; every transaction that stores part of it first checks
//     the turn is still this instance's (the fence); a step is stored before
//     its tools run, so a step cut short is finished from there, each tool run
//     once; and the transaction that stores the answer's last message closes
//     the turn too, so a hand-over never mistakes a finished answer for one to
//     go on with. Handed over (the server stopping, or the turn taken over), the
//     loop stops where it is and keeps nothing half-done: the instance that
//     continues it starts from what is stored.
// ============================================================================

import { randomUUID } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import type pg from 'pg'
import {
  AI_PREVIEW_ROWS,
  aiCostUsd,
  type AiDomain,
  type AiEffort,
  type AiModelId,
  type AiStopReason,
  type AiStreamEvent,
  type AiTokenUsage,
} from '@qc/shared/ai'
import type { ApiErrorCode } from '@qc/shared/api'
import type { Config } from '../config'
import { withTransaction, type Db, type Queryable } from '../db/pool'
import { ACCESS_NOTICE, checkCall, isGranted, loadAccess } from './access'
import { isAttachmentRef, type AttachmentExpander, type StoredBlock, type StoredMessage } from './attachments'
import { checkChart } from './charts'
import type { AiModelClient, ModelMessage, ModelParams, ModelStream } from './model'
import { MAX_TOKENS, MAX_TOKENS_RETRY, modelRequest, systemBlocks, worstCaseUsd } from './models'
import { MAX_STEPS_PER_ANSWER, RUN_SQL_TOOL_NAME, RunSqlInput, TURN_DEADLINE_MINUTES, WRAP_UP_STEPS, WRAP_UP_TAG, WRAP_UP_TIME_SHARE } from './prompt'
import { AI_QUERY_STOPPED, previewJson, previewOf, runReadOnlyQuery } from './runQuery'
import { appendMessages, insertQueries, queryPart, recordUsage, settleStep, type NewMessage, type QueryRecord, type UsageRecord } from './transcript'

type ContentBlock = Anthropic.Beta.BetaContentBlock
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam
type ToolUse = Anthropic.Beta.BetaToolUseBlock
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam

/** Calls to the model one question may take: enough for an analysis built in steps (prompt.ts tells the model). */
const MAX_CALLS = MAX_STEPS_PER_ANSWER
/** pause_turn continuations (server tools only; there are none, so this is a guard). */
const MAX_CONTINUATIONS = 5
/** Wall-clock time one question may take. */
export { TURN_DEADLINE_MINUTES }
export const TURN_DEADLINE_MS = TURN_DEADLINE_MINUTES * 60_000
/** Tool input the SDK could not parse at all: the call is made again, this many times. */
const JSON_RETRIES = 2
/** A query the assistant runs may take this long: the most the runner allows, so an analysis over years of the record can finish. */
export const CHAT_QUERY_TIMEOUT_MS = 30_000
/** At most this often a line on what the model is doing. */
const PROGRESS_EVERY_MS = 250
const PROGRESS_CHARS = 200
/**
 * A call cut off is counted as having written at least this many tokens a
 * second since it began — more than the model streams. Summarized thinking
 * sends far fewer characters than it bills, so the characters alone undercount.
 */
const CUT_OFF_TOKENS_PER_SECOND = 200
/** An answer with nothing written: the model is asked to go on (Anthropic's advice) this many times. */
const EMPTY_RETRIES = 1
const CONTINUE_PROMPT = 'Please continue.'

const NOTICE = {
  stopped: 'Stopped before the answer was finished.',
  steps: 'This question needed more steps than one answer may take. Ask a narrower question.',
  time: `This answer took longer than ${TURN_DEADLINE_MINUTES} minutes and was stopped. Ask a narrower question.`,
  tooLong: 'This conversation is too long to go on. Start a new one.',
  cutOff: 'The answer was cut off at its maximum length.',
  empty: 'Claude returned an empty answer. Ask again, or rephrase the question.',
}

/** What cut an answer short: the asker (Stop), the clock, or a hand-over to another run (the server stopping, the turn lost). */
type Cause = 'user' | 'time' | 'handover'

/** The reason a run's signal is aborted with when the answer is handed over rather than stopped: it continues elsewhere. */
export const HANDED_OVER = 'handed-over'

/** Thrown by a TurnControl's fence when the turn is no longer this instance's: nothing more of it is stored here. */
export class TurnLost extends Error {
  constructor() {
    super('The answer is being written by another run.')
  }
}

/**
 * The result a query gets when the answer is cut short, by cause. It stays in
 * the replay for good, so it says what really happened.
 */
const INTERRUPTED: Record<Exclude<Cause, 'handover'>, { running: string; notRun: string }> = {
  user: { running: 'Interrupted by the user.', notRun: 'Interrupted by the user.' },
  time: { running: 'Stopped: the answer reached its time limit.', notRun: 'Not run: the answer reached its time limit.' },
}

/** The result a query gets when the asker lost the assistant while the model was writing: it never ran. */
export const WITHDRAWN_NOT_RUN = 'Not run: the person asking no longer has access to the assistant.'

/** Where a step's queries run: the pool of the asker's domains, which read those views and no others. */
export interface Readers {
  poolFor(domains: readonly AiDomain[]): pg.Pool | null
}

/** What a tool other than run_sql did (§21): its result, and what to keep with the answer. */
export interface ToolOutcome {
  result: ToolResult
  /** Stored in the transaction that stores the call and its result, so neither is ever kept without the other. */
  store?: (tx: Queryable) => Promise<void>
}

/** A tool other than run_sql, run by its name for a conversation that was given it. */
export interface ToolHandler {
  run(tu: ToolUse, signal: AbortSignal): Promise<ToolOutcome>
}

export interface Question {
  db: Db
  /** The asker's queries run as their domains as they stand when each runs: a domain the owner takes away is gone for the next query. */
  readers: Readers
  model: AiModelClient
  apiKey: string
  config: Config
  userId: string
  /** The model and effort the owner set for the asker, as they stood when the question was asked. */
  modelId: AiModelId
  effort: AiEffort
  /** The asker controls the assistant: told precisely why it failed, where others are told it is not available. */
  owner?: boolean
  conversation: { id: string; systemPrompt: string; tools: Anthropic.Beta.BetaToolUnion[] }
  turnId: string
  /** The replay, ending with this question; files by reference. */
  messages: StoredMessage[]
  /** What the files referenced in the replay are read as; needed whenever it references any. */
  attachments?: AttachmentExpander
  emit: (event: AiStreamEvent) => void
  /** Aborts when the asker presses Stop or leaves. */
  signal: AbortSignal
  /** How long the answer may take; TURN_DEADLINE_MINUTES unless a test needs it shorter. */
  deadlineMs?: number
  /** Handlers of the conversation's tools besides run_sql, by name; one the conversation was not given never runs. */
  tools?: Record<string, ToolHandler>
  /** The turn's run (answerRunner.ts): its limits across hand-overs, Stop, and the fence on every write. Without one the loop keeps its limits itself. */
  control?: TurnControl
  /** A step stored before its tools ran, when the answer was cut short there: its tools run first, once each, then it goes on. */
  pending?: { messageId: string; content: ContentBlockParam[] }
}

/**
 * What a turn's run keeps on the turn itself, so it holds wherever the answer is written: the model calls made, the
 * pauses, Stop, and that the turn is still this instance's.
 */
export interface TurnControl {
  /** Model calls the turn has made already, its pauses, and whether it has already asked the model to go on after an empty answer. */
  readonly calls: number
  readonly pauses: number
  readonly emptyRetried: boolean
  /** It has been told to close already (WRAP_UP_TAG): once per answer. */
  readonly wrappedUp: boolean
  /** Right before each call: counted. Null when the turn is no longer this instance's; stopRequested when Stop was pressed. */
  beforeCall(): Promise<{ calls: number; stopRequested: boolean } | null>
  /** A pause_turn, counted. */
  paused(): Promise<void>
  /** First in every transaction that stores part of the answer: throws TurnLost when the turn is no longer this instance's. */
  fence(tx: Queryable): Promise<void>
  /** The answer ends with what this transaction stores: the turn is closed in it. */
  finish(tx: Queryable, outcome: Outcome): Promise<void>
}

export interface Outcome {
  stopReason: AiStopReason
  notice: string | null
  /** Handed over, not ended: nothing was closed, and another run continues it from what is stored. */
  handedOver?: true
}

const HANDED_OVER_OUTCOME: Outcome = { stopReason: 'stopped', notice: null, handedOver: true }

// ---- Content as it is replayed -----------------------------------------------------

/**
 * The answer as it is sent back. Unchanged, unless a fallback model took over
 * mid-answer: then, before the last hand-over, only the text, the hand-over
 * markers and the server tools' calls that came with their results (a tool
 * search and what it found) are echoed — the API's rule; the markers stay
 * where they were.
 */
export function toReplayContent(content: ContentBlock[]): ContentBlockParam[] {
  let last = -1
  content.forEach((b, i) => {
    if (b.type === 'fallback') last = i
  })
  if (last < 0) return content as ContentBlockParam[]
  // A server tool's result (in an answer, every *_tool_result is one) names its call by tool_use_id.
  const resultOf = (b: ContentBlock): string | null => (b.type.endsWith('_tool_result') && 'tool_use_id' in b && typeof b.tool_use_id === 'string' ? b.tool_use_id : null)
  const calls = new Set(content.flatMap((b) => (b.type === 'server_tool_use' ? [b.id] : [])))
  const answered = new Set(content.flatMap((b) => resultOf(b) ?? []))
  const paired = (b: ContentBlock) => (b.type === 'server_tool_use' && answered.has(b.id)) || (resultOf(b) !== null && calls.has(resultOf(b)!))
  return content.filter((b, i) => i >= last || b.type === 'text' || b.type === 'fallback' || paired(b)) as ContentBlockParam[]
}

// ---- What a call cost --------------------------------------------------------------

interface UsageLike {
  input_tokens: number | null
  output_tokens: number | null
  cache_creation_input_tokens: number | null
  cache_read_input_tokens: number | null
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } | null
}

function tokensOf(u: UsageLike): AiTokenUsage {
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    // Without the breakdown every cache write is a five-minute one (the only kind asked for).
    cacheWrite5mTokens: u.cache_creation ? u.cache_creation.ephemeral_5m_input_tokens : (u.cache_creation_input_tokens ?? 0),
    cacheWrite1hTokens: u.cache_creation ? u.cache_creation.ephemeral_1h_input_tokens : 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
  }
}

const addTokens = (a: AiTokenUsage, b: AiTokenUsage): AiTokenUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheWrite5mTokens: a.cacheWrite5mTokens + b.cacheWrite5mTokens,
  cacheWrite1hTokens: a.cacheWrite1hTokens + b.cacheWrite1hTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
})

const NO_TOKENS: AiTokenUsage = { inputTokens: 0, outputTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0 }

/**
 * A finished call's tokens and cost. With a fallback, `usage.iterations` is
 * the record of every attempt, each billed at its own model's rates; the
 * top-level usage covers only the last one. Never both. `requested`: the
 * model the call asked for, which an attempt that names none ran on.
 */
export function usageOf(message: ModelMessage, requested: string): { model: string; tokens: AiTokenUsage; costUsd: number } {
  const model = message.model || requested
  const iterations = message.usage.iterations ?? []
  if (iterations.length === 0) {
    const tokens = tokensOf(message.usage)
    return { model, tokens, costUsd: aiCostUsd(model, tokens) }
  }
  let tokens = NO_TOKENS
  let cost = 0
  for (const it of iterations) {
    // An attempt that names no model ran on the model asked for.
    const itModel = ('model' in it && it.model) || requested
    const t = tokensOf(it)
    tokens = addTokens(tokens, t)
    cost += aiCostUsd(itModel, t)
  }
  return { model, tokens, costUsd: Math.round(cost * 1_000_000) / 1_000_000 }
}

// ---- Errors --------------------------------------------------------------------------

export const KEY_REFUSED_MESSAGE = 'The API key was refused by Anthropic. Set a new one under Administration → AI assistant.'
/** What someone who does not control the assistant is told when its key or account is the trouble: theirs to wait out, not to fix. */
export const NOT_AVAILABLE_MESSAGE = 'The assistant is not available right now. Try again later.'
const BUSY_MESSAGE = 'Claude is busy right now — try again in a minute.'

/**
 * A failed answer as the asker is told: a short sentence, never the API's own
 * text. The owner learns what to fix (the key, the account); anyone else only
 * that the assistant is not available.
 */
export function describeModelFailure(err: unknown, conversationId: string, owner = false): { code: ApiErrorCode; message: string } {
  const where = `[ai] conversation ${conversationId}:`
  if (err instanceof Anthropic.APIError) {
    // The message and the request id only: an error's request details are never logged.
    const logIt = () => console.warn(where, `${err.constructor.name}${err.requestID ? ` (request ${err.requestID})` : ''}: ${err.message}`)
    const ownersOnly = (message: string) => ({ code: 'ai_unavailable' as const, message: owner ? message : NOT_AVAILABLE_MESSAGE })
    if (err instanceof Anthropic.AuthenticationError) {
      logIt()
      return ownersOnly(KEY_REFUSED_MESSAGE)
    }
    if (err instanceof Anthropic.PermissionDeniedError) {
      logIt()
      return ownersOnly('Anthropic does not allow this API key to use the assistant. Check the key under Administration → AI assistant.')
    }
    if (err instanceof Anthropic.NotFoundError) {
      logIt()
      return ownersOnly('This API key cannot use the model set for you. Check the key, or choose another model, under Administration → AI assistant.')
    }
    if (err instanceof Anthropic.RateLimitError || err.type === 'overloaded_error' || err.status === 529) return { code: 'rate_limited', message: BUSY_MESSAGE }
    if (err.type === 'billing_error' || err.status === 402) {
      logIt()
      return ownersOnly('The Anthropic account behind the API key cannot be billed. Check it in the Anthropic console.')
    }
    if (err instanceof Anthropic.APIConnectionError) {
      logIt()
      return { code: 'internal', message: 'Claude could not be reached. Try again in a minute.' }
    }
    logIt()
    if (err instanceof Anthropic.BadRequestError) {
      return { code: 'internal', message: 'Claude could not take this request. Try again; if it happens again, start a new conversation.' }
    }
    return { code: 'internal', message: 'Claude had a problem answering. Try again in a minute.' }
  }
  console.error(where, 'answer failed', err)
  return { code: 'internal', message: 'Something went wrong while answering. Nothing was lost; try again.' }
}

// ---- The loop --------------------------------------------------------------------------

/**
 * Answer one question, streaming what happens to `emit`. Returns how the
 * answer ended; throws only what the model (or the database) failed with, for
 * the caller to report.
 */
export async function answerQuestion(qn: Question): Promise<Outcome> {
  // One signal for everything this answer starts: the asker's Stop, and the clock.
  const ac = new AbortController()
  let overTime = false
  const onAbort = () => ac.abort()
  if (qn.signal.aborted) ac.abort()
  qn.signal.addEventListener('abort', onAbort)
  const deadlineMs = qn.deadlineMs ?? TURN_DEADLINE_MS
  const deadlineAt = Date.now() + deadlineMs
  const deadline = setTimeout(() => {
    // The first to stop it is the cause: a Stop the clock overtakes stays the asker's.
    if (!ac.signal.aborted) overTime = true
    ac.abort()
  }, deadlineMs)
  deadline.unref()
  try {
    return await loop(qn, ac.signal, () => (overTime ? 'time' : qn.signal.reason === HANDED_OVER ? 'handover' : 'user'), deadlineAt)
  } catch (e) {
    if (e instanceof TurnLost) return HANDED_OVER_OUTCOME
    throw e
  } finally {
    clearTimeout(deadline)
    qn.signal.removeEventListener('abort', onAbort)
  }
}

/** A call's request as stored: the replay's files by reference. The caps price it so (worstCaseUsd). */
type StoredParams = Omit<ModelParams, 'messages'> & { messages: StoredMessage[] }

function requestParams(qn: Question, messages: StoredMessage[], maxTokens: number): StoredParams {
  return {
    // In tests an edited history must fail loudly; in production it costs the thinking, not the answer.
    ...modelRequest(qn.modelId, qn.effort, qn.config.NODE_ENV === 'test' ? 'error' : 'drop_block'),
    max_tokens: maxTokens,
    // The growing conversation is cached automatically; the system prompt (and the tools before it) explicitly.
    cache_control: { type: 'ephemeral' },
    system: systemBlocks(qn.conversation.systemPrompt),
    tools: qn.conversation.tools,
    messages: [...messages],
  }
}

/** The request as Claude receives it: every file's reference replaced by what Claude reads for it. */
async function wireParams(qn: Question, params: StoredParams): Promise<ModelParams> {
  if (qn.attachments) return { ...params, messages: await qn.attachments.expand(params.messages) }
  if (params.messages.some((m) => m.content.some(isAttachmentRef))) throw new Error('A conversation with files was asked without a way to read them.')
  return params as ModelParams
}

async function loop(qn: Question, signal: AbortSignal, cause: () => Cause, deadlineAt: number): Promise<Outcome> {
  const stopped = (): Outcome => {
    const c = cause()
    if (c === 'handover') return HANDED_OVER_OUTCOME
    return c === 'time' ? { stopReason: 'limit', notice: NOTICE.time } : { stopReason: 'stopped', notice: NOTICE.stopped }
  }
  const messages = [...qn.messages]
  let maxTokens = MAX_TOKENS
  // Counted on the turn when it has a run, so a hand-over does not start them again.
  let calls = qn.control?.calls ?? 0
  let continuations = qn.control?.pauses ?? 0
  let jsonRetries = 0
  let streamRetries = 0
  let emptyRetries = qn.control?.emptyRetried ? EMPTY_RETRIES : 0
  let wrappedUp = qn.control?.wrappedUp ?? false
  /** The note telling the answer to close, when either limit is near and it has not been told yet; then it has. */
  const wrapUp = (): string | null => {
    const minutesLeft = Math.max(0, Math.floor((deadlineAt - Date.now()) / 60_000))
    const stepsLeft = Math.max(0, MAX_CALLS - calls)
    if (wrappedUp || (stepsLeft > WRAP_UP_STEPS && deadlineAt - Date.now() > TURN_DEADLINE_MS * WRAP_UP_TIME_SHARE)) return null
    wrappedUp = true
    return wrapUpNote(stepsLeft, minutesLeft)
  }

  // A step cut short after it was stored: its tools run now, once each, and the answer goes on from its results.
  if (qn.pending) {
    const toolUses = qn.pending.content.filter((b): b is ToolUse => b.type === 'tool_use')
    const step = { id: qn.pending.messageId, param: { role: 'assistant' as const, content: qn.pending.content as StoredBlock[] } }
    const done = await runStep(qn, step, toolUses, signal, cause, wrapUp())
    if (done.outcome) return done.outcome
    messages.push(...done.stored)
  }

  for (;;) {
    if (signal.aborted) return stopped()
    if (calls >= MAX_CALLS) return { stopReason: 'limit', notice: NOTICE.steps }
    const params = requestParams(qn, messages, maxTokens)
    // The asker's access and both caps, as they stand now: the owner may have changed them since the answer began.
    const stop = await checkCall(qn.db, qn.userId, worstCaseUsd(params))
    if (stop) return stop
    const wire = await wireParams(qn, params)
    if (signal.aborted) return stopped()
    if (qn.control) {
      // Counted before it is made, so a call cut off with its instance still counts; and Stop, pressed on any instance, is seen here.
      const turn = await qn.control.beforeCall()
      if (!turn) return HANDED_OVER_OUTCOME
      if (turn.stopRequested) return { stopReason: 'stopped', notice: NOTICE.stopped }
      calls = turn.calls
    } else {
      calls++
    }

    const stream = qn.model.stream(qn.apiKey, wire, { signal })
    const watch = watchStream(stream, qn.emit)
    let message: ModelMessage
    try {
      message = await stream.finalMessage()
    } catch (err) {
      // A stream that failed on its own may still be reading the response, which would go uncounted: stop it.
      if (!(err instanceof Anthropic.APIUserAbortError)) stream.abort()
      await recordCutOffUsage(qn.db, { userId: qn.userId, conversationId: qn.conversation.id, turnId: qn.turnId }, stream, watch, params)
      if (err instanceof Anthropic.APIUserAbortError || signal.aborted) return stopped()
      if (err instanceof Anthropic.APIError) {
        // An error event inside an open stream (no status) is not retried by the SDK: once here.
        if (err.status === undefined && err.type === 'overloaded_error' && streamRetries++ < 1) continue
        throw err
      }
      // Anything else is tool input the SDK could not parse at all: ask again, a few times.
      if (jsonRetries++ < JSON_RETRIES) continue
      throw err
    }
    jsonRetries = 0
    streamRetries = 0
    const usage = usageOf(message, params.model)
    await recordUsage(qn.db, {
      userId: qn.userId,
      conversationId: qn.conversation.id,
      turnId: qn.turnId,
      model: usage.model,
      tokens: usage.tokens,
      costUsd: usage.costUsd,
      requestId: stream.request_id ?? null,
    })
    noteDroppedThinking(qn, message)

    const replay = toReplayContent(message.content)
    const answerMessage = (inReplay = true): NewMessage => ({
      role: 'assistant',
      kind: 'assistant',
      content: replay,
      rawContent: replay === message.content ? undefined : message.content,
      // A message with no content is refused anywhere but at the very end: in the replay it would sink every later question.
      inReplay: inReplay && replay.length > 0,
      model: message.model,
    })

    switch (message.stop_reason) {
      case 'refusal': {
        // A refusal can cut a tool call off mid-input: nothing of it runs, and it is never replayed.
        const category = message.stop_details?.category
        return persistFinal(qn, [answerMessage(false)], {
          stopReason: 'refusal',
          notice: `Claude declined to answer this${category ? ` (${category.replace(/_/g, ' ')})` : ''}. Rephrase the question, or ask something else.`,
        })
      }
      case 'pause_turn':
        if (++continuations > MAX_CONTINUATIONS) return { stopReason: 'limit', notice: NOTICE.steps }
        await qn.control?.paused()
        // Sent again as it is, with no new message: the model carries on.
        messages.push(...(await persist(qn, [answerMessage()])))
        continue
      case 'model_context_window_exceeded':
        return persistFinal(qn, [answerMessage()], { stopReason: 'limit', notice: NOTICE.tooLong })
    }

    const toolUses = replay.filter((b): b is ToolUse => b.type === 'tool_use')
    if (message.stop_reason === 'max_tokens') {
      if (toolUses.length > 0) {
        // A cut-off tool input often still parses: never run it. Ask again with more room — not a history edit.
        if (maxTokens < MAX_TOKENS_RETRY) {
          maxTokens = MAX_TOKENS_RETRY
          continue
        }
        return { stopReason: 'max_tokens', notice: NOTICE.cutOff }
      }
      return persistFinal(qn, [answerMessage()], { stopReason: 'max_tokens', notice: NOTICE.cutOff })
    }
    if (toolUses.length === 0) {
      if (hasText(replay)) return persistFinal(qn, [answerMessage()], { stopReason: 'end_turn', notice: null })
      // Nothing written (it happens, mostly right after query results). Kept for the record, never
      // replayed: the model has decided it is done, so it is asked to go on in a message of its own.
      if (emptyRetries++ < EMPTY_RETRIES) {
        const goOn: NewMessage = { role: 'user', kind: 'repair', content: [{ type: 'text', text: CONTINUE_PROMPT }] }
        messages.push(...(await persist(qn, [answerMessage(false), goOn])))
        continue
      }
      return persistFinal(qn, [answerMessage(false)], { stopReason: 'end_turn', notice: NOTICE.empty })
    }

    // The step is stored before its tools run: cut short now, it is finished from here, not asked of the model again.
    const [step] = await store(qn, [{ ...answerMessage(), pending: true }])
    const done = await runStep(qn, step, toolUses, signal, cause, wrapUp())
    if (done.outcome) return done.outcome
    messages.push(...done.stored)
  }
}

/**
 * One step's tools, then the step with their results into the replay, in one transaction. Every call is answered, in
 * one message, in order; once the answer is cut short the rest are not run — unless it is handed over, when nothing of
 * the step is kept and the run that continues it runs them.
 */
async function runStep(
  qn: Question,
  step: { id: string; param: StoredMessage },
  toolUses: ToolUse[],
  signal: AbortSignal,
  cause: () => Cause,
  note: string | null,
): Promise<{ stored: StoredMessage[]; outcome?: undefined } | { outcome: Outcome }> {
  const results: ToolResult[] = []
  const queries: QueryRecord[] = []
  const stores: ((tx: Queryable) => Promise<void>)[] = []
  let withdrawn = false
  for (const tu of toolUses) {
    if (signal.aborted) {
      const c = cause()
      if (c === 'handover') return { outcome: HANDED_OVER_OUTCOME }
      results.push(notRun(tu, INTERRUPTED[c].notRun))
      continue
    }
    // The asker's domains as they are now, not as they were before the call: the owner may have
    // changed them, or taken the assistant away, while the model was writing. One indexed read.
    const access = withdrawn ? null : await loadAccess(qn.db, qn.userId)
    if (!isGranted(access)) {
      withdrawn = true
      results.push(notRun(tu, WITHDRAWN_NOT_RUN))
      continue
    }
    const handler = toolHandler(qn, tu.name)
    if (!handler) {
      results.push(await runToolUse(qn, qn.readers.poolFor(access.domains), tu, queries, signal, cause))
      continue
    }
    const outcome = await handler.run(tu, signal)
    // Cut short while it ran: what it found is not kept, and the replay says why.
    if (signal.aborted) {
      const c = cause()
      if (c === 'handover') return { outcome: HANDED_OVER_OUTCOME }
      results.push(notRun(tu, INTERRUPTED[c].running))
    } else {
      results.push(outcome.result)
      if (outcome.store) stores.push(outcome.store)
    }
  }
  // Handed over while the last tool ran: its results are not kept here either.
  if (signal.aborted && cause() === 'handover') return { outcome: HANDED_OVER_OUTCOME }
  const stored = await withTransaction(qn.db, async (tx) => {
    await qn.control?.fence(tx)
    await settleStep(tx, step.id)
    // A note from the app, when there is one, after the results (the API wants the results first). Not on a step cut
    // short: that answer ends here, and the note would only be replayed to later questions.
    const content: StoredBlock[] = note && !signal.aborted ? [...results, { type: 'text', text: note }] : results
    const appended = await appendMessages(tx, qn.conversation.id, qn.turnId, [{ role: 'user', kind: 'tool_results', content }])
    await insertQueries(tx, qn.conversation.id, qn.turnId, queries)
    for (const s of stores) await s(tx)
    return appended
  })
  // Kept whole, results included, so the conversation can go on should the owner give it back.
  if (withdrawn) return { outcome: { stopReason: 'stopped', notice: ACCESS_NOTICE.withdrawn } }
  return { stored: [step.param, ...stored.map((m) => m.param)] }
}

/** What the answer is told near its limits: in a tag the prompt names, so it reads as the app's, not as data. */
export function wrapUpNote(stepsLeft: number, minutesLeft: number): string {
  const steps = `${stepsLeft} ${stepsLeft === 1 ? 'step' : 'steps'}`
  const minutes = minutesLeft < 1 ? 'less than a minute' : `about ${minutesLeft} ${minutesLeft === 1 ? 'minute' : 'minutes'}`
  return `<${WRAP_UP_TAG}>This answer is close to its limits: ${steps} and ${minutes} are left. Start nothing new. Save with save_table what is worth keeping and not saved yet, then close the answer: what you found, what you checked, and what remains to be done, so the person can ask you to go on.</${WRAP_UP_TAG}>`
}

const notRun = (tu: ToolUse, why: string): ToolResult => ({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: why })

/** The conversation's own tools that the model calls and this server runs, by name, as it was given them: not the tool search, which Anthropic runs. */
const toolNames = (qn: Question): string[] =>
  qn.conversation.tools.flatMap((t) => ('name' in t && typeof t.name === 'string' && (!('type' in t) || !t.type || t.type === 'custom') ? [t.name] : []))

/** The handler of a tool other than run_sql, when the conversation was given that tool and the request handles it. */
function toolHandler(qn: Question, name: string): ToolHandler | null {
  if (name === RUN_SQL_TOOL_NAME || !toolNames(qn).includes(name)) return null
  return qn.tools?.[name] ?? null
}

/** Whether a reply wrote anything the asker can read. */
const hasText = (content: ContentBlockParam[]) => content.some((b) => b.type === 'text' && b.text.trim() !== '')

/** Store messages of this answer, behind the fence; returns each with its id. */
async function store(qn: Question, messages: NewMessage[]): Promise<{ id: string; param: StoredMessage }[]> {
  return withTransaction(qn.db, async (tx) => {
    await qn.control?.fence(tx)
    return appendMessages(tx, qn.conversation.id, qn.turnId, messages)
  })
}

/** Store messages of this answer; returns them as they will be replayed. */
async function persist(qn: Question, messages: NewMessage[]): Promise<StoredMessage[]> {
  const stored = await store(qn, messages)
  return stored.filter((_, i) => messages[i].inReplay !== false && !messages[i].pending).map((s) => s.param)
}

/** Store the answer's last messages and, with a run, close the turn in the same transaction: the answer ends here. */
async function persistFinal(qn: Question, messages: NewMessage[], outcome: Outcome): Promise<Outcome> {
  await withTransaction(qn.db, async (tx) => {
    await qn.control?.fence(tx)
    await appendMessages(tx, qn.conversation.id, qn.turnId, messages)
    await qn.control?.finish(tx, outcome)
  })
  return outcome
}

/**
 * One run_sql call: checked, run in the sandbox, shown as a card (with its
 * chart, when one was asked for and fits the result), handed back to the
 * model. A Stop or the clock cancels the query itself, so the answer ends at
 * once rather than when the query would have.
 */
async function runToolUse(
  qn: Question,
  reader: pg.Pool | null,
  tu: ToolUse,
  queries: QueryRecord[],
  signal: AbortSignal,
  cause: () => Cause,
): Promise<ToolResult> {
  // A near-miss of the name (Run_SQL) is still the query tool.
  if (tu.name.toLowerCase() !== RUN_SQL_TOOL_NAME) {
    const names = toolNames(qn)
    // Worded as ever for a conversation with run_sql alone.
    const known = names.length > 1 ? `The tools are ${names.map((n) => `"${n}"`).join(', ')}.` : `The only tool is "${RUN_SQL_TOOL_NAME}".`
    return { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: `Unknown tool "${tu.name}". ${known}` }
  }
  const parsed = RunSqlInput.safeParse(tu.input)
  if (!parsed.success) {
    return { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: JSON.stringify({ INVALID_JSON: JSON.stringify(tu.input) }) }
  }
  const { purpose, sql, chart: askedChart } = parsed.data
  const queryId = randomUUID()
  qn.emit({ type: 'query_start', queryId, purpose, sql })
  const run = await runReadOnlyQuery(reader, sql, { maxRows: AI_PREVIEW_ROWS, timeoutMs: CHAT_QUERY_TIMEOUT_MS, timeZone: qn.config.FACTORY_TIMEZONE, signal })
  // Stopped through the signal (not a failure of its own that came first): the replay keeps why.
  // (Handed over, the step is not kept at all; the words never reach the replay.)
  if (!run.ok && run.error === AI_QUERY_STOPPED) run.error = INTERRUPTED[cause() === 'time' ? 'time' : 'user'].running
  const preview = previewOf(run)
  // A failed query has nothing to draw: its chart goes unmentioned, the error is what the model needs.
  const chart = run.ok ? checkChart(askedChart, preview) : {}
  const record: QueryRecord = { id: queryId, toolUseId: tu.id, purpose, sql, ok: run.ok, error: run.error, ms: run.ms, ...preview, chart: chart.chart ?? null }
  queries.push(record)
  qn.emit({ type: 'query_end', part: queryPart(record) })
  if (!run.ok) return { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: run.error ?? 'The query failed.' }
  // The rows as ever; what became of the chart, when it was not drawn as asked, in a text of its own after them.
  if (!chart.note) return { type: 'tool_result', tool_use_id: tu.id, content: previewJson(preview) }
  return {
    type: 'tool_result',
    tool_use_id: tu.id,
    content: [
      { type: 'text', text: previewJson(preview) },
      { type: 'text', text: chart.note },
    ],
  }
}

/** What a call has streamed so far, for counting it if it is cut off. */
export interface StreamWatch {
  /** Characters of every kind the model wrote: reply, thinking, tool input. */
  chars: () => number
  /** When the first event arrived; null before. */
  startedAt: () => number | null
}

/**
 * Count what the stream writes, and forward it to the asker when there is one
 * (`emit`): the reply as it is written, and now and then a line of what the
 * model is thinking.
 */
export function watchStream(stream: ModelStream, emit?: (e: AiStreamEvent) => void): StreamWatch {
  let chars = 0
  let startedAt: number | null = null
  let thinking = ''
  let lastProgress = 0
  let pending = false
  const progress = () => {
    pending = false
    lastProgress = Date.now()
    const line = thinking.replace(/\s+/g, ' ').trim()
    if (!line) return
    emit?.({ type: 'progress', text: line.length > PROGRESS_CHARS ? `…${line.slice(-PROGRESS_CHARS)}` : line })
  }
  // Counted from the raw deltas: tool input arrives only there (a call cut off mid-input has no finished
  // block), and each character is seen once. Not the SDK's inputJson event: it parses on every delta.
  stream.on('streamEvent', (event) => {
    startedAt ??= Date.now()
    if (event.type !== 'content_block_delta') return
    const d = event.delta
    if (d.type === 'text_delta') chars += d.text.length
    else if (d.type === 'thinking_delta') chars += d.thinking.length
    else if (d.type === 'input_json_delta') chars += d.partial_json.length
  })
  if (emit) {
    stream.on('text', (delta) => {
      emit({ type: 'text', delta })
    })
    stream.on('thinking', (_delta, snapshot) => {
      thinking = snapshot
      if (Date.now() - lastProgress >= PROGRESS_EVERY_MS) progress()
      else pending = true
    })
    stream.on('contentBlock', (block) => {
      if (block.type === 'thinking' && pending) progress()
    })
  }
  return { chars: () => chars, startedAt: () => startedAt }
}

/**
 * A call cut off (Stop, the clock, an error) is billed for what it used. The
 * input is known from the stream's start; the output only at its end, so it
 * is taken as the largest of what was reported, half a token per streamed
 * character, and the time it ran at more than the model writes — never more
 * than the call was allowed. The cap must err on the dear side.
 */
export async function recordCutOffUsage(
  db: Db,
  owner: Pick<UsageRecord, 'userId' | 'conversationId' | 'turnId' | 'automationId'>,
  stream: ModelStream,
  watch: StreamWatch,
  request: Pick<ModelParams, 'model' | 'max_tokens'>,
): Promise<void> {
  const current = stream.currentMessage
  if (!current) return
  const maxTokens = request.max_tokens
  const model = current.model || request.model
  const reported = tokensOf(current.usage)
  const started = watch.startedAt()
  const seconds = started === null ? 0 : (Date.now() - started) / 1000
  const estimate = Math.max(reported.outputTokens, Math.ceil(watch.chars() / 2), Math.ceil(seconds * CUT_OFF_TOKENS_PER_SECOND))
  const tokens = { ...reported, outputTokens: Math.min(maxTokens, estimate) }
  try {
    await recordUsage(db, {
      ...owner,
      model,
      tokens,
      costUsd: aiCostUsd(model, tokens),
      requestId: stream.request_id ?? null,
      partial: true,
    })
  } catch (e) {
    console.error('[ai] could not record the usage of a cut-off call', e)
  }
}

/** Thinking the API dropped because the history it was bound to changed: a bug here, worth a line in the log. */
function noteDroppedThinking(qn: Question, message: ModelMessage): void {
  const edits = (message.input_transformations ?? []).filter((t) => t.reason === 'prefix_binding_mismatch')
  if (edits.length > 0) {
    console.warn(`[ai] conversation ${qn.conversation.id}: the replayed history changed; thinking dropped at ${edits.map((t) => t.path).join(', ')}`)
  }
}
