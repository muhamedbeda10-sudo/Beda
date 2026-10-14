import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiStreamEvent } from '@qc/shared/ai'
import { watchStream } from '../src/ai/assistant'
import type { ModelStream, ModelStreamEvent } from '../src/ai/model'
import { checkingLine, writingLine } from '../src/ai/toolProgress'

afterEach(() => {
  vi.useRealTimers()
})

/** A stream whose raw events the test sends one at a time. */
function fakeStream() {
  const listeners: ((event: ModelStreamEvent) => void)[] = []
  const stream = {
    on(event: string, listener: (event: ModelStreamEvent) => void) {
      if (event === 'streamEvent') listeners.push(listener)
      return stream
    },
  } as unknown as ModelStream
  return { stream, send: (event: unknown) => listeners.forEach((l) => l(event as ModelStreamEvent)) }
}

describe('the line while a tool is written or checked', () => {
  it('says what is being written, with its seconds once it takes a while, and what the app then checks', () => {
    expect(writingLine('propose_automation', 0)).toBe('Writing the automation…')
    expect(writingLine('propose_automation', 4.9)).toBe('Writing the automation…')
    expect(writingLine('propose_automation', 41.2)).toBe('Writing the automation… 41 s')
    expect(writingLine('a_tool_added_later', 0)).toBe('Preparing the next step…')
    expect(checkingLine(['propose_automation', 'propose_automation', 'update_playbook'])).toBe('Checking the automation and running it once…')
    expect(checkingLine(['update_playbook'])).toBe('Saving to the playbook…')
    // A query's own card says it runs; nothing to say for no tools.
    expect(checkingLine(['run_sql', 'propose_automation'])).toBeNull()
    expect(checkingLine([])).toBeNull()
    expect(checkingLine(['a_tool_added_later'])).toBe('Working on it…')
  })

  it('is sent as a tool input begins and about every second while it is written, never for text', () => {
    vi.useFakeTimers({ now: new Date('2026-10-14T08:00:00Z') })
    const events: AiStreamEvent[] = []
    const { stream, send } = fakeStream()
    watchStream(stream, (e) => events.push(e))
    send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I am adding it.' } })
    send({ type: 'content_block_stop', index: 0 })
    expect(events).toEqual([])
    send({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'propose_automation', input: {} } })
    expect(events).toEqual([{ type: 'progress', text: 'Writing the automation…' }])
    vi.advanceTimersByTime(400)
    send({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"kind":' } })
    expect(events).toHaveLength(1)
    vi.advanceTimersByTime(7_000)
    send({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"report"' } })
    expect(events.at(-1)).toEqual({ type: 'progress', text: 'Writing the automation… 7 s' })
    send({ type: 'content_block_stop', index: 1 })
    vi.advanceTimersByTime(5_000)
    send({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '}' } })
    expect(events).toHaveLength(2)
  })
})
