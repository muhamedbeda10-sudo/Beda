// ============================================================================
// Server-Sent Events over fetch. EventSource can neither POST nor send the
// bearer token, so a streamed answer (§20, the AI assistant) is read from a
// fetch body instead: the bytes are cut into events as they arrive, whatever
// size the network hands them over in — half an event, half a character.
//
// The body is read with getReader(), not `for await` over the stream: the
// client's TypeScript lib has no async iterator on ReadableStream, and older
// iPad Safari has none either.
// ============================================================================

export interface SseEvent {
  /** The `event:` field; `message` when the server named none. */
  event: string
  /** The `data:` lines, joined by newlines. */
  data: string
}

export interface SseParser {
  /** Feeds decoded text; returns the events it completed. */
  push(text: string): SseEvent[]
  /** The stream ended: completes a line its last carriage return ended. An event not closed by a blank line is dropped, as the standard says. */
  end(): SseEvent[]
}

/** The wire format, parsed incrementally (the WHATWG rules: \n, \r\n or \r end a line; `:` starts a comment). */
export function createSseParser(): SseParser {
  let buf = ''
  let started = false
  let event = ''
  let data: string[] = []
  const out: SseEvent[] = []

  const line = (l: string) => {
    if (l === '') {
      // A blank line dispatches what was gathered; an event with no data is no event.
      if (data.length > 0) out.push({ event: event || 'message', data: data.join('\n') })
      event = ''
      data = []
      return
    }
    // A comment: the server's keep-alive ping.
    if (l.startsWith(':')) return
    const colon = l.indexOf(':')
    const field = colon < 0 ? l : l.slice(0, colon)
    let value = colon < 0 ? '' : l.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
    // `id` and `retry` are not used: an answer is never resumed.
  }

  const push = (text: string): SseEvent[] => {
    if (!started && text.length > 0) {
      started = true
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    }
    buf += text
    let start = 0
    for (let i = 0; i < buf.length; i++) {
      const c = buf[i]
      if (c !== '\n' && c !== '\r') continue
      // A carriage return at the very end may be the first half of \r\n: wait for the next piece.
      if (c === '\r' && i === buf.length - 1) break
      line(buf.slice(start, i))
      if (c === '\r' && buf[i + 1] === '\n') i++
      start = i + 1
    }
    buf = buf.slice(start)
    return out.splice(0)
  }

  return {
    push,
    end: () => (buf.endsWith('\r') ? push('\n') : out.splice(0)),
  }
}

/**
 * The events of a streamed body, in order. Leaving the loop early (a break,
 * a throw) cancels the stream, which closes the connection; an abort of the
 * fetch's signal surfaces here as the AbortError the read rejects with.
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent, void, undefined> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const parser = createSseParser()
  let finished = false
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      yield* parser.push(decoder.decode(value, { stream: true }))
    }
    finished = true
    yield* parser.push(decoder.decode())
    yield* parser.end()
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined)
    try {
      reader.releaseLock()
    } catch {
      /* a read still pending in an old browser: the cancel above ends it */
    }
  }
}
