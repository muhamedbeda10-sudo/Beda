// ============================================================================
// Row ↔ domain mapping helpers.
//
// The database speaks snake_case; the domain model speaks camelCase. Every
// SELECT in this codebase aliases its columns to camelCase (`order_number AS
// "orderNumber"`) so a row is already a domain object, and the helpers below
// handle the few shapes SQL cannot express directly (nested objects, arrays
// of ids, dropping nulls the client treats as "absent").
// ============================================================================

/** Remove keys whose value is null so optional domain fields read as absent. */
export function dropNulls<T extends object>(row: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) if (v !== null) out[k] = v
  return out as T
}

/** Batch rows by a key into a Map of arrays. */
export function groupBy<T, K extends string | number>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>()
  for (const r of rows) {
    const k = key(r)
    const arr = m.get(k)
    if (arr) arr.push(r)
    else m.set(k, [r])
  }
  return m
}

export function normaliseKey(v: unknown): string {
  return String(v ?? '').trim().toLowerCase()
}
