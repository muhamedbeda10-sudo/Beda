// ============================================================================
// §20 — an answer's headline figures. The model may open its answer with a
// block
//
//     <kpis>
//     - Defect pieces | 39
//     - Reject rate | 1.29% | down-good
//     </kpis>
//
// a figure a line: its label, its value as the model wrote it, and how it
// moved (up-good, up-bad, down-good, down-bad, flat). The server takes the
// block out of the saved answer and hands the figures over as
// `AiMessage.kpis` (server/src/ai/kpis.ts), and that copy is the one drawn
// once the answer is done. While it is still being written the block
// arrives as text like any other: the thread hides it (./blocks, from its
// first characters, never flashing the tag) and reads the figures here by
// the server's own rules, so the cards drawn as soon as the block is whole
// are the cards the saved answer keeps.
// ============================================================================

import { AI_KPI_TRENDS, type AiKpi, type AiKpiTrend } from '@qc/shared/ai'
import { cutChars, lastBlockBody, type TaggedBlock } from './blocks'
import type { LivePart } from './liveTurn'

/** Headline figures shown above an answer, at most. */
export const AI_MAX_KPIS = 6
/** A label longer than this is cut, with an ellipsis (by characters, so an Arabic letter is never halved). */
export const AI_KPI_LABEL_MAX = 60
/** A figure longer than this is left out rather than cut: a figure cut short would read as another figure. */
export const AI_KPI_VALUE_MAX = 32

/** The block, as ./blocks finds it: it opens the answer, so one never closed ends at its first blank line. */
export const KPIS_BLOCK: TaggedBlock = { name: 'kpis', unclosed: 'paragraph' }

/** A list marker: "- ", "* ", "• ", "1. ", "1) ". Optional; a number takes a space after it, so "1.5 mm" stays a label. */
const MARKER = /^(?:[-*•]\s+|\d{1,2}[.)]\s+)/
/**
 * A field of nothing but rule characters: a markdown table's separator row, not a figure. (Written so that
 * Tailwind's class scanner, which reads this file, does not take it for an arbitrary property.)
 */
const RULE = /^[\s=:-]+$/
/** A field wrapped whole in markdown emphasis or code ("**39**", "`39`"): the card shows plain text. */
const WRAPPED = /^(\*\*|__|\*|_|`)(.+)\1$/

const isTrend = (v: string): v is AiKpiTrend => (AI_KPI_TRENDS as readonly string[]).includes(v)

function plain(field: string): string {
  const f = field.trim()
  const m = WRAPPED.exec(f)
  return (m ? m[2] : f).trim()
}

/** A trend as the model may spell it ("Down good", "up_bad", "up–good"); undefined when it is none of the five. */
function trendOf(field: string): AiKpiTrend | undefined {
  const t = field.toLowerCase().replace(/[\s_–—-]+/g, '-')
  return isTrend(t) ? t : undefined
}

/** One line of the block as a figure; null for a line that is not one. */
function kpiOf(raw: string): AiKpi | null {
  const line = raw.trim().replace(MARKER, '')
  if (!line.includes('|')) return null
  const fields = line.split('|').map(plain)
  if (fields.length < 2 || fields.length > 3) return null
  const [label, value, trend] = fields
  if (!label || !value || RULE.test(label) || RULE.test(value) || Array.from(value).length > AI_KPI_VALUE_MAX) return null
  const kpi: AiKpi = { label: cutChars(label.replace(/\s+/g, ' '), AI_KPI_LABEL_MAX, true), value: value.replace(/\s+/g, ' ') }
  // A trend that is none of the five is dropped; the figure stays.
  const t = trend ? trendOf(trend) : undefined
  if (t) kpi.trend = t
  return kpi
}

/** The figures of one block's body: each line checked, in order, at most six, one per label. */
export function kpisOf(body: string): AiKpi[] {
  const out: AiKpi[] = []
  for (const line of body.split(/\r?\n/)) {
    const kpi = kpiOf(line)
    if (!kpi || out.some((k) => k.label === kpi.label)) continue
    out.push(kpi)
    if (out.length === AI_MAX_KPIS) break
  }
  return out
}

/** The figures of an answer's texts: those of the last whole block in them. Empty when there is none, or it holds no figure. */
export function parseKpis(texts: readonly string[]): AiKpi[] {
  const body = lastBlockBody(texts, KPIS_BLOCK)
  return body === null ? [] : kpisOf(body)
}

/** The figures an answer being written has given so far: its last whole block, in whichever text it came. */
export function liveKpis(parts: readonly LivePart[]): AiKpi[] {
  return parseKpis(parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])))
}

/** The figures to draw: the saved ones as the server sent them, checked again (a newer server may send more). */
export function kpiCards(kpis: readonly AiKpi[] | undefined): AiKpi[] {
  if (!kpis) return []
  const out: AiKpi[] = []
  for (const k of kpis) {
    if (!k || typeof k.label !== 'string' || typeof k.value !== 'string') continue
    const label = k.label.trim()
    const value = k.value.trim()
    if (!label || !value || out.some((o) => o.label === label)) continue
    out.push(k.trend && isTrend(k.trend) ? { label, value, trend: k.trend } : { label, value })
    if (out.length === AI_MAX_KPIS) break
  }
  return out
}

/** How a trend is drawn: its arrow, and whether the move is good news, bad news or neither. */
export interface KpiTrendView {
  direction: 'up' | 'down' | 'flat'
  tone: 'good' | 'bad' | 'neutral'
  /** Said to a screen reader, after the value. */
  words: string
}

export function kpiTrendView(trend: AiKpiTrend | undefined): KpiTrendView | null {
  switch (trend) {
    case 'up-good':
      return { direction: 'up', tone: 'good', words: 'up, which is good' }
    case 'up-bad':
      return { direction: 'up', tone: 'bad', words: 'up, which is bad' }
    case 'down-good':
      return { direction: 'down', tone: 'good', words: 'down, which is good' }
    case 'down-bad':
      return { direction: 'down', tone: 'bad', words: 'down, which is bad' }
    case 'flat':
      return { direction: 'flat', tone: 'neutral', words: 'unchanged' }
    default:
      return null
  }
}
