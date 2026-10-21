// ============================================================================
// §20 — the data a person may ask about, as PostgreSQL enforces it. Each
// domain is a role without LOGIN holding exactly its views (migration 0033);
// the API signs in as one role per combination of domains, a member of the
// base role and of those domains' roles only. Which views a question can
// reach is therefore the database's answer, not the prompt's.
// ============================================================================

import { AI_DOMAIN_IDS, isAiDomain, type AiDomain } from '@qc/shared/ai'

/** The roles migration 0033 creates per database: the base everyone holds, then one per domain. */
export type AiRoleDomain = 'base' | AiDomain

/** A domain's role in a database: <database>_ai_<domain>. */
export const domainRole = (database: string, domain: AiRoleDomain): string => `${database}_ai_${domain}`

/** Domains once each, in their fixed order, whatever order or repeats they came in. */
export function canonicalDomains(domains: readonly string[]): AiDomain[] {
  return AI_DOMAIN_IDS.filter((d) => domains.includes(d))
}

/** A set of domains as bits in the fixed order (inspection, orders, materials, audit, production): "10100". */
export function domainBits(domains: readonly AiDomain[]): string {
  return AI_DOMAIN_IDS.map((d) => (domains.includes(d) ? '1' : '0')).join('')
}

/** The domains a bit string names. */
export function domainsOfBits(bits: string): AiDomain[] {
  return AI_DOMAIN_IDS.filter((_, i) => bits[i] === '1')
}

/** The role that signs in for a set of domains: <database>_ai_r_<bits>. */
export const combinationRole = (database: string, bits: string): string => `${database}_ai_r_${bits}`

/** Every non-empty set of domains, as bits: the thirty-one roles the API signs in as (2^domains - 1; a new domain doubles them). */
export const AI_DOMAIN_COMBINATIONS: readonly string[] = Array.from({ length: (1 << AI_DOMAIN_IDS.length) - 1 }, (_, i) =>
  (i + 1).toString(2).padStart(AI_DOMAIN_IDS.length, '0'),
)

/** Domains read back from the database: anything not a domain any more is dropped. */
export const storedDomains = (value: unknown): AiDomain[] =>
  Array.isArray(value) ? canonicalDomains(value.filter((d): d is AiDomain => typeof d === 'string' && isAiDomain(d))) : []

/**
 * A report's author_domains as read: the domains its queries were written under, or null when that is not known — the
 * column null (the app's own report), or an empty set. An empty set never means "written under no domain": no query
 * is kept without a domain to run as. It is what the column was filled with for a report kept before it existed when
 * its maker had no access row at the time, and what a save wrote for a maker it found none for; read as a bound, it
 * stopped every section of the report for every recipient and every scheduled delivery.
 */
export const authorDomainsOf = (value: unknown): AiDomain[] | null => {
  if (value === null || value === undefined) return null
  const domains = storedDomains(value)
  return domains.length > 0 ? domains : null
}
