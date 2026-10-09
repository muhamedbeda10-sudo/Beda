import { describe, expect, it } from 'vitest'
import type { AiQueryPart } from '@qc/shared/ai'
import { answerBlocks } from './answerLayout'
import type { LivePart, PendingQuery } from './liveTurn'

const q = (id: string): AiQueryPart => ({ type: 'query', queryId: id, purpose: id, sql: 'SELECT 1', ok: true, columns: ['n'], rows: [[1]], rowCount: 1, truncated: false, ms: 1 })
const running = (id: string): PendingQuery => ({ type: 'pending-query', queryId: id, purpose: id, sql: 'SELECT 1', state: 'running' })
const t = (text: string): LivePart => ({ type: 'text', text })
const NONE = new Set<string>()
const shape = (blocks: ReturnType<typeof answerBlocks>) => blocks.map((b) => (b.kind === 'text' ? `text:${b.text}` : b.kind === 'figure' ? `figure:${b.queryId}` : b.kind === 'queries' ? `queries:${b.queries.map((x) => x.queryId).join(',')}` : 'kpis'))

describe('the layout of an answer', () => {
  it('reads in the order it comes while it is written: the queries as one open group where the first ran', () => {
    const parts = [t('Checking.'), q('q1'), t('Now holds.'), running('q2')]
    expect(shape(answerBlocks(parts, { settled: false, kpis: false, charted: NONE }))).toEqual(['text:Checking.', 'queries:q1,q2', 'text:Now holds.'])
  })

  it('puts the headline figures before the text written after the last query, or at the end until it comes', () => {
    const before = [t('Checking.'), q('q1')]
    expect(shape(answerBlocks(before, { settled: false, kpis: true, charted: NONE }))).toEqual(['text:Checking.', 'queries:q1', 'kpis'])
    const after = [t('Checking.'), q('q1'), t('39 pieces.')]
    expect(shape(answerBlocks(after, { settled: false, kpis: true, charted: NONE }))).toEqual(['text:Checking.', 'queries:q1', 'kpis', 'text:39 pieces.'])
    expect(shape(answerBlocks([t('Only words.')], { settled: false, kpis: true, charted: NONE }))).toEqual(['kpis', 'text:Only words.'])
  })

  it('settles once ended: the text with its figures, the charts asked for, then the queries folded at the end', () => {
    const parts = [t('Checking.'), q('q1'), q('q2'), t('39 pieces.'), t('Details.')]
    expect(shape(answerBlocks(parts, { settled: true, kpis: true, charted: new Set(['q2']) }))).toEqual(['text:Checking.', 'kpis', 'text:39 pieces.', 'text:Details.', 'figure:q2', 'queries:q1,q2'])
    expect(shape(answerBlocks(parts, { settled: true, kpis: false, charted: NONE }))).toEqual(['text:Checking.', 'text:39 pieces.', 'text:Details.', 'queries:q1,q2'])
  })

  it('gives each block the same key written and settled, so the query group moves rather than being drawn anew', () => {
    const parts = [t('Checking.'), q('q1'), t('39 pieces.')]
    const keys = (settled: boolean) => answerBlocks(parts, { settled, kpis: true, charted: new Set(['q1']) }).map((b) => b.key)
    expect(keys(false)).toEqual(['text:0', 'queries', 'kpis', 'text:1'])
    expect(keys(true)).toEqual(['text:0', 'kpis', 'text:1', 'figure:q1', 'queries'])
  })

  it('draws an answer without queries as its text alone', () => {
    expect(shape(answerBlocks([t('Hello.')], { settled: true, kpis: false, charted: NONE }))).toEqual(['text:Hello.'])
    expect(answerBlocks([], { settled: false, kpis: false, charted: NONE })).toEqual([])
  })
})
