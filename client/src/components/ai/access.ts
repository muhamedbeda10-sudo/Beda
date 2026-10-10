// ============================================================================
// §20 — who may use the assistant, in words and checks: why the question box
// is closed for someone (never an amount, a key or a settings page), what a
// model costs per million tokens and so the least a cap may be on it, the
// owner's draft of one person's access (with whether they may create
// automations, §21) and whether it can be saved. Pure, so it is tested
// without a browser.
// ============================================================================

import {
  AI_DOMAINS,
  AI_DOMAIN_IDS,
  AI_EFFORTS,
  AI_MAX_MONTHLY_CAP_USD,
  AI_MODELS,
  AI_PRICES,
  aiMinCapUsd,
  isAiDomain,
  type AiAccess,
  type AiAccessRequest,
  type AiDomain,
  type AiEffort,
  type AiMeReason,
  type AiMeResponse,
  type AiModelId,
} from '@qc/shared/ai'
import { formatCap, formatTokens } from './format'

/** Why someone who has the assistant cannot ask it now. ('not-granted' is never said: the assistant is simply not there.) */
export type AiBlock = Exclude<AiMeReason, 'not-granted'>

/** The words for each, the same for the owner and everyone else: no amounts, no keys, no settings. */
export const AI_BLOCK_TEXT: Record<AiBlock, string> = {
  'personal-cap': "You have reached this month's limit for the assistant. It is available again on the 1st.",
  'cap-reached': "The assistant's monthly limit is reached. It is available again on the 1st.",
  unavailable: 'The assistant is not available right now.',
}

/**
 * What closes the question box, from /ai/me: null while it can answer, while
 * /ai/me has not answered yet, and for someone it is not given to (the panel
 * says that instead). An unknown reason reads as "not available".
 */
export function aiBlock(me: AiMeResponse | undefined): AiBlock | null {
  if (!me || !me.granted || me.available) return null
  const reason = me.reason
  return reason === 'personal-cap' || reason === 'cap-reached' ? reason : 'unavailable'
}

// ---- Models, effort and data, in words -----------------------------------------

/** A rate as Anthropic lists it: "$2", "$0.10", "$12.50". */
export function formatRate(usd: number): string {
  return formatCap(usd)
}

/**
 * A model's price per million tokens, read in and written out:
 * "$2 in · $10 out per million tokens". A model whose rate rises with a long
 * prompt says so: "…; $0.50 in · $2.50 out for prompts over 100K tokens".
 */
export function describeModelPrice(model: string): string {
  const price = AI_PRICES[model]
  if (!price) return 'Price not known: counted at the dearest rates.'
  const base = `${formatRate(price.input)} in · ${formatRate(price.output)} out per million tokens`
  if (!price.long) return base
  const long = price.long
  return `${base}; ${formatRate(long.input)} in · ${formatRate(long.output)} out for prompts over ${formatTokens(long.aboveInputTokens)} tokens`
}

/** A model's name, or its id when the app does not know it. */
export function modelName(model: string): string {
  return AI_MODELS.find((m) => m.id === model)?.name ?? model
}

/** An effort level's name, or its id when the app does not know it. */
export function effortName(effort: string): string {
  return AI_EFFORTS.find((e) => e.id === effort)?.name ?? effort
}

/** The data each domain covers, short, for a chip in the table (the full name and its note are its tooltip). */
export const AI_DOMAIN_SHORT: Record<AiDomain, string> = {
  inspection: 'Inspections',
  orders: 'Orders & PDI',
  materials: 'Coils & master data',
  audit: 'Audit & accounts',
}

/** A domain's full name and what it holds, for the tooltip of its chip. */
export function domainTip(domain: AiDomain): string {
  const d = AI_DOMAINS.find((x) => x.id === domain)
  return d ? `${d.name}: ${d.note}` : domain
}

/** Domains in the order the app lists them, each once, unknown ones left out. */
export function orderDomains(domains: readonly string[]): AiDomain[] {
  const have = new Set(domains.filter(isAiDomain))
  return AI_DOMAIN_IDS.filter((d) => have.has(d))
}

// ---- The least a cap may be ---------------------------------------------------------

/** The least a monthly cap must be for anyone on this model to ask at all: the server's own figure (output and fallback). */
export const minCapUsd = (model: string): number => aiMinCapUsd(model)

/** Why a cap is too small for a model, for the owner: the least it may be, and what happens below it. */
export function capTooLowText(model: string): string {
  return `On ${modelName(model)} the cap must be at least ${formatCap(minCapUsd(model))}, the most one call to the model may cost. Below that they could never ask: they would be told the month's limit is reached, every month.`
}

/** Whether a cap lets a person on this model ask at all. */
export const capFitsModel = (capUsd: number, model: string): boolean => capUsd >= minCapUsd(model)

// ---- The owner's draft of one person's access -------------------------------------

/** The cap as typed: dollars, at most two decimals. */
const CAP_PATTERN = /^\d+(\.\d{1,2})?$/

/** What a cap may be, in a sentence for when it is not. */
export const CAP_RANGE_TEXT = `The cap is an amount in dollars from 0 to ${formatCap(AI_MAX_MONTHLY_CAP_USD)}, with at most two decimals.`

/** A cap as typed, in dollars; null when it is not one the server takes. */
export function parseCapUsd(raw: string): number | null {
  const t = raw.trim()
  if (!CAP_PATTERN.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 && n <= AI_MAX_MONTHLY_CAP_USD ? n : null
}

/** A person's access as the owner is editing it; the cap as typed. */
export interface AccessDraft {
  enabled: boolean
  domains: AiDomain[]
  model: AiModelId
  effort: AiEffort
  cap: string
  /** §21 — may create automations (the owner always may). */
  automations: boolean
}

/** A newcomer's monthly cap: a fifth of the default app-wide cap, never above the app-wide cap set now. The owner raises it. */
export const AI_NEW_PERSON_CAP_USD = 10

/**
 * Where a person newly given the assistant starts: on, the inspection record
 * only (the narrowest useful data — the owner adds the rest), the default
 * model and effort, and a small cap — within the app-wide cap, but never so
 * small that they could not ask at all (the drawer then says the app-wide
 * cap is the one in the way).
 */
export function newAccessDraft(appCapUsd: number): AccessDraft {
  const model: AiModelId = 'claude-sonnet-5-5'
  const cap = Math.max(minCapUsd(model), Math.min(AI_NEW_PERSON_CAP_USD, appCapUsd))
  return { enabled: true, domains: ['inspection'], model, effort: 'medium', cap: String(cap), automations: false }
}

/** A person's access as it is saved, to edit. */
export function draftFromAccess(a: AiAccess): AccessDraft {
  return { enabled: a.enabled, domains: orderDomains(a.domains), model: a.model, effort: a.effort, cap: String(a.monthlyCapUsd), automations: a.owner || a.automations }
}

/** Why the draft cannot be saved, or null when it can. */
export function checkAccessDraft(d: AccessDraft): string | null {
  if (orderDomains(d.domains).length === 0) return 'Choose at least one kind of data they may ask about.'
  const cap = parseCapUsd(d.cap)
  if (cap === null) return CAP_RANGE_TEXT
  // Switching someone off is never held up by their cap: it is checked again when they are switched back on.
  if (d.enabled && !capFitsModel(cap, d.model)) return capTooLowText(d.model)
  return null
}

/** The draft as the server takes it. Call checkAccessDraft first: an unreadable cap goes as 0. */
export function accessRequest(d: AccessDraft): AiAccessRequest {
  return { enabled: d.enabled, domains: orderDomains(d.domains), model: d.model, effort: d.effort, monthlyCapUsd: parseCapUsd(d.cap) ?? 0, automations: d.automations }
}

/** Whether the draft says anything other than the saved access. */
export function accessChanged(a: AiAccess, d: AccessDraft): boolean {
  const saved = draftFromAccess(a)
  const cap = parseCapUsd(d.cap)
  return (
    saved.enabled !== d.enabled ||
    saved.model !== d.model ||
    saved.effort !== d.effort ||
    saved.automations !== d.automations ||
    cap !== a.monthlyCapUsd ||
    saved.domains.join() !== orderDomains(d.domains).join()
  )
}

/** One domain ticked or unticked, the rest kept in order. */
export function toggleDomain(domains: readonly AiDomain[], domain: AiDomain, on: boolean): AiDomain[] {
  return orderDomains(on ? [...domains, domain] : domains.filter((d) => d !== domain))
}

// ---- The table ---------------------------------------------------------------------

/** The owner's own row first, then those who can sign in, each by name. */
export function sortAccess(people: readonly AiAccess[]): AiAccess[] {
  return [...people].sort((a, b) => Number(b.owner) - Number(a.owner) || Number(b.active) - Number(a.active) || a.name.localeCompare(b.name))
}

/**
 * Whether a person can ask now, as far as the owner set it: an account that
 * can sign in, switched on, with data to ask about and a cap that lets one
 * call to their model through.
 */
export function accessLive(a: AiAccess): boolean {
  return a.active && a.enabled && a.domains.length > 0 && capFitsModel(a.monthlyCapUsd, a.model)
}

/** Roles from the widest rights down, for grouping the accounts to pick from. */
const ROLE_ORDER = ['admin', 'supervisor', 'inspector', 'viewer']

/** A role as a heading: "Supervisor". */
export function roleLabel(role: string): string {
  return role ? role.charAt(0).toUpperCase() + role.slice(1) : 'No role'
}

/** The accounts to pick from, grouped by role (the widest rights first, a role the app does not know last), each group by name. */
export function groupByRole<T extends { name: string; role: string }>(people: readonly T[]): [role: string, people: T[]][] {
  const groups = new Map<string, T[]>()
  for (const p of people) groups.set(p.role, [...(groups.get(p.role) ?? []), p])
  const rank = (role: string) => {
    const i = ROLE_ORDER.indexOf(role)
    return i < 0 ? ROLE_ORDER.length : i
  }
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([role, list]) => [role, [...list].sort((x, y) => x.name.localeCompare(y.name))])
}
