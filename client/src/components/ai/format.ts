// ============================================================================
// §20 — the AI assistant's words and figures: money, the share of a monthly
// cap spent, the month a usage report covers (all for the owner's page — the
// chat shows no amounts), why the assistant cannot answer as the owner's page
// says it, and how an answer ended.
// ============================================================================

import { AI_MODELS, type AiStopReason, type AiUnavailableReason } from '@qc/shared/ai'
import type { BadgeTone } from '@/components/ui'

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const USD_SMALL = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 4, maximumFractionDigits: 4 })
const USD_MILLS = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 3, maximumFractionDigits: 3 })
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

/** Why nobody can ask the assistant, precisely, for its owner's page (everyone else reads AI_BLOCK_TEXT, in ./access). */
export const UNAVAILABLE_TEXT: Record<AiUnavailableReason, string> = {
  'no-key': 'There is no API key: nobody can ask until one is set below.',
  disabled: 'The assistant is switched off: nobody can ask until it is turned on below.',
  'reader-unavailable': 'The assistant cannot reach the factory data right now. Try again later; if it persists, check the server log.',
  'cap-reached': 'The app-wide monthly cap is reached, or too little of it is left for an answer to start. Nobody can ask until the 1st (UTC), or until the cap is raised below.',
}

/** How an answer ended when it did not simply finish: the default words, when the server sent none. */
export const STOP_TEXT: Record<Exclude<AiStopReason, 'end_turn'>, string> = {
  max_tokens: 'The answer was cut at the longest a reply may be. Ask for less at once, or ask it to continue.',
  refusal: 'Claude declined to answer this question.',
  stopped: 'Stopped before the answer finished.',
  limit: 'Stopped: this question took too many queries or too long. Ask a narrower one.',
  cap: "Stopped: this month's limit for the assistant is reached.",
  error: 'Something went wrong before the answer finished.',
}

/** One answer's cost on the owner's Activity list: to a tenth of a cent, "$0.070", so answers compare at a glance. */
export function formatAnswerCost(usd: number): string {
  if (!Number.isFinite(usd)) return '—'
  return usd > 0 && usd < 0.001 ? USD_SMALL.format(usd) : USD_MILLS.format(usd)
}

/** A model as people name it, "Claude Sonnet 5.5"; one not offered here (a refusal's fallback) by its id. */
export function aiModelName(id: string): string {
  return AI_MODELS.find((m) => m.id === id)?.name ?? id
}

/** How an answer ended, in a word or two beside it on the Activity list; an answer that simply finished says nothing. */
export const ACTIVITY_STOP_LABEL: Record<Exclude<AiStopReason, 'end_turn'>, string> = {
  max_tokens: 'cut at its length',
  refusal: 'declined',
  stopped: 'stopped',
  limit: 'too many queries',
  cap: 'cap reached',
  error: 'failed',
}
