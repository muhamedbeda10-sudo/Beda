// ============================================================================
// §20 — a stand-in for Anthropic in the tests. Each call to the model takes
// the next scripted reply and plays it as the SDK's stream would (the raw
// events, then thinking, text and tool calls as they complete, then the final
// message); every request it receives is kept, byte for byte, for the tests to
// compare. Nothing touches the network.
// ============================================================================

import Anthropic from '@anthropic-ai/sdk'
import { AI_MODEL } from '@qc/shared/ai'
import type { AiModelClient, KeyCheck, ModelMessage, ModelParams, ModelStream, ModelStreamEvent } from '../src/ai/model'

type Block = Anthropic.Beta.BetaContentBlock

export interface FakeUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } | null
  iterations?: Anthropic.Beta.BetaIterationsUsage | null
}

/** One scripted reply of the model. */
export interface FakeReply {
  content?: Block[]
  stopReason?: Anthropic.Beta.BetaStopReason
  stopDetails?: Anthropic.Beta.BetaRefusalStopDetails | null
  usage?: FakeUsage
  /** The model that served it (a fallback names another); the model asked for unless given. */
  model?: string
  /** Fail instead of finishing, after streaming the content. */
  error?: unknown
  /** The last block is cut off: only the first half of its text or tool input streams, it never completes, and the reply fails with `error` or waits to be stopped. */
  cutOff?: boolean
  /** Hold the reply (after streaming its content) until this settles: for Stop and "still answering". */
  hold?: Promise<unknown>
}

export interface FakeCall {
  apiKey: string
  /** The request as it would go on the wire. */
  body: string
  params: ModelParams
  /** The loop called the stream's abort() (not the asker's signal). */
  abortCalled: boolean
}

export const text = (t: string): Block => ({ type: 'text', text: t, citations: null }) as Block
export const thinking = (t: string, signature = `sig_${t.length}_${t.slice(0, 8).replace(/\W/g, '')}`): Block =>
  ({ type: 'thinking', thinking: t, signature }) as Block
export const runSql = (id: string, purpose: string, sql: string): Block => ({ type: 'tool_use', id, name: 'run_sql', input: { purpose, sql } }) as Block
export const fallback = (from: string, to: string): Block =>
  ({ type: 'fallback', from: { model: from }, to: { model: to }, trigger: { type: 'refusal', category: 'cyber' } }) as unknown as Block

/** A delta of one block, as the API streams it; null for a block that streams none. */
function deltaOf(block: Block, piece: string): Anthropic.Beta.BetaRawContentBlockDelta | null {
  if (block.type === 'text') return { type: 'text_delta', text: piece }
  if (block.type === 'thinking') return { type: 'thinking_delta', thinking: piece, estimated_tokens: null }
  if (block.type === 'tool_use') return { type: 'input_json_delta', partial_json: piece }
  return null
}

/** What a block streams: its text, its thinking, or its input as JSON. */
function streamedText(block: Block): string {
  if (block.type === 'text') return block.text
  if (block.type === 'thinking') return block.thinking
  if (block.type === 'tool_use') return JSON.stringify(block.input)
  return ''
}

/** The block as content_block_start carries it: no text, no input yet. */
function startOf(block: Block): Block {
  if (block.type === 'text') return { ...block, text: '' }
  if (block.type === 'thinking') return { ...block, thinking: '', signature: '' }
  if (block.type === 'tool_use') return { ...block, input: {} }
  return block
}

type Listeners = {
  streamEvent: ((e: ModelStreamEvent, snapshot: ModelMessage) => void)[]
  text: ((d: string, s: string) => void)[]
  thinking: ((d: string, s: string) => void)[]
  contentBlock: ((b: Block) => void)[]
}

class FakeStream implements ModelStream {
  currentMessage: ModelMessage | undefined
  readonly request_id: string
  private listeners: Listeners = { streamEvent: [], text: [], thinking: [], contentBlock: [] }
  private result: Promise<ModelMessage>
  /** The SDK's own controller: the caller's signal aborts it, and so does abort(). */
  private controller = new AbortController()

  constructor(reply: FakeReply, n: number, signal: AbortSignal, private readonly call: FakeCall) {
    this.request_id = `req_fake_${n}`
    if (signal.aborted) this.controller.abort()
    else signal.addEventListener('abort', () => this.controller.abort(), { once: true })
    this.result = this.play(reply, n, this.controller.signal)
    // finalMessage() may be read later; never an unhandled rejection meanwhile.
    this.result.catch(() => undefined)
  }

  on(event: keyof Listeners, listener: never): unknown {
    ;(this.listeners[event] as unknown[]).push(listener)
    return this
  }

  finalMessage(): Promise<ModelMessage> {
    return this.result
  }

  abort(): void {
    this.call.abortCalled = true
    this.controller.abort()
  }

  private event(e: ModelStreamEvent): void {
    for (const l of this.listeners.streamEvent) l(e, this.currentMessage!)
  }

  private async play(reply: FakeReply, n: number, signal: AbortSignal): Promise<ModelMessage> {
    const tick = () => new Promise((resolve) => setImmediate(resolve))
    const aborted = () => new Anthropic.APIUserAbortError()
    await tick()
    if (signal.aborted) throw aborted()
    const usage = {
      input_tokens: reply.usage?.input_tokens ?? 1000,
      // What message_start reports: a token or so.
      output_tokens: 1,
      cache_creation_input_tokens: reply.usage?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: reply.usage?.cache_read_input_tokens ?? 0,
      cache_creation: reply.usage?.cache_creation ?? null,
      iterations: null as Anthropic.Beta.BetaIterationsUsage | null,
    }
    const message = {
      id: `msg_fake_${n}`,
      type: 'message',
      role: 'assistant',
      // The model asked for serves, as the API names it, unless the reply says a fallback did.
      model: reply.model ?? (this.call.params.model || AI_MODEL),
      content: [] as Block[],
      stop_reason: null as Anthropic.Beta.BetaStopReason | null,
      stop_sequence: null,
      stop_details: null as Anthropic.Beta.BetaRefusalStopDetails | null,
      container: null,
      context_management: null,
      usage,
    } as unknown as ModelMessage
    this.currentMessage = message
    this.event({ type: 'message_start', message: { ...message, content: [] } } as ModelStreamEvent)

    const blocks = reply.content ?? []
    for (const [index, block] of blocks.entries()) {
      if (signal.aborted) throw aborted()
      const cut = reply.cutOff === true && index === blocks.length - 1
      this.event({ type: 'content_block_start', index, content_block: startOf(block) } as ModelStreamEvent)
      // Text and tool input in two pieces, as a stream would deliver them (thinking in one); a cut-off block only its first.
      const all = streamedText(block)
      const half = block.type === 'thinking' && !cut ? all.length : Math.ceil(all.length / 2)
      let snapshot = ''
      for (const piece of cut ? [all.slice(0, half)] : [all.slice(0, half), all.slice(half)]) {
        const delta = deltaOf(block, piece)
        if (!piece || !delta) continue
        snapshot += piece
        this.event({ type: 'content_block_delta', index, delta } as ModelStreamEvent)
        if (block.type === 'text') for (const l of this.listeners.text) l(piece, snapshot)
        if (block.type === 'thinking') for (const l of this.listeners.thinking) l(piece, snapshot)
        await tick()
        if (signal.aborted) throw aborted()
      }
      if (cut) break
      message.content.push(block)
      this.event({ type: 'content_block_stop', index } as ModelStreamEvent)
      for (const l of this.listeners.contentBlock) l(block)
    }
    // A cut-off reply that does not fail waits to be stopped, as a stalled stream would.
    const wait = reply.hold ?? (reply.cutOff && reply.error === undefined ? new Promise(() => undefined) : undefined)
    if (wait) {
      await Promise.race([
        wait,
        new Promise((resolve) => {
          if (signal.aborted) resolve(undefined)
          else signal.addEventListener('abort', () => resolve(undefined), { once: true })
        }),
      ])
    }
    if (signal.aborted) throw aborted()
    if (reply.error !== undefined) throw reply.error
    message.stop_reason = reply.stopReason ?? (message.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn')
    message.stop_details = reply.stopDetails ?? null
    Object.assign(usage, {
      output_tokens: reply.usage?.output_tokens ?? 200,
      iterations: reply.usage?.iterations ?? null,
    })
    this.event({ type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage } as unknown as ModelStreamEvent)
    this.event({ type: 'message_stop' } as ModelStreamEvent)
    return message
  }
}

/** The scripted model. Script replies with `reply()`; read what it was sent in `calls`. */
export class ScriptedModel implements AiModelClient {
  calls: FakeCall[] = []
  /** Keys it was asked to check. */
  checkedKeys: string[] = []
  /** How it answers a key check: accepted unless told otherwise. */
  keyCheck: (apiKey: string) => KeyCheck = () => ({ ok: true })
  /** What it was asked to count, as sent. */
  counted: { apiKey: string; model: string; messages: Anthropic.Beta.BetaMessageParam[] }[] = []
  /** How it counts: a flat figure per call unless told otherwise; throw to refuse a file. */
  tokenCount: (params: { model: string; messages: Anthropic.Beta.BetaMessageParam[] }) => number = () => 1500
  private queue: FakeReply[] = []

  reply(...replies: FakeReply[]): this {
    this.queue.push(...replies)
    return this
  }

  /** Replies scripted but not yet asked for. */
  get pending(): number {
    return this.queue.length
  }

  reset(): void {
    this.calls = []
    this.checkedKeys = []
    this.queue = []
    this.keyCheck = () => ({ ok: true })
    this.counted = []
    this.tokenCount = () => 1500
  }

  stream(apiKey: string, params: ModelParams, options: { signal: AbortSignal }): ModelStream {
    const body = JSON.stringify(params)
    const call: FakeCall = { apiKey, body, params: JSON.parse(body) as ModelParams, abortCalled: false }
    this.calls.push(call)
    const reply = this.queue.shift()
    if (!reply) throw new Error('The scripted model has no reply left for this call.')
    return new FakeStream(reply, this.calls.length, options.signal, call)
  }

  async verifyKey(apiKey: string): Promise<KeyCheck> {
    this.checkedKeys.push(apiKey)
    return this.keyCheck(apiKey)
  }

  async countTokens(apiKey: string, params: { model: string; messages: Anthropic.Beta.BetaMessageParam[] }): Promise<number> {
    this.counted.push({ apiKey, ...(JSON.parse(JSON.stringify(params)) as typeof params) })
    return this.tokenCount(params)
  }
}

/** An SDK error as the API would raise it, for the error paths. */
export function apiError(status: 401 | 400 | 429 | 500, message: string): InstanceType<typeof Anthropic.APIError> {
  const headers = new Headers({ 'request-id': 'req_fake_error' })
  const body = { type: 'error', error: { type: status === 401 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : status === 400 ? 'invalid_request_error' : 'api_error', message } }
  if (status === 401) return new Anthropic.AuthenticationError(401, body, message, headers)
  if (status === 400) return new Anthropic.BadRequestError(400, body, message, headers)
  if (status === 429) return new Anthropic.RateLimitError(429, body, message, headers)
  return new Anthropic.InternalServerError(500, body, message, headers)
}
