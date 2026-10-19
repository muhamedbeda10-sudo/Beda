import { describe, expect, it } from 'vitest'
import { AI_ROUTER_FALLBACK } from '@qc/shared/ai'
import { ROUTER_SYSTEM, chooseLevel, describeFiles, readRouterReply, routerRequest } from '../src/ai/router'
import type { ModelMessage } from '../src/ai/model'
import { ScriptedModel, text } from './aiFake'

// §20 — a chat question's level, standard (Sonnet) or deep (Opus), read by Sonnet before it is answered.

const message = (t: string) => ({ content: [text(t)] }) as unknown as ModelMessage

describe('§20 the router', () => {
  it('asks Sonnet, without thinking, in a fixed shape, with the files the question carries and the question before for a follow-up', () => {
    const first = routerRequest({ question: '  How many   coils were held?  ' })
    expect(first).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 300, system: ROUTER_SYSTEM, output_config: { format: { type: 'json_schema' } } })
    // Said outright: on Sonnet 5.5 a request silent about thinking thinks, and spends the reply's few tokens on it.
    expect(first.thinking).toEqual({ type: 'between_tools' })
    // Structured outputs are generally available: no beta header.
    expect(first).not.toHaveProperty('betas')
    expect(first.messages).toEqual([{ role: 'user', content: 'The question to sort:\nHow many coils were held?' }])
    const next = routerRequest({ question: 'And last month?', previous: { question: 'Trend of rejects by machine', level: 'chat-analysis' } })
    expect(next.messages[0].content).toBe('The question before it in this conversation (answered as analysis):\nTrend of rejects by machine\n\nThe question to sort:\nAnd last month?')
    const deep = routerRequest({ question: 'Why?', previous: { question: 'Root cause of the holds', level: 'chat-deep' } })
    expect(deep.messages[0].content).toMatch(/^The question before it in this conversation \(answered as deep analysis\):/)
    const withFiles = routerRequest({ question: 'What does this say?', files: ['image', 'pdf', 'image'] })
    expect(withFiles.messages[0].content).toBe('The question to sort:\nWhat does this say?\n\nIt carries 2 photos and a PDF.')
    expect(routerRequest({ question: '', files: ['sheet'] }).messages[0].content).toBe('The question to sort:\n(no words)\n\nIt carries a spreadsheet.')
    // A very long question: its start is enough, and the call stays cheap.
    expect(String(routerRequest({ question: 'x'.repeat(10_000) }).messages[0].content).length).toBeLessThan(2_100)
  })

  it('reads the level and why, and nothing else', () => {
    expect(readRouterReply(message('{"level":"deep","reason":"  Root cause\\nacross lines. "}'))).toEqual({ level: 'chat-deep', reason: 'Root cause across lines.' })
    expect(readRouterReply(message('{"level":"standard","reason":""}'))).toEqual({ level: 'chat-standard', reason: null })
    for (const bad of ['{"level":"simple","reason":"x"}', '{"level":"analysis","reason":"x"}', '{"level":"files","reason":"x"}', '{"reason":"x"}', 'deep', '']) expect(readRouterReply(message(bad)), bad).toBeNull()
  })

  it('never stands in the answer’s way: a failure or an unreadable reply is the standard level, with no reason', async () => {
    const model = new ScriptedModel()
    model.completeWith = () => '{"level":"deep","reason":"A root cause."}'
    expect(await chooseLevel({ model, apiKey: 'k', question: 'Why?' })).toMatchObject({ level: 'chat-deep', reason: 'A root cause.' })
    model.completeWith = () => 'not json'
    const unreadable = await chooseLevel({ model, apiKey: 'k', question: 'How many?' })
    expect(unreadable).toMatchObject({ level: AI_ROUTER_FALLBACK, reason: null })
    // Its call still came back, to be billed.
    expect(unreadable.message).not.toBeNull()
    model.completeWith = () => {
      throw new Error('overloaded')
    }
    expect(await chooseLevel({ model, apiKey: 'k', question: 'How many?' })).toEqual({ level: AI_ROUTER_FALLBACK, reason: null, message: null })
    // The asker gone: stopped with the rest.
    const gone = new AbortController()
    gone.abort()
    model.completeWith = () => '{"level":"deep","reason":"x"}'
    expect((await chooseLevel({ model, apiKey: 'k', question: 'Why?', signal: gone.signal })).message).toBeNull()
  })

  it('falls back, and says why in the log, when the reply ran out before it named a level', async () => {
    // What the router got on a hard question while it thought: all its tokens on thinking, no level written.
    const model = new ScriptedModel()
    model.complete = async () =>
      ({ content: [{ type: 'thinking', thinking: '', signature: 's' }], stop_reason: 'max_tokens', usage: { input_tokens: 400, output_tokens: 300 } }) as unknown as ModelMessage
    const warnings: string[] = []
    const warn = console.warn
    console.warn = (...a: unknown[]) => void warnings.push(a.join(' '))
    try {
      expect(await chooseLevel({ model, apiKey: 'k', question: 'Root cause of the welding defects this quarter?' })).toMatchObject({ level: AI_ROUTER_FALLBACK, reason: null })
    } finally {
      console.warn = warn
    }
    expect(warnings.join('\n')).toContain('stop: max_tokens')
  })

  it('names the files by kind', () => {
    expect(describeFiles(['pdf'])).toBe('a PDF')
    expect(describeFiles(['sheet', 'sheet', 'image', 'pdf'])).toBe('2 spreadsheets, a photo and a PDF')
  })
})
