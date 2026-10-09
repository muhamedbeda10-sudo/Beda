import { describe, expect, it } from 'vitest'
import { createSseParser, readSse, type SseEvent } from './sse'

const encoder = new TextEncoder()

/** A body that hands over the given byte slices one read at a time. */
function bodyOf(chunks: Uint8Array[]): { body: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let i = 0
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++])
      else controller.close()
    },
    cancel() {
      cancelled = true
    },
  })
  return { body, cancelled: () => cancelled }
}

/** Cuts bytes into pieces of `size`, so frames and characters split anywhere. */
function slices(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size))
  return out
}

async function collect(body: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
  const out: SseEvent[] = []
  for await (const e of readSse(body)) out.push(e)
  return out
}

describe('Server-Sent Events', () => {
  it('reads named events with JSON data, as the assistant sends them', async () => {
    const wire =
      'event: start\ndata: {"type":"start"}\n\n' +
      ': ping\n\n' +
      'event: text\ndata: {"type":"text","delta":"Hi"}\n\n' +
      'event: done\ndata: {"type":"done"}\n\n'
    const events = await collect(bodyOf([encoder.encode(wire)]).body)
    expect(events).toEqual([
      { event: 'start', data: '{"type":"start"}' },
      { event: 'text', data: '{"type":"text","delta":"Hi"}' },
      { event: 'done', data: '{"type":"done"}' },
    ])
  })

  it('reassembles frames and characters split across reads at any byte', async () => {
    const wire = 'event: text\ndata: {"delta":"كم عدد العيوب؟ ✓"}\n\nevent: text\ndata: {"delta":"second"}\n\n'
    const bytes = encoder.encode(wire)
    for (const size of [1, 2, 3, 5, 7, 64]) {
      const events = await collect(bodyOf(slices(bytes, size)).body)
      expect(events.map((e) => JSON.parse(e.data).delta)).toEqual(['كم عدد العيوب؟ ✓', 'second'])
    }
  })

  it('accepts \\r\\n and lone \\r line ends, even when a \\r\\n is split across reads', async () => {
    const crlf = await collect(bodyOf([encoder.encode('event: a\r'), encoder.encode('\ndata: 1\r\n\r'), encoder.encode('\n')]).body)
    expect(crlf).toEqual([{ event: 'a', data: '1' }])
    const cr = await collect(bodyOf([encoder.encode('event: b\rdata: 2\r\r')]).body)
    expect(cr).toEqual([{ event: 'b', data: '2' }])
  })

  it('joins several data lines with newlines and defaults the event name to message', () => {
    const p = createSseParser()
    expect(p.push('data: one\ndata:two\ndata\n\n')).toEqual([{ event: 'message', data: 'one\ntwo\n' }])
  })

  it('ignores comments, unknown fields and events without data', () => {
    const p = createSseParser()
    expect(p.push(': keep-alive\nid: 7\nretry: 100\nevent: lonely\n\nevent: real\ndata: x\n\n')).toEqual([{ event: 'real', data: 'x' }])
  })

  it('strips a byte-order mark and keeps only one leading space of a value', () => {
    const p = createSseParser()
    expect(p.push('﻿data:  two spaces\n\n')).toEqual([{ event: 'message', data: ' two spaces' }])
  })

  it('drops an event the stream ended before closing', async () => {
    const events = await collect(bodyOf([encoder.encode('event: a\ndata: 1\n\nevent: b\ndata: 2\n')]).body)
    expect(events).toEqual([{ event: 'a', data: '1' }])
  })

  it('cancels the stream when the reader stops early', async () => {
    const { body, cancelled } = bodyOf([encoder.encode('data: 1\n\n'), encoder.encode('data: 2\n\n'), encoder.encode('data: 3\n\n')])
    for await (const e of readSse(body)) {
      expect(e.data).toBe('1')
      break
    }
    expect(cancelled()).toBe(true)
  })
})
