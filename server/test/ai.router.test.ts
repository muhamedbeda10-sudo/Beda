import { describe, expect, it } from 'vitest'
import { AI_ROUTER_FALLBACK, AI_ROUTER_MODEL } from '@qc/shared/ai'
import { ROUTER_SYSTEM, chooseLevel, readRouterReply, routerRequest } from '../src/ai/router'
import type { ModelMessage } from '../src/ai/model'
import { ScriptedModel, text } from './aiFake'

// §20 — a chat question's level (Auto), read by the cheapest model before it is answered.

const message = (t: string) => ({ content: [text(t)] }) as unknown as ModelMessage

describe('§20 the router', () => {
  it('asks the cheapest model, in a fixed shape, with the question before for a follow-up', () => {
    const first = routerRequest({ question: '  How many   coils were held?  ' })
    expect(first).toMatchObject({ model: AI_ROUTER_MODEL, max_tokens: 200, system: ROUTER_SYSTEM, output_config: { format: { type: 'json_schema' } } })
    expect(first.messages).toEqual([{ role: 'user', content: 'The question to sort:\nHow many coils were held?' }])
    const next = routerRequest({ question: 'And last month?', previous: { question: 'Trend of rejects by machine', level: 'chat-analysis' } })
    expect(next.messages[0].content).toBe('The question before it in this conversation (answered as analysis):\nTrend of rejects by machine\n\nThe question to sort:\nAnd last month?')
    // A very long question: its start is enough, and the call stays cheap.
    expect(String(routerRequest({ question: 'x'.repeat(10_000) }).messages[0].content).length).toBeLessThan(2_100)
  })

  it('reads the level and why, and nothing else', () => {
    expect(readRouterReply(message('{"level":"deep","reason":"  Root cause\\nacross lines. "}'))).toEqual({ level: 'chat-deep', reason: 'Root cause across lines.' })
    expect(readRouterReply(message('{"level":"simple","reason":""}'))).toEqual({ level: 'chat-simple', reason: null })
    for (const bad of ['{"level":"files","reason":"x"}', '{"reason":"x"}', 'deep', '']) expect(readRouterReply(message(bad)), bad).toBeNull()
  })

  it('never stands in the answer’s way: a failure or an unreadable reply is the middle level, with no reason', async () => {
    const model = new ScriptedModel()
    model.completeWith = () => '{"level":"simple","reason":"One count."}'
    expect(await chooseLevel({ model, apiKey: 'k', question: 'How many?' })).toMatchObject({ level: 'chat-simple', reason: 'One count.' })
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
})
