// ============================================================================
// Which domain an object of schema ai belongs to, read from the grants the
// domains' roles hold on it (what every domain may use — the shared helpers —
// belongs to none); and, from a refused query's message, what data it was
// after. A section of a report that the database refuses for want of a grant
// (42501) is then told in the domain's own name — "Planning (trial)" — so the
// person knows what to ask for, instead of a sentence that only says no. A
// saved table (schema ai_saved) counts as the domains its rows came from.
// ============================================================================

import { AI_DOMAINS, AI_DOMAIN_IDS, type AiDomain } from '@qc/shared/ai'
import type { Queryable } from '../db/pool'
import { canonicalDomains, domainRole } from './domains'

/** The objects of schema ai that belong to some domains but not all, each with its domains. */
export async function objectDomains(q: Queryable): Promise<Map<string, AiDomain[]>> {
  const { rows: db } = await q.query<{ database: string }>(`SELECT current_database() AS database`)
  const roles = AI_DOMAIN_IDS.map((d) => domainRole(db[0].database, d))
  const { rows } = await q.query<{ name: string; domains: AiDomain[] }>(
    `SELECT o.name, array_agg(d.domain ORDER BY d.domain) AS domains
       FROM (SELECT c.relname AS name, c.oid, 'table' AS what FROM pg_class c WHERE c.relnamespace = 'ai'::regnamespace AND c.relkind IN ('v', 'm', 'r', 'p', 'f')
             UNION ALL
             SELECT p.proname, p.oid, 'function' FROM pg_proc p WHERE p.pronamespace = 'ai'::regnamespace) o
      CROSS JOIN unnest($1::text[], $2::text[]) AS d(domain, role)
      WHERE CASE o.what WHEN 'table' THEN has_table_privilege(d.role, o.oid, 'SELECT') ELSE has_function_privilege(d.role, o.oid, 'EXECUTE') END
      GROUP BY o.name`,
    [AI_DOMAIN_IDS, roles],
  )
  const map = new Map(rows.filter((o) => o.domains.length < AI_DOMAIN_IDS.length).map((o) => [o.name.toLowerCase(), canonicalDomains(o.domains)]))
  // The saved tables (schema ai_saved), each read as the domains its rows came from (ai/savedTables).
  const { rows: saved } = await q.query<{ name: string; domains: string[] | null }>(`SELECT name, domains FROM ai_saved_tables WHERE deleted_at IS NULL`)
  for (const t of saved) {
    const domains = canonicalDomains((t.domains ?? []).filter((d): d is AiDomain => AI_DOMAIN_IDS.includes(d as AiDomain)))
    if (domains.length > 0 && !map.has(t.name.toLowerCase())) map.set(t.name.toLowerCase(), domains)
  }
  return map
}

/** The object a refusal names: "permission denied for view inspection_sessions" (a table, a relation, a function). */
export function refusedObject(dbMessage: string | undefined): string | null {
  const m = /permission denied for (?:view|table|relation|materialized view|function|sequence) (?:"?ai"?\.)?"?([A-Za-z_][A-Za-z0-9_$]*)"?/i.exec(dbMessage ?? '')
  return m ? m[1].toLowerCase() : null
}

/** The domains the data a refused query was after belongs to; none when the refusal names nothing of a domain's. */
export function domainsRefused(owned: Map<string, AiDomain[]>, dbMessage: string | undefined): AiDomain[] {
  const name = refusedObject(dbMessage)
  return name ? (owned.get(name) ?? []) : []
}

/** Domains by their names, as the owner's panel shows them: "Inspections", "Planning (trial)". */
export const domainNames = (domains: readonly AiDomain[]): string => domains.map((d) => AI_DOMAINS.find((x) => x.id === d)?.name ?? d).join(', ')
