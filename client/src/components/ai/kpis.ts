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
// `AiMessage.kpis`; while the answer is still being written the block arrives
// as text like any other, so the thread hides it here — from its first
// characters, never flashing the tag — and draws the figures as cards as soon
// as the block is whole.
// ============================================================================

import { AI_KPI_TRENDS, type AiKpi, type AiKpiTrend } from '@qc/shared/ai'
import type { LivePart } from './liveTurn'

/** Headline figures shown above an answer, at most. */
export const AI_MAX_KPIS = 6
/** A label or a value longer than this is cut (by characters, so an Arabic letter is never halved). */
export const AI_KPI_LABEL_MAX = 80
export const AI_KPI_VALUE_MAX = 40

const OPEN = '<kpis'
const BLOCK = /<kpis\b[^>]*>([\s\S]*?)<\/kpis\s*>/gi
/** A list marker: "- ", "* ", "• ", "1. ", "1) ". */
const MARKER = /^(?:[-*•]\s+|\d{1,2}[.)]\s*)/

const clip = (s: string, max: number) => {
  const chars = Array.from(s.trim())
  return (chars.length > max ? chars.slice(0, max) : chars).join('').trim()
}

const isTrend = (v: string): v is AiKpiTrend => (AI_KPI_TRENDS as readonly string[]).includes(v)

/** The figures of one block's body: its list lines that carry a label and a value, at most six, each label once. */
export function kpisOf(body: string): AiKpi[] {
  const out: AiKpi[] = []
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    const marker = MARKER.exec(line)
    if (!marker) continue
    const cells = line.slice(marker[0].length).split('|').map((c) => c.trim())
    if (cells.length < 2) continue
    const label = clip(cells[0], AI_KPI_LABEL_MAX)
    const value = clip(cells[1], AI_KPI_VALUE_MAX)
    if (!label || !value || out.some((k) => k.label === label)) continue
    const trend = (cells[2] ?? '').toLowerCase().replace(/[\s_]+/g, '-')
    out.push(isTrend(trend) ? { label, value, trend } : { label, value })
    if (out.length === AI_MAX_KPIS) break
  }
  return out
}

/** The figures of a text: those of its last whole block. Empty when there is none, or it lists nothing. */
export function parseKpis(text: string): AiKpi[] {
  let last: string | null = null
  for (const m of text.matchAll(BLOCK)) last = m[1]
  return last === null ? [] : kpisOf(last)
}

/**
 * A text as it may be shown while it is written: without any whole <kpis>
 * block, without one that is open and not yet closed (all of it to the end),
 * and without a tag still arriving at the very end ("<kp").
 */
export function hideKpis(text: string): string {
  let out = text.replace(BLOCK, '')
  const open = out.search(/<kpis/i)
  if (open >= 0) out = out.slice(0, open)
  else {
    // A lone "<" or "<kp…" at the end may be the tag's first characters: held back until the next piece says.
    const lt = out.lastIndexOf('<')
    if (lt >= 0 && out.length - lt <= OPEN.length && OPEN.startsWith(out.slice(lt).toLowerCase())) out = out.slice(0, lt)
  }
  if (out === text) return text
  // The block opens the answer: the blank lines it leaves before the text go with it.
  return out.replace(/^\s*\n/, '').trimEnd()
}

/** The figures an answer being written has given so far: its last whole block, in whichever text it came. */
export function liveKpis(parts: readonly LivePart[]): AiKpi[] {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]
    if (p.type !== 'text') continue
    const kpis = parseKpis(p.text)
    if (kpis.length > 0) return kpis
  }
  return []
}

/** The figures to draw: the saved ones as the server sent them, checked again (a newer server may send more). */
export function kpiCards(kpis: readonly AiKpi[] | undefined): AiKpi[] {
  if (!kpis) return []
  const out: AiKpi[] = []
  for (const k of kpis) {
    if (!k || typeof k.label !== 'string' || typeof k.value !== 'string') continue
    const label = k.label.trim()
    const value = k.value.trim()
    if (!label || !value) continue
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
