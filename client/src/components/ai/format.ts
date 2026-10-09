// ============================================================================
// §20 — the AI assistant's words and figures: money, the share of the monthly
// cap spent, the month a usage report covers, and why the assistant cannot
// answer when it cannot. Shared by the panel and the administration page.
// ============================================================================

import type { AiStopReason, AiUnavailableReason } from '@qc/shared/ai'
import type { BadgeTone } from '@/components/ui'

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const USD_SMALL = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 4, maximumFractionDigits: 4 })
const USD_WHOLE = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

/** Money as spent: "$3.20"; an answer's few tenths of a cent keep four places, "$0.0042". */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return '—'
  return usd > 0 && usd < 0.01 ? USD_SMALL.format(usd) : USD.format(usd)
}

/** A cap as set: "$50", or "$50.50" when it has cents. */
export function formatCap(usd: number): string {
  if (!Number.isFinite(usd)) return '—'
  return Number.isInteger(usd) ? USD_WHOLE.format(usd) : USD.format(usd)
}

/** Tokens, short: 950, 12.4K, 1.2M. */
export function formatTokens(n: number): string {
  return COMPACT.format(n)
}

/** How much of the cap is spent, 0..1 (and beyond, if a last answer overshot). A cap of 0 is spent from the start. */
export function spendShare(spentUsd: number, capUsd: number): number {
  if (capUsd <= 0) return 1
  return Math.max(0, spentUsd / capUsd)
}

/** Quiet under 70 % of the cap, amber to 90 %, red from there. */
export function spendTone(spentUsd: number, capUsd: number): BadgeTone {
  const share = spendShare(spentUsd, capUsd)
  return share >= 0.9 ? 'red' : share >= 0.7 ? 'amber' : 'neutral'
}

/** The colour of a spend bar, by the same thresholds. */
export function spendBarClass(spentUsd: number, capUsd: number): string {
  const share = spendShare(spentUsd, capUsd)
  return share >= 0.9 ? 'bg-rose-500' : share >= 0.7 ? 'bg-amber-500' : 'bg-emerald-500'
}

/** A calendar month in UTC as YYYY-MM, `offset` months from the one `now` falls in (Anthropic bills by the UTC month). */
export function utcMonth(offset = 0, now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** "2026-10" → "October 2026". */
export function formatMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  if (!y || !m) return month
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)))
}

/** "2026-10-07" (a UTC day) → "Oct 7". */
export function formatUtcDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  if (!y || !m || !d) return day
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)))
}

/** Why the assistant cannot answer, in a sentence the asker can act on. */
export const UNAVAILABLE_TEXT: Record<AiUnavailableReason, string> = {
  'no-key': 'An administrator sets the API key under Administration → AI assistant.',
  disabled: 'The assistant is switched off. An administrator can turn it on under Administration → AI assistant.',
  'reader-unavailable': 'The assistant cannot reach the factory data right now. Try again later; if it persists, check the server log.',
  'cap-reached': "This month's budget is spent. The assistant answers again on the 1st (UTC), or when an administrator raises the cap.",
}

/** How an answer ended when it did not simply finish: the default words, when the server sent none. */
export const STOP_TEXT: Record<Exclude<AiStopReason, 'end_turn'>, string> = {
  max_tokens: 'The answer was cut at the longest a reply may be. Ask for less at once, or ask it to continue.',
  refusal: 'Claude declined to answer this question.',
  stopped: 'Stopped before the answer finished.',
  limit: 'Stopped: this question took too many queries or too long. Ask a narrower one.',
  cap: "Stopped: this month's budget is spent.",
  error: 'Something went wrong before the answer finished.',
}
