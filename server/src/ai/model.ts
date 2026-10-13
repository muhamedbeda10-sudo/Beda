// ============================================================================
// §20 — the one place the API talks to Anthropic. Routes and the answer loop
// see only this interface, so the tests hand in a scripted model and nothing
// ever leaves the machine there.
// ============================================================================

import { createHash } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { AI_MODEL } from '@qc/shared/ai'

export type ModelParams = BetaMessageStreamParams
export type ModelMessage = Anthropic.Beta.BetaMessage
export type ModelStreamEvent = Anthropic.Beta.BetaRawMessageStreamEvent
export type CompleteParams = Anthropic.Beta.MessageCreateParamsNonStreaming

/** What the answer loop reads from one streamed call: the SDK's BetaMessageStream, as much of it as is used. */
export interface ModelStream {
  /** Every event as it arrives, tool input deltas included. */
  on(event: 'streamEvent', listener: (event: ModelStreamEvent, snapshot: ModelMessage) => void): unknown
  on(event: 'text' | 'thinking', listener: (delta: string, snapshot: string) => void): unknown
  on(event: 'contentBlock', listener: (block: Anthropic.Beta.BetaContentBlock) => void): unknown
  /** The whole message once the call ends; rejects on an error or an abort. */
  finalMessage(): Promise<ModelMessage>
  /** Stop reading the response. A stream that failed (unparseable tool input, say) otherwise reads on, unseen. */
  abort(): void
  /** The message as far as it has streamed — its usage when a call is cut off. */
  readonly currentMessage: ModelMessage | undefined
  readonly request_id?: string | null
}

/** How Anthropic answered a key that is being set. */
export type KeyCheck =
  | { ok: true }
  /** Refused (401/403), or the key cannot use the assistant's model (404). */
  | { ok: false; reason: 'refused' | 'no-model' }
  /** Anthropic could not be asked: network, timeout, overload. */
  | { ok: false; reason: 'unreachable' }

export interface AiModelClient {
  stream(apiKey: string, params: ModelParams, options: { signal: AbortSignal }): ModelStream
  /** One short call, not streamed, for the app's own small requests (a conversation's title): the whole message. */
  complete(apiKey: string, params: CompleteParams, options: { signal: AbortSignal }): Promise<ModelMessage>
  /** Ask Anthropic whether the key works, before it is saved. */
  verifyKey(apiKey: string): Promise<KeyCheck>
  /**
   * What these messages come to in input tokens on the model: Anthropic's own
   * count (free). It reads the files in them too, so a file Claude cannot read
   * is refused here (a BadRequestError).
   */
  countTokens(apiKey: string, params: { model: string; messages: Anthropic.Beta.BetaMessageParam[] }): Promise<number>
}

/** How long checking a key may take. */
const VERIFY_TIMEOUT_MS = 15_000
/** How long one of the app's small calls may take. */
const COMPLETE_TIMEOUT_MS = 20_000
/** How long counting a file may take: Anthropic reads a whole PDF to count it. */
const COUNT_TIMEOUT_MS = 60_000

/** The real thing: the Anthropic SDK, one client per key. */
export class AnthropicModelClient implements AiModelClient {
  private clients = new Map<string, Anthropic>()

  private client(apiKey: string): Anthropic {
    // Keyed by a fingerprint, so the map never holds the key as a key.
    const fingerprint = createHash('sha256').update(apiKey).digest('hex')
    let client = this.clients.get(fingerprint)
    if (!client) {
      // A replaced key leaves its client behind; a handful is plenty.
      if (this.clients.size >= 4) this.clients.clear()
      client = new Anthropic({
        apiKey,
        // Never also send a token from the server's environment: both together are refused.
        authToken: null,
        maxRetries: 2,
        timeout: 5 * 60_000,
        // Requests are not logged; when they are, the SDK redacts the key.
        logLevel: 'warn',
      })
      this.clients.set(fingerprint, client)
    }
    return client
  }

  stream(apiKey: string, params: ModelParams, options: { signal: AbortSignal }): ModelStream {
    return this.client(apiKey).beta.messages.stream(params, { signal: options.signal })
  }

  complete(apiKey: string, params: CompleteParams, options: { signal: AbortSignal }): Promise<ModelMessage> {
    return this.client(apiKey).beta.messages.create(params, { signal: options.signal, timeout: COMPLETE_TIMEOUT_MS, maxRetries: 1 })
  }

  async countTokens(apiKey: string, params: { model: string; messages: Anthropic.Beta.BetaMessageParam[] }): Promise<number> {
    const counted = await this.client(apiKey).beta.messages.countTokens(params, { timeout: COUNT_TIMEOUT_MS, maxRetries: 1 })
    return counted.input_tokens
  }

  async verifyKey(apiKey: string): Promise<KeyCheck> {
    try {
      await this.client(apiKey).models.retrieve(AI_MODEL, {}, { timeout: VERIFY_TIMEOUT_MS, maxRetries: 1 })
      return { ok: true }
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return { ok: false, reason: 'refused' }
      if (e instanceof Anthropic.NotFoundError) return { ok: false, reason: 'no-model' }
      // The message only: an error's request details are never logged.
      console.warn('[ai] could not check an API key with Anthropic:', e instanceof Error ? e.message : String(e))
      return { ok: false, reason: 'unreachable' }
    }
  }
}
