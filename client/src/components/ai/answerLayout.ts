// ============================================================================
// §20 — how an answer is laid out. While it is written, it reads in the
// order it comes: a word on what is being checked, the queries as they run
// (one open group, so the progress is in view), then the answer's text. Once
// it has ended it reads as a finished piece: the text, its headline figures
// above the part written after the queries, the charts the queries asked for
// with their tables, and at the end, folded away, "How I got this" — the
// queries themselves. Each block keeps its key from one to the other, so the
// query group (and the cards in it) moves rather than being drawn anew.
// ============================================================================

import type { LivePart } from './liveTurn'

type QueryLike = Exclude<LivePart, { type: 'text' }>

export type AnswerBlock =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'kpis'; key: 'kpis' }
  | { kind: 'figure'; key: string; queryId: string }
  | { kind: 'queries'; key: 'queries'; queries: QueryLike[] }

const QUERIES = 'queries' as const
const KPIS = 'kpis' as const

/**
 * The blocks of an answer. `settled`: it has ended (finished, stopped or
 * failed). `kpis`: it has headline figures to show. `charted`: the queries
 * whose chart can be drawn — given a figure of their own once it has ended.
 */
export function answerBlocks(parts: readonly LivePart[], opts: { settled: boolean; kpis: boolean; charted: ReadonlySet<string> }): AnswerBlock[] {
  const queries = parts.filter((p): p is QueryLike => p.type !== 'text')
  const lastQuery = parts.reduce((at, p, i) => (p.type !== 'text' ? i : at), -1)
  // Text blocks are keyed by their place among the texts, which the queries between them do not change.
  let textIndex = 0
  const text = (p: Extract<LivePart, { type: 'text' }>): AnswerBlock => ({ kind: 'text', key: `text:${textIndex++}`, text: p.text })

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
      if (p.type === 'text') {
        // The figures head the text written after the last query (the answer itself).
        if (i > lastQuery) placeKpis()
        blocks.push(text(p))
      } else if (!grouped) {
        grouped = true
        blocks.push({ kind: QUERIES, key: QUERIES, queries })
      }
    })
    placeKpis()
    return blocks
  }

  parts.forEach((p, i) => {
    if (p.type !== 'text') return
    if (i > lastQuery) placeKpis()
    blocks.push(text(p))
  })
  placeKpis()
  for (const q of queries) if (q.type === 'query' && opts.charted.has(q.queryId)) blocks.push({ kind: 'figure', key: `figure:${q.queryId}`, queryId: q.queryId })
  if (queries.length > 0) blocks.push({ kind: QUERIES, key: QUERIES, queries })
  return blocks
}
