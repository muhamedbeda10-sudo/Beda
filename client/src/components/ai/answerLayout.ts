// ============================================================================
// §20 — how an answer is laid out. While it is written, it reads in the
// order it comes: a word on what is being checked, the queries as they run
// (one open group, so the progress is in view), then the answer's text. Once
// it has ended it reads as a finished piece: the text, its headline figures
// above the part written after the queries, the charts the queries asked for
// with their tables, and at the end, folded away, "How I got this" — the
// queries themselves. Each block keeps its key from one to the other, so the
// query group (and the cards in it) moves rather than being drawn anew.
//
// An automation the assistant proposed (§21), a notice card (§23) or a task
// card is a card of its own, in its place among the text, written or settled: it is
// what the answer is for.
// ============================================================================

import type { AiTaskPart } from '@qc/shared/ai'
import type { AiAutomationPart } from '@qc/shared/automation'
import type { AiNoticePart } from '@qc/shared/noticeAssistant'
import type { LivePart } from './liveTurn'

type QueryLike = Extract<LivePart, { type: 'query' | 'pending-query' }>

const isQuery = (p: LivePart): p is QueryLike => p.type === 'query' || p.type === 'pending-query'

type InlinePart = Extract<LivePart, { type: 'text' | 'automation' | 'notice' | 'task' }>

/** What reads in its place among the text: the text itself and the cards. */
const isInline = (p: LivePart): p is InlinePart => p.type === 'text' || p.type === 'automation' || p.type === 'notice' || p.type === 'task'

export type AnswerBlock =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'kpis'; key: 'kpis' }
  | { kind: 'figure'; key: string; queryId: string }
  | { kind: 'queries'; key: 'queries'; queries: QueryLike[] }
  | { kind: 'automation'; key: string; part: AiAutomationPart }
  | { kind: 'notice'; key: string; part: AiNoticePart }
  | { kind: 'task'; key: string; part: AiTaskPart }

const QUERIES = 'queries' as const
const KPIS = 'kpis' as const

/**
 * The blocks of an answer. `settled`: it has ended (finished, stopped or
 * failed). `kpis`: it has headline figures to show. `charted`: the queries
 * whose chart can be drawn — given a figure of their own once it has ended.
 */
export function answerBlocks(parts: readonly LivePart[], opts: { settled: boolean; kpis: boolean; charted: ReadonlySet<string> }): AnswerBlock[] {
  const queries = parts.filter(isQuery)
  const lastQuery = parts.reduce((at, p, i) => (isQuery(p) ? i : at), -1)
  // Text blocks are keyed by their place among the texts, which the queries between them do not change.
  let textIndex = 0
  const text = (p: Extract<LivePart, { type: 'text' }>): AnswerBlock => ({ kind: 'text', key: `text:${textIndex++}`, text: p.text })
  const automation = (p: AiAutomationPart): AnswerBlock => ({ kind: 'automation', key: `automation:${p.proposalId}`, part: p })
  const notice = (p: AiNoticePart): AnswerBlock => ({ kind: 'notice', key: `notice:${p.proposalId}`, part: p })
  const task = (p: AiTaskPart): AnswerBlock => ({ kind: 'task', key: `task:${p.proposalId}`, part: p })
  const inline = (p: InlinePart): AnswerBlock => (p.type === 'text' ? text(p) : p.type === 'automation' ? automation(p) : p.type === 'notice' ? notice(p) : task(p))

  const blocks: AnswerBlock[] = []
  let kpisPlaced = !opts.kpis
  const placeKpis = () => {
    if (kpisPlaced) return
    blocks.push({ kind: KPIS, key: KPIS })
    kpisPlaced = true
  }

  if (!opts.settled) {
    let grouped = false
    parts.forEach((p, i) => {
      if (isInline(p)) {
        // The figures head what was written after the last query (the answer itself).
        if (i > lastQuery) placeKpis()
        blocks.push(inline(p))
      } else if (!grouped) {
        grouped = true
        blocks.push({ kind: QUERIES, key: QUERIES, queries })
      }
    })
    placeKpis()
    return blocks
  }

  parts.forEach((p, i) => {
    if (!isInline(p)) return
    if (i > lastQuery) placeKpis()
    blocks.push(inline(p))
  })
  placeKpis()
  for (const q of queries) if (q.type === 'query' && opts.charted.has(q.queryId)) blocks.push({ kind: 'figure', key: `figure:${q.queryId}`, queryId: q.queryId })
  if (queries.length > 0) blocks.push({ kind: QUERIES, key: QUERIES, queries })
  return blocks
}
