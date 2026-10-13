import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query'
import type { AiActivityItem, AiActivityResponse } from '@qc/shared/ai'
import { keys } from '@/services/queries'
import { AiActivitySection } from './AiActivitySection'
import { aiModelName, formatAnswerCost, utcMonth } from './format'

// §20 — the owner's Activity: each question word for word with who asked, when, the model, the look-ups and the cost.

const consoleError = console.error
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...rest: unknown[]) => {
    if (String(message).includes('useLayoutEffect does nothing on the server')) return
    consoleError(message, ...rest)
  })
})
afterAll(() => vi.restoreAllMocks())

const item = (over: Partial<AiActivityItem>): AiActivityItem => ({
  id: 't1',
  kind: 'question',
  at: '2026-10-13T09:48:00.000Z',
  userId: 'u1',
  userName: 'Muhamed Beda',
  text: 'How many coils were held yesterday?',
  costUsd: 0.07,
  models: ['claude-sonnet-5-5'],
  lookups: 2,
  partial: false,
  stopReason: 'end_turn',
  ...over,
})

function html(items: AiActivityItem[], next: string | null = null): string {
  const qc = new QueryClient()
  const data: InfiniteData<AiActivityResponse> = {
    pages: [{ month: utcMonth(0), items, next, people: [{ id: 'u1', name: 'Muhamed Beda' }, { id: 'u2', name: 'Ahmed Rajab' }] }],
    pageParams: [null],
  }
  qc.setQueryData(keys.aiActivity(utcMonth(0), '', ''), data)
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AiActivitySection enabled />
    </QueryClientProvider>,
  )
}

describe('the owner’s Activity', () => {
  it('writes an answer’s cost to a tenth of a cent, and a model as people name it', () => {
    expect(formatAnswerCost(0.07)).toBe('$0.070')
    expect(formatAnswerCost(0.1804)).toBe('$0.180')
    expect(formatAnswerCost(0)).toBe('$0.000')
    expect(formatAnswerCost(0.0004)).toBe('$0.0004')
    expect(aiModelName('claude-sonnet-5-5')).toBe('Claude Sonnet 5.5')
    expect(aiModelName('claude-sonnet-5')).toBe('claude-sonnet-5')
  })

  it('lists each question with who asked, the model, the look-ups and the cost; a summary under its automation', () => {
    const h = html([
      item({}),
      item({ id: 't2', text: 'مش توتال التانكات 960 ف الخطة', lookups: 1, costUsd: 0.18, stopReason: 'stopped' }),
      item({ id: '7', kind: 'automation', text: 'Daily production report', userName: 'Ahmed Rajab', lookups: 0, stopReason: null, partial: true }),
    ], 'next-page')
    expect(h).toContain('How many coils were held yesterday?')
    expect(h).toContain('Muhamed Beda')
    expect(h).toContain('Claude Sonnet 5.5')
    expect(h).toContain('2 look-ups')
    expect(h).toContain('1 look-up')
    expect(h).toContain('$0.070')
    expect(h).toContain('$0.180')
    expect(h).toContain('· stopped')
    expect(h).toContain('dir="rtl"')
    expect(h).toContain('Automation:')
    expect(h).toContain('Daily production report')
    expect(h).toContain('estimated')
    // A summary is never "answering": it has no stop reason of its own.
    expect(h).not.toContain('answering…')
    // The people for the filter, and more to load.
    expect(h).toContain('Ahmed Rajab</option>')
    expect(h).toContain('Load more')
  })

  it('says so when nobody asked anything', () => {
    expect(html([])).toContain('Nobody asked the assistant anything in')
  })
})
