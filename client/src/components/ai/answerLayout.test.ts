import { describe, expect, it } from 'vitest'
import type { AiQueryPart } from '@qc/shared/ai'
import type { AiAutomationPart } from '@qc/shared/automation'
import type { AiExcelPart } from '@qc/shared/aiExcel'
import type { AiDiagramPart } from '@qc/shared/aiDiagram'
import type { AiNoticePart } from '@qc/shared/noticeAssistant'
import { answerBlocks } from './answerLayout'
import type { LivePart, PendingQuery } from './liveTurn'

const q = (id: string): AiQueryPart => ({ type: 'query', queryId: id, purpose: id, sql: 'SELECT 1', ok: true, columns: ['n'], rows: [[1]], rowCount: 1, truncated: false, ms: 1 })
const running = (id: string): PendingQuery => ({ type: 'pending-query', queryId: id, purpose: id, sql: 'SELECT 1', state: 'running' })
const t = (text: string): LivePart => ({ type: 'text', text })
const a = (id: string): AiAutomationPart => ({ type: 'automation', proposalId: id, ok: true, state: 'proposed' })
const n = (id: string): AiNoticePart => ({ type: 'notice', proposalId: id, ok: true, action: 'create', state: 'proposed' })
const file = (id: string): AiExcelPart => ({ type: 'excel', fileId: id, fileName: 'Scrap', sheets: [{ name: 'Scrap', columns: ['Machine'], rows: 3 }], byteSize: 7000, expiresAt: '2026-11-12T08:30:00.000Z' })
const d = (id: string): AiDiagramPart => ({ type: 'diagram', diagramId: id, spec: { layout: 'flow', title: 'Flow', direction: 'across', rtl: false, groups: [], nodes: [], edges: [], sources: [] } })
const NONE = new Set<string>()
const shape = (blocks: ReturnType<typeof answerBlocks>) => blocks.map((b) => (b.kind === 'text' ? `text:${b.text}` : b.kind === 'figure' ? `figure:${b.queryId}` : b.kind === 'queries' ? `queries:${b.queries.map((x) => x.queryId).join(',')}` : b.kind === 'automation' ? `automation:${b.part.proposalId}` : b.kind === 'notice' ? `notice:${b.part.proposalId}` : b.kind === 'excel' ? `excel:${b.part.fileId}` : b.kind === 'diagram' ? `diagram:${b.part.diagramId}` : 'kpis'))

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

  it('keeps a proposed automation’s card in its place among the text, written and settled, out of the queries', () => {
    const parts = [t('Checking.'), q('q1'), t('Here is the watch.'), a('p1'), t('Press Activate.')]
    expect(shape(answerBlocks(parts, { settled: false, kpis: false, charted: NONE }))).toEqual(['text:Checking.', 'queries:q1', 'text:Here is the watch.', 'automation:p1', 'text:Press Activate.'])
    expect(shape(answerBlocks(parts, { settled: true, kpis: false, charted: NONE }))).toEqual(['text:Checking.', 'text:Here is the watch.', 'automation:p1', 'text:Press Activate.', 'queries:q1'])
    // Keyed by its proposal, the same written and settled.
    expect(answerBlocks(parts, { settled: true, kpis: false, charted: NONE }).find((b) => b.kind === 'automation')?.key).toBe('automation:p1')
    // A card after the last query is part of the answer itself: the figures head it.
    expect(shape(answerBlocks([q('q1'), a('p1'), t('Done.')], { settled: true, kpis: true, charted: NONE }))).toEqual(['kpis', 'automation:p1', 'text:Done.', 'queries:q1'])
  })

  it('keeps a notice card in its place among the text too, never starting the query group', () => {
    const parts = [t('Here is the notice.'), n('n1'), t('Press Publish.')]
    expect(shape(answerBlocks(parts, { settled: false, kpis: false, charted: NONE }))).toEqual(['text:Here is the notice.', 'notice:n1', 'text:Press Publish.'])
    const queried = [t('Checking the machines.'), q('q1'), n('n1')]
    expect(shape(answerBlocks(queried, { settled: false, kpis: false, charted: NONE }))).toEqual(['text:Checking the machines.', 'queries:q1', 'notice:n1'])
    expect(shape(answerBlocks(queried, { settled: true, kpis: false, charted: NONE }))).toEqual(['text:Checking the machines.', 'notice:n1', 'queries:q1'])
    expect(answerBlocks(parts, { settled: true, kpis: false, charted: NONE }).find((b) => b.kind === 'notice')?.key).toBe('notice:n1')
  })

  it('keeps an Excel file in its place among the text, written and settled, out of the queries', () => {
    const parts = [t('Checking the scrap.'), q('q1'), file('f1'), t('The file has one sheet.')]
    expect(shape(answerBlocks(parts, { settled: false, kpis: false, charted: NONE }))).toEqual(['text:Checking the scrap.', 'queries:q1', 'excel:f1', 'text:The file has one sheet.'])
    expect(shape(answerBlocks(parts, { settled: true, kpis: false, charted: NONE }))).toEqual(['text:Checking the scrap.', 'excel:f1', 'text:The file has one sheet.', 'queries:q1'])
    expect(answerBlocks(parts, { settled: true, kpis: false, charted: NONE }).find((b) => b.kind === 'excel')?.key).toBe('excel:f1')
  })

  it('keeps a diagram in its place among the text, written and settled, out of the queries', () => {
    const parts = [t('Checking the defects.'), q('q1'), d('d1'), t('Machine 58 stands out.')]
    expect(shape(answerBlocks(parts, { settled: false, kpis: false, charted: NONE }))).toEqual(['text:Checking the defects.', 'queries:q1', 'diagram:d1', 'text:Machine 58 stands out.'])
    expect(shape(answerBlocks(parts, { settled: true, kpis: false, charted: NONE }))).toEqual(['text:Checking the defects.', 'diagram:d1', 'text:Machine 58 stands out.', 'queries:q1'])
  })
})
