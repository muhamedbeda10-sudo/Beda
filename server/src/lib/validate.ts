import type { ZodTypeAny, z } from 'zod'
import { badRequest } from './errors'

/** Parse a request body / query with a schema, or answer 400 naming each problem. */
export function parse<S extends ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input)
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
    const first = details[0]
    throw badRequest(first ? `${first.path ? `${first.path}: ` : ''}${first.message}` : 'Invalid request.', details)
  }
  return result.data
}
