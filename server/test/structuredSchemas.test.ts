import { describe, expect, it } from 'vitest'
import { MTC_OUTPUT_SCHEMA } from '../src/mtc/reader'
import { ROUTER_SCHEMA } from '../src/ai/router'
import { TEMPLATE_SCHEMA } from '../src/ai/reports'
import { RUN_SQL_TOOL } from '../src/ai/prompt'

// The API compiles each structured-output schema (output_config.format, strict tools) into a grammar, and refuses with a 400
// ("Schema is too complex for compilation") one with more than 16 union-typed parameters (anyOf, or a type array) or 24
// optional ones, counted over every strict schema of the request. A fake model never compiles anything: held here instead.

const UNION_LIMIT = 16
const OPTIONAL_LIMIT = 24

type Node = Record<string, unknown>

/** Parameters that are unions, and parameters left out of `required`, across a schema and every schema inside it. */
function complexity(schema: unknown): { unions: number; optional: number } {
  let unions = 0
  let optional = 0
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    const node = n as Node
    if (node.properties && typeof node.properties === 'object') {
      const required = new Set((node.required as string[] | undefined) ?? [])
      for (const [key, p] of Object.entries(node.properties as Record<string, Node>)) {
        if (Array.isArray(p.anyOf) || Array.isArray(p.type)) unions++
        if (!required.has(key)) optional++
      }
    }
    for (const v of Object.values(node)) walk(v)
  }
  walk(schema)
  return { unions, optional }
}

describe('structured outputs: every schema compiles', () => {
  it.each([
    ['the certificate reading', MTC_OUTPUT_SCHEMA],
    ['the router', ROUTER_SCHEMA],
    ['the report template', TEMPLATE_SCHEMA],
    ['run_sql (strict)', RUN_SQL_TOOL.input_schema],
  ])('%s stays within the API’s limits', (_name, schema) => {
    const c = complexity(schema)
    expect(c.unions).toBeLessThanOrEqual(UNION_LIMIT)
    expect(c.optional).toBeLessThanOrEqual(OPTIONAL_LIMIT)
  })

  it('reads a certificate with no union and no optional field at all: an unread value is an empty string', () => {
    expect(complexity(MTC_OUTPUT_SCHEMA)).toEqual({ unions: 0, optional: 0 })
  })

  it('counts what it should', () => {
    expect(complexity({ type: 'object', properties: { a: { anyOf: [{ type: 'string' }, { type: 'null' }] }, b: { type: ['string', 'null'] } }, required: ['a'] })).toEqual({
      unions: 2,
      optional: 1,
    })
  })
})
