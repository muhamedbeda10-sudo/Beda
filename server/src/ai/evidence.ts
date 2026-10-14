// ============================================================================
// §20 — whether a figure the assistant gives as evidence comes from the data:
// every number in it must be one a query of the conversation returned, as
// written there or rounded to the places the evidence shows it with (a share
// the query gave as 0.041 may read 4.1%), or inside a text the query returned
// (a code, a date). The diagram tool (./diagrams) holds a fishbone's causes,
// and a 5 Whys step's evidence, to it: what no query showed is not drawn.
// ============================================================================

import type { AiCell } from '@qc/shared/ai'
import type { Queryable } from '../db/pool'

/** A query's result as the model read it: its purpose and its rows. */
export interface QueryResult {
  purpose: string
  rows: AiCell[][]
}

/** Arabic-Indic and Persian digits as 0-9, and a typographic minus as "-". */
function plainDigits(text: string): string {
  return text.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/−/g, '-')
}

interface Figure {
  /** As written, its thousands' commas taken out. */
  text: string
  value: number
  places: number
}

/** The numbers in a text: "1,284" is one number, "4.1" one with a place, "2026-10-02" three. */
export function figuresIn(text: string): Figure[] {
  const out: Figure[] = []
  for (const m of plainDigits(text).matchAll(/\d+(?:,\d{3})*(?:\.\d+)?/g)) {
    const t = m[0].replace(/,/g, '')
    out.push({ text: t, value: Number(t), places: t.includes('.') ? t.length - t.indexOf('.') - 1 : 0 })
  }
  return out
}

const roundTo = (v: number, places: number) => Math.round(Math.abs(v) * 10 ** places) / 10 ** places

/** Whether a cell holds the figure: a number that reads as it once rounded (or as a share, ×100), or a text with it in. */
function holds(cell: AiCell, f: Figure): boolean {
  if (cell === null || cell === undefined) return false
  const asNumber = typeof cell === 'number' ? cell : typeof cell === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(cell) ? Number(cell) : null
  if (asNumber !== null && Number.isFinite(asNumber)) {
    const close = (v: number) => Math.abs(roundTo(v, f.places) - f.value) < 1e-9
    if (close(asNumber) || close(asNumber * 100)) return true
  }
  if (typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') {
    const inText = plainDigits(String(cell)).replace(/(\d),(\d{3})/g, '$1$2')
    return new RegExp(`(^|[^\\d.])${f.text.replace('.', '\\.')}($|[^\\d])`).test(inText)
  }
  return false
}

/**
 * Where each figure of `evidence` was found: the purposes of the queries, in the order first found; or the figures no
 * query returned. Evidence with no figure in it is refused: it shows nothing.
 */
export function findEvidence(evidence: string, results: readonly QueryResult[]): { sources: string[] } | { missing: string[]; none?: boolean } {
  const figures = figuresIn(evidence)
  if (figures.length === 0) return { missing: [], none: true }
  const sources: string[] = []
  const missing: string[] = []
  for (const f of figures) {
    const found = results.find((r) => r.rows.some((row) => row.some((cell) => holds(cell, f))))
    if (!found) missing.push(f.text)
    else if (!sources.includes(found.purpose)) sources.push(found.purpose)
  }
  return missing.length > 0 ? { missing } : { sources }
}

/** Queries of a conversation an evidence is looked for in, the newest: far more than one answer runs. */
const LOOKED_IN = 200

/** The results of the queries the conversation ran that worked, newest first: what the model has read. */
export async function conversationResults(q: Queryable, conversationId: string): Promise<QueryResult[]> {
  const { rows } = await q.query<QueryResult>(`SELECT purpose, rows FROM ai_queries WHERE conversation_id = $1 AND ok ORDER BY created_at DESC, id LIMIT ${LOOKED_IN}`, [conversationId])
  return rows
}
