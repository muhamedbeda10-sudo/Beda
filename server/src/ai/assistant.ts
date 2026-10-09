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
//     API no longer does), and a query only ever runs through the sandbox.
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
import { withTransaction, type Db } from '../db/pool'
import { ACCESS_NOTICE, checkCall, isGranted, loadAccess } from './access'
import type { AiModelClient, ModelMessage, ModelParams, ModelStream } from './model'
import { MAX_TOKENS, MAX_TOKENS_RETRY, modelRequest, systemBlocks, worstCaseUsd } from './models'
import { RUN_SQL_TOOL_NAME, RunSqlInput } from './prompt'
import { AI_QUERY_STOPPED, previewJson, previewOf, runReadOnlyQuery } from './runQuery'
import { appendMessages, insertQueries, queryPart, recordUsage, type NewMessage, type QueryRecord, type UsageRecord } from './transcript'

type MessageParam = Anthropic.Beta.BetaMessageParam
type ContentBlock = Anthropic.Beta.BetaContentBlock
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam
type ToolUse = Anthropic.Beta.BetaToolUseBlock
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam

/** Calls to the model one question may take. */
const MAX_CALLS = 10
/** pause_turn continuations (server tools only; there are none, so this is a guard). */
const MAX_CONTINUATIONS = 5
/** Wall-clock time one question may take. */
const TURN_DEADLINE_MS = 5 * 60_000
/** Tool input the SDK could not parse at all: the call is made again, this many times. */
const JSON_RETRIES = 2
/** A query the assistant runs may take this long. */
export const CHAT_QUERY_TIMEOUT_MS = 10_000
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
  time: 'This answer took longer than 5 minutes and was stopped. Ask a narrower question.',
  tooLong: 'This conversation is too long to go on. Start a new one.',
  cutOff: 'The answer was cut off at its maximum length.',
  empty: 'Claude returned an empty answer. Ask again, or rephrase the question.',
}

/** What cut an answer short: the asker (Stop, or leaving) or the clock. */
type Cause = 'user' | 'time'

/**
 * The result a query gets when the answer is cut short, by cause. It stays in
 * the replay for good, so it says what really happened.
 */
const INTERRUPTED: Record<Cause, { running: string; notRun: string }> = {
  user: { running: 'Interrupted by the user.', notRun: 'Interrupted by the user.' },
  time: { running: 'Stopped: the answer reached its time limit.', notRun: 'Not run: the answer reached its time limit.' },
}

/** The result a query gets when the asker lost the assistant while the model was writing: it never ran. */
export const WITHDRAWN_NOT_RUN = 'Not run: the person asking no longer has access to the assistant.'

/** Where a step's queries run: the pool of the asker's domains, which read those views and no others. */
export interface Readers {
  poolFor(domains: readonly AiDomain[]): pg.Pool | null
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
  /** The replay, ending with this question. */
  messages: MessageParam[]
  emit: (event: AiStreamEvent) => void
  /** Aborts when the asker presses Stop or leaves. */
  signal: AbortSignal
  /** How long the answer may take; 5 minutes unless a test needs it shorter. */
  deadlineMs?: number
}

export interface Outcome {
  stopReason: AiStopReason
  notice: string | null
}

// ---- Content as it is replayed -----------------------------------------------------

/**
 * The answer as it is sent back. Unchanged, unless a fallback model took over
 * mid-answer: then, before the last hand-over, only the text and the hand-over
 * markers are echoed (the API's rule); the markers stay where they were.
 */
export function toReplayContent(content: ContentBlock[]): ContentBlockParam[] {
  let last = -1
  content.forEach((b, i) => {
    if (b.type === 'fallback') last = i
  })
  if (last < 0) return content as ContentBlockParam[]
  return content.filter((b, i) => i >= last || b.type === 'text' || b.type === 'fallback') as ContentBlockParam[]
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
  const deadline = setTimeout(() => {
    // The first to stop it is the cause: a Stop the clock overtakes stays the asker's.
    if (!ac.signal.aborted) overTime = true
    ac.abort()
  }, qn.deadlineMs ?? TURN_DEADLINE_MS)
  deadline.unref()
  try {
    return await loop(qn, ac.signal, () => (overTime ? 'time' : 'user'))
  } finally {
    clearTimeout(deadline)
    qn.signal.removeEventListener('abort', onAbort)
  }
}

function requestParams(qn: Question, messages: MessageParam[], maxTokens: number): ModelParams {
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

async function loop(qn: Question, signal: AbortSignal, cause: () => Cause): Promise<Outcome> {
  const stopped = (): Outcome => (cause() === 'time' ? { stopReason: 'limit', notice: NOTICE.time } : { stopReason: 'stopped', notice: NOTICE.stopped })
  const messages = [...qn.messages]
  let maxTokens = MAX_TOKENS
  let calls = 0
  let continuations = 0
  let jsonRetries = 0
  let streamRetries = 0
  let emptyRetries = 0

  for (;;) {
    if (signal.aborted) return stopped()
    if (calls >= MAX_CALLS) return { stopReason: 'limit', notice: NOTICE.steps }
    const params = requestParams(qn, messages, maxTokens)
    // The asker's access and both caps, as they stand now: the owner may have changed them since the answer began.
    const stop = await checkCall(qn.db, qn.userId, worstCaseUsd(params))
    if (stop) return stop
    calls++

    const stream = qn.model.stream(qn.apiKey, params, { signal })
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
        await persist(qn, [answerMessage(false)])
        const category = message.stop_details?.category
        return {
          stopReason: 'refusal',
          notice: `Claude declined to answer this${category ? ` (${category.replace(/_/g, ' ')})` : ''}. Rephrase the question, or ask something else.`,
        }
      }
      case 'pause_turn':
        if (++continuations > MAX_CONTINUATIONS) return { stopReason: 'limit', notice: NOTICE.steps }
        // Sent again as it is, with no new message: the model carries on.
        messages.push(...(await persist(qn, [answerMessage()])))
        continue
      case 'model_context_window_exceeded':
        messages.push(...(await persist(qn, [answerMessage()])))
        return { stopReason: 'limit', notice: NOTICE.tooLong }
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
      messages.push(...(await persist(qn, [answerMessage()])))
      return { stopReason: 'max_tokens', notice: NOTICE.cutOff }
    }
    if (toolUses.length === 0) {
      if (hasText(replay)) {
        messages.push(...(await persist(qn, [answerMessage()])))
        return { stopReason: 'end_turn', notice: null }
      }
      // Nothing written (it happens, mostly right after query results). Kept for the record, never
      // replayed: the model has decided it is done, so it is asked to go on in a message of its own.
      if (emptyRetries++ < EMPTY_RETRIES) {
        const goOn: NewMessage = { role: 'user', kind: 'repair', content: [{ type: 'text', text: CONTINUE_PROMPT }] }
        messages.push(...(await persist(qn, [answerMessage(false), goOn])))
        continue
      }
      await persist(qn, [answerMessage(false)])
      return { stopReason: 'end_turn', notice: NOTICE.empty }
    }

    // Every call is answered, in one message, in order; once the answer is cut short the rest are not run.
    const results: ToolResult[] = []
    const queries: QueryRecord[] = []
    let withdrawn = false
    for (const tu of toolUses) {
      if (signal.aborted) {
        results.push(notRun(tu, INTERRUPTED[cause()].notRun))
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
      results.push(await runToolUse(qn, qn.readers.poolFor(access.domains), tu, queries, signal, cause))
    }
    const stored = await withTransaction(qn.db, async (tx) => {
      const appended = await appendMessages(tx, qn.conversation.id, qn.turnId, [answerMessage(), { role: 'user', kind: 'tool_results', content: results }])
      await insertQueries(tx, qn.conversation.id, qn.turnId, queries)
      return appended
    })
    // Kept whole, results included, so the conversation can go on should the owner give it back.
    if (withdrawn) return { stopReason: 'stopped', notice: ACCESS_NOTICE.withdrawn }
    messages.push(...stored.map((s) => s.param))
  }
}

const notRun = (tu: ToolUse, why: string): ToolResult => ({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: why })

/** Whether a reply wrote anything the asker can read. */
const hasText = (content: ContentBlockParam[]) => content.some((b) => b.type === 'text' && b.text.trim() !== '')

/** Store messages of this answer; returns them as they will be replayed. */
async function persist(qn: Question, messages: NewMessage[]): Promise<MessageParam[]> {
  const stored = await withTransaction(qn.db, (tx) => appendMessages(tx, qn.conversation.id, qn.turnId, messages))
  return stored.filter((_, i) => messages[i].inReplay !== false).map((s) => s.param)
}

/**
 * One run_sql call: checked, run in the sandbox, shown as a card, handed back
 * to the model. A Stop or the clock cancels the query itself, so the answer
 * ends at once rather than when the query would have.
 */
async function runToolUse(
  qn: Question,
  reader: pg.Pool | null,
  tu: ToolUse,
  queries: QueryRecord[],
  signal: AbortSignal,
  cause: () => Cause,
): Promise<ToolResult> {
  // A near-miss of the name (Run_SQL) is still the one tool.
  if (tu.name.toLowerCase() !== RUN_SQL_TOOL_NAME) {
    return { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: `Unknown tool "${tu.name}". The only tool is "${RUN_SQL_TOOL_NAME}".` }
  }
  const parsed = RunSqlInput.safeParse(tu.input)
  if (!parsed.success) {
    return { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: JSON.stringify({ INVALID_JSON: JSON.stringify(tu.input) }) }
  }
  const { purpose, sql } = parsed.data
  const queryId = randomUUID()
  qn.emit({ type: 'query_start', queryId, purpose, sql })
  const run = await runReadOnlyQuery(reader, sql, { maxRows: AI_PREVIEW_ROWS, timeoutMs: CHAT_QUERY_TIMEOUT_MS, timeZone: qn.config.FACTORY_TIMEZONE, signal })
  // Stopped through the signal (not a failure of its own that came first): the replay keeps why.
  if (!run.ok && run.error === AI_QUERY_STOPPED) run.error = INTERRUPTED[cause()].running
  const preview = previewOf(run)
  const record: QueryRecord = { id: queryId, toolUseId: tu.id, purpose, sql, ok: run.ok, error: run.error, ms: run.ms, ...preview }
  queries.push(record)
  qn.emit({ type: 'query_end', part: queryPart(record) })
  if (!run.ok) return { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: run.error ?? 'The query failed.' }
  return { type: 'tool_result', tool_use_id: tu.id, content: previewJson(preview) }
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
  owner: Pick<UsageRecord, 'userId' | 'conversationId' | 'turnId'>,
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
