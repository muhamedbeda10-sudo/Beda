// ============================================================================
// §20 — a stand-in for Anthropic in the tests. Each call to the model takes
// the next scripted reply and plays it as the SDK's stream would (thinking,
// text, tool calls, then the final message); every request it receives is
// kept, byte for byte, for the tests to compare. Nothing touches the network.
// ============================================================================

import Anthropic from '@anthropic-ai/sdk'
import { AI_MODEL } from '@qc/shared/ai'
import type { AiModelClient, KeyCheck, ModelMessage, ModelParams, ModelStream } from '../src/ai/model'

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
  /** The model that served it (a fallback names another). */
  model?: string
  /** Fail instead of finishing, after streaming the content's text. */
  error?: unknown
  /** Hold the reply (after streaming its content) until this settles: for Stop and "still answering". */
  hold?: Promise<unknown>
}

export interface FakeCall {
  apiKey: string
  /** The request as it would go on the wire. */
  body: string
  params: ModelParams
}

export const text = (t: string): Block => ({ type: 'text', text: t, citations: null }) as Block
export const thinking = (t: string, signature = `sig_${t.length}_${t.slice(0, 8).replace(/\W/g, '')}`): Block =>
  ({ type: 'thinking', thinking: t, signature }) as Block
export const runSql = (id: string, purpose: string, sql: string): Block => ({ type: 'tool_use', id, name: 'run_sql', input: { purpose, sql } }) as Block
export const fallback = (from: string, to: string): Block =>
  ({ type: 'fallback', from: { model: from }, to: { model: to }, trigger: { type: 'refusal', category: 'cyber' } }) as unknown as Block

class FakeStream implements ModelStream {
  currentMessage: ModelMessage | undefined
  readonly request_id: string
  private listeners: { text: ((d: string, s: string) => void)[]; thinking: ((d: string, s: string) => void)[]; contentBlock: ((b: Block) => void)[] } = {
    text: [],
    thinking: [],
    contentBlock: [],
  }
  private result: Promise<ModelMessage>

  constructor(reply: FakeReply, n: number, signal: AbortSignal) {
    this.request_id = `req_fake_${n}`
    this.result = this.play(reply, n, signal)
    // finalMessage() may be read later; never an unhandled rejection meanwhile.
    this.result.catch(() => undefined)
  }

  on(event: 'text' | 'thinking' | 'contentBlock', listener: never): unknown {
    ;(this.listeners[event] as unknown[]).push(listener)
    return this
  }

  finalMessage(): Promise<ModelMessage> {
    return this.result
  }

  private async play(reply: FakeReply, n: number, signal: AbortSignal): Promise<ModelMessage> {
    const tick = () => new Promise((resolve) => setImmediate(resolve))
    const aborted = () => new Anthropic.APIUserAbortError()
    await tick()
    if (signal.aborted) throw aborted()
    const usage = {
      input_tokens: reply.usage?.input_tokens ?? 1000,
      output_tokens: 0,
      cache_creation_input_tokens: reply.usage?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: reply.usage?.cache_read_input_tokens ?? 0,
      cache_creation: reply.usage?.cache_creation ?? null,
      iterations: null as Anthropic.Beta.BetaIterationsUsage | null,
    }
    const message = {
      id: `msg_fake_${n}`,
      type: 'message',
      role: 'assistant',
      model: reply.model ?? AI_MODEL,
      content: [] as Block[],
      stop_reason: null as Anthropic.Beta.BetaStopReason | null,
      stop_sequence: null,
      stop_details: null as Anthropic.Beta.BetaRefusalStopDetails | null,
      container: null,
      context_management: null,
      usage,
    } as unknown as ModelMessage
    this.currentMessage = message

    for (const block of reply.content ?? []) {
      if (signal.aborted) throw aborted()
      if (block.type === 'text') {
        // In two pieces, as a stream would deliver it.
        const half = Math.ceil(block.text.length / 2)
        let snapshot = ''
        for (const piece of [block.text.slice(0, half), block.text.slice(half)]) {
          if (!piece) continue
          snapshot += piece
          for (const l of this.listeners.text) l(piece, snapshot)
          await tick()
        }
      } else if (block.type === 'thinking') {
        for (const l of this.listeners.thinking) l(block.thinking, block.thinking)
        await tick()
      }
      message.content.push(block)
      for (const l of this.listeners.contentBlock) l(block)
    }
    if (reply.hold) {
      await Promise.race([
        reply.hold,
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
  }

  stream(apiKey: string, params: ModelParams, options: { signal: AbortSignal }): ModelStream {
    const body = JSON.stringify(params)
    this.calls.push({ apiKey, body, params: JSON.parse(body) as ModelParams })
    const reply = this.queue.shift()
    if (!reply) throw new Error('The scripted model has no reply left for this call.')
    return new FakeStream(reply, this.calls.length, options.signal)
  }

  async verifyKey(apiKey: string): Promise<KeyCheck> {
    this.checkedKeys.push(apiKey)
    return this.keyCheck(apiKey)
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
