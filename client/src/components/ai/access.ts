// ============================================================================
// §20 — who may use the assistant, in words and checks: why the question box
// is closed for someone (never an amount, a key or a settings page), what a
// model costs per million tokens and so the least a cap may be on it, the
// owner's draft of one person's access (with whether they may create
// automations, §21, and manage notices through it, §23) and whether it can
// be saved. Pure, so it is tested without a browser.
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
import { can } from '@qc/shared/rules'
import { ROLES, type Role } from '@qc/shared/types'
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
  production: 'Production record',
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
  /** §23 — may manage notices through the assistant, while an administrator (the owner always may, while one). */
  notices: boolean
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
  return { enabled: true, domains: ['inspection'], model, effort: 'medium', cap: String(cap), automations: false, notices: false }
}

/** A person's access as it is saved, to edit. The owner's notices switch reads on while they are an administrator, as it then holds. */
export function draftFromAccess(a: AiAccess): AccessDraft {
  return {
    enabled: a.enabled,
    domains: orderDomains(a.domains),
    model: a.model,
    effort: a.effort,
    cap: String(a.monthlyCapUsd),
    automations: a.owner || a.automations,
    notices: a.notices || (a.owner && isAdministrator(a.role)),
  }
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
  return { enabled: d.enabled, domains: orderDomains(d.domains), model: d.model, effort: d.effort, monthlyCapUsd: parseCapUsd(d.cap) ?? 0, automations: d.automations, notices: d.notices }
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
    saved.notices !== d.notices ||
    cap !== a.monthlyCapUsd ||
    saved.domains.join() !== orderDomains(d.domains).join()
  )
}

// ---- Notices through the assistant (§23) -------------------------------------------

/** An administrator in the app: their role may manage its data (notices among it). Checked again by the server on every call, with the role then. */
export function isAdministrator(role: string): boolean {
  return (ROLES as readonly string[]).includes(role) && can(role as Role, 'manage-admin-data')
}

/** Why the notices switch cannot be turned on for someone: only administrators manage notices. */
export const NOTICES_ADMIN_ONLY = 'Only administrators manage notices'

/**
 * Whether a person may manage notices through the assistant, as the owner's
 * table says it. `can`: in effect now (an administrator the owner allowed,
 * or the owner while an administrator). `held`: allowed, but not in effect
 * while their role is not an administrator's — it applies again if it
 * becomes one. `no`: not allowed.
 */
export interface NoticesAccessView {
  key: 'can' | 'held' | 'no'
  tip: string
}

export function noticesAccessView(a: Pick<AiAccess, 'owner' | 'notices' | 'role'>): NoticesAccessView {
  const admin = isAdministrator(a.role)
  if (a.owner) {
    return admin
      ? { key: 'can', tip: 'You always can, as the assistant’s owner, while you are an administrator' }
      : { key: 'no', tip: `${NOTICES_ADMIN_ONLY}: as the owner, you can again once your role is administrator` }
  }
  if (!a.notices) return { key: 'no', tip: 'May not have the assistant change notices; they can still ask about the ones they see' }
  return admin
    ? { key: 'can', tip: 'May have the assistant write, change, withdraw and delete notices: each only when they press its card’s button' }
    : { key: 'held', tip: `Allowed, but not in effect: ${NOTICES_ADMIN_ONLY.toLowerCase()}. It applies again if their role becomes administrator.` }
}

/**
 * What the notices switch says under its name, for the person being edited:
 * `admin`, their role is an administrator's; `stored`, the permission saved
 * for them now (it can be turned off whatever their role, never on unless
 * they are an administrator).
 */
export function noticesSwitchHint(p: { admin: boolean; owner: boolean; stored: boolean }): string {
  if (p.owner) return p.admin ? 'You always can, as the assistant’s owner, while you are an administrator.' : `${NOTICES_ADMIN_ONLY}: as the owner, you can again once your role is administrator.`
  if (!p.admin) {
    return p.stored
      ? `${NOTICES_ADMIN_ONLY}: this is not in effect while their role is not administrator, and applies again if it becomes one. Turn it off to drop it.`
      : `${NOTICES_ADMIN_ONLY}. Like everyone with the assistant, they can still ask about the notices they see.`
  }
  return 'They may have the assistant write a notice, or change, withdraw or delete one. Each comes as a card showing exactly what goes out and to whom, and nothing changes until they press its button. Only while they are an administrator; photos and files are still added on the Notices page.'
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
