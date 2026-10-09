// ============================================================================
// §20 — the headline figures an answer opens with. The system prompt of a
// conversation begun since phase 4 asks the model to open an answer that
// comes down to a few figures with a block
//
//     <kpis>
//     - Defect pieces | 39
//     - Reject rate | 1.29% | down-good
//     - Holds open | 4 | up-bad
//     </kpis>
//
// one line per figure: a label, the figure as written, and optionally how it
// moved against the period it was compared with, and whether that is good.
// As with the follow-up questions (suggestions.ts), the transcript keeps the
// block as written; the display takes it out of the text and hands the
// figures over as AiMessage.kpis, for the panel to draw as cards above the
// answer. While the answer streams, the panel hides the block itself.
// ============================================================================

import { AI_KPI_TRENDS, type AiKpi, type AiKpiTrend } from '@qc/shared/ai'
import { cutChars, lastBlockBody, type AnswerBlock } from './blocks'

/** At most this many figures are shown. */
export const MAX_KPIS = 6
/** A label longer than this is cut: the prompt asks for 40 characters, this is the slack. */
export const MAX_KPI_LABEL_CHARS = 60
/** A figure longer than this is left out rather than cut: a figure cut short would read as another figure. The prompt asks for 24. */
export const MAX_KPI_VALUE_CHARS = 32

/**
 * The block, as blocks.ts finds it. It opens the answer, so one whose closing
 * tag never came ends at its first blank line: the answer after it stays.
 */
export const KPIS_BLOCK: AnswerBlock = { name: 'kpis', unclosed: 'paragraph' }

/** A list marker: "- ", "* ", "• ", "1. ", "1) ". Optional; a number takes a space after it, so "1.5 mm" stays a label. */
const MARKER = /^(?:[-*•]\s+|\d{1,2}[.)]\s+)/
/** A field of nothing but rule characters: a markdown table's separator row, not a figure. */
const RULE = /^[-:=\s]+$/
/** A field wrapped whole in markdown emphasis or code ("**39**", "`39`"): the card shows plain text. */
const WRAPPED = /^(\*\*|__|\*|_|`)(.+)\1$/

function plain(field: string): string {
  const f = field.trim()
  const m = WRAPPED.exec(f)
  return (m ? m[2] : f).trim()
}

/** A trend as the model may spell it ("Down good", "up_bad"); undefined when it is none of them. */
function trendOf(field: string): AiKpiTrend | undefined {
  const t = field.toLowerCase().replace(/[\s_–—-]+/g, '-')
  return (AI_KPI_TRENDS as readonly string[]).includes(t) ? (t as AiKpiTrend) : undefined
}

/** One line of the block as a figure; null for a line that is not one. */
function kpiOf(raw: string): AiKpi | null {
  const line = raw.trim().replace(MARKER, '')
  if (!line.includes('|')) return null
  const fields = line.split('|').map(plain)
  if (fields.length < 2 || fields.length > 3) return null
  const [label, value, trend] = fields
  if (!label || !value || RULE.test(label) || RULE.test(value) || Array.from(value).length > MAX_KPI_VALUE_CHARS) return null
  const kpi: AiKpi = { label: cutChars(label.replace(/\s+/g, ' '), MAX_KPI_LABEL_CHARS, true), value: value.replace(/\s+/g, ' ') }
  // A trend that is none of the five is dropped; the figure stays.
  const t = trend ? trendOf(trend) : undefined
  if (t) kpi.trend = t
  return kpi
}

/**
 * The headline figures of an answer: those of the last whole block in its
 * texts, in order, each line checked, at most six, one per label. Empty when
 * there is none or it holds no figure.
 */
export function parseKpis(texts: readonly string[]): AiKpi[] {
  const body = lastBlockBody(texts, KPIS_BLOCK)
  if (body === null) return []
  const out: AiKpi[] = []
  for (const line of body.split(/\r?\n/)) {
    const kpi = kpiOf(line)
    if (!kpi || out.some((k) => k.label === kpi.label)) continue
    out.push(kpi)
    if (out.length === MAX_KPIS) break
  }
  return out
}
