// ============================================================================
// Firestore reads for the screens.
//
// Firestore bills per document returned, so a screen that loads a whole
// collection costs one read per row every time it opens. With 28,871 orders and
// 30,296 coils that is tens of thousands of reads per page view — slow, and a
// real bill. Nothing here fetches an unbounded collection: every hook either
// targets specific ids, applies a server-side filter with a limit, or is
// explicitly declared small.
//
// Soft-deleted records are filtered in one place so no screen can show evidence
// that was marked deleted.
// ============================================================================

import { useEffect, useMemo, useState } from 'react'
import {
  collection,
  documentId,
  getCountFromServer,
  onSnapshot,
  query,
  where,
  orderBy,
  limit as fbLimit,
  type QueryConstraint,
} from 'firebase/firestore'
import { getDb, firebaseEnabled } from '@/lib/firebase'

export interface CollectionState<T> {
  rows: T[]
  loading: boolean
  error: string | null
}

const EMPTY: CollectionState<never> = { rows: [], loading: false, error: null }

/** Firestore caps `in` / `documentId() in` at 30 values per query. */
const IN_CHUNK = 30

function chunk<T>(arr: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/**
 * Subscribe to a query. `constraints` must be stable — express what it depends
 * on through `deps`, or a new array each render resubscribes forever.
 *
 * Always pass a limit unless the collection is genuinely small.
 */
export function useQueryRows<T extends { id: string; deletedAt?: string | null }>(
  collectionName: string,
  constraints: QueryConstraint[],
  deps: unknown[],
  options: { includeDeleted?: boolean; enabled?: boolean } = {},
): CollectionState<T> {
  const [rows, setRows] = useState<T[]>([])
  const [settled, setSettled] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)
  const includeDeleted = options.includeDeleted ?? false
  const enabled = options.enabled ?? true

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const memo = useMemo(() => constraints, deps)

  useEffect(() => {
    if (!firebaseEnabled || !enabled) {
      setRows([])
      setSettled(memo)
      return
    }
    const unsub = onSnapshot(
      query(collection(getDb(), collectionName), ...memo),
      (snap) => {
        const all = snap.docs.map((d) => ({ ...(d.data() as T), id: d.id }))
        setRows(includeDeleted ? all : all.filter((r) => !r.deletedAt))
        setSettled(memo)
        setError(null)
      },
      (err) => {
        console.warn(`[${collectionName}]`, err)
        setError(err.message)
        setSettled(memo)
      },
    )
    return () => unsub()
  }, [collectionName, memo, includeDeleted, enabled])

  // Derived from the query currently in flight, so a changed query reads as
  // loading on the very first render rather than one render later.
  return { rows, loading: settled !== memo, error }
}

/**
 * Every row of a collection.
 *
 * Only for master data that is small and bounded by how the factory is
 * configured — machines (32), grade mappings (7), PT consumables, work-centre
 * defects (52), dimension configuration (~350). Never for orders, coils,
 * samples, dimensions, defects or audit logs.
 */
export function useSmallCollection<T extends { id: string; deletedAt?: string | null }>(
  collectionName: string,
): CollectionState<T> {
  return useQueryRows<T>(collectionName, [fbLimit(2000)], [collectionName])
}

/** Rows matching a single equality filter, capped. */
export function useWhere<T extends { id: string; deletedAt?: string | null }>(
  collectionName: string,
  field: string,
  value: string | number | boolean | null | undefined,
  max = 500,
): CollectionState<T> {
  const enabled = value !== undefined && value !== null && value !== ''
  const constraints = useMemo(
    () => (enabled ? [where(field, '==', value), fbLimit(max)] : []),
    [field, value, enabled, max],
  )
  return useQueryRows<T>(collectionName, constraints, [collectionName, field, value, max], { enabled })
}

/**
 * Documents fetched by id, in chunks of 30.
 *
 * This is how a screen resolves the parents of what it is already showing —
 * the orders behind ten open sessions cost ten reads, not 28,871.
 */
export function useDocsByIds<T extends { id: string; deletedAt?: string | null }>(
  collectionName: string,
  ids: string[],
): CollectionState<T> {
  const key = useMemo(() => Array.from(new Set(ids.filter(Boolean))).sort().join(','), [ids])
  const [rows, setRows] = useState<T[]>([])
  const [settledKey, setSettledKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const wanted = key ? key.split(',') : []
    if (!firebaseEnabled || wanted.length === 0) {
      setRows([])
      setSettledKey(key)
      return
    }
    const store = getDb()
    const groups = chunk(wanted)
    const found = new Map<string, T>()
    const unsubs = groups.map((group) =>
      onSnapshot(
        query(collection(store, collectionName), where(documentId(), 'in', group)),
        (snap) => {
          for (const d of snap.docs) found.set(d.id, { ...(d.data() as T), id: d.id })
          setRows(Array.from(found.values()).filter((r) => !r.deletedAt))
          setSettledKey(key)
          setError(null)
        },
        (err) => {
          console.warn(`[${collectionName}] by ids`, err)
          setError(err.message)
          setSettledKey(key)
        },
      ),
    )
    return () => unsubs.forEach((u) => u())
  }, [collectionName, key])

  // Derived rather than stored, so the first render of a new id set already
  // reads as loading. A caller that renders "not found" on an empty result
  // must not see it in the gap before the effect runs.
  return { rows, loading: settledKey !== key, error }
}

/**
 * A value that settles `ms` after it stops changing.
 * Typing an eight-character order number should cost one query, not eight.
 */
export function useDebounced<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return settled
}

/**
 * Rows whose `field` starts with `term`, resolved on the server.
 *
 * Firestore has no text search, so this is an indexed range scan: everything
 * from the term up to the term plus a high code point. Good enough for order
 * numbers, item codes and coil numbers, which is what inspectors actually type.
 * An empty term returns the first `max` rows in key order rather than the whole
 * collection.
 *
 * The term is debounced, so a query is issued once the inspector stops typing.
 */
export function usePrefixSearch<T extends { id: string; deletedAt?: string | null }>(
  collectionName: string,
  field: string,
  term: string,
  max = 25,
  options: { enabled?: boolean } = {},
): CollectionState<T> {
  const t = useDebounced(term.trim())
  const enabled = options.enabled ?? true
  const constraints = useMemo(() => {
    if (!enabled) return []
    if (!t) return [orderBy(field), fbLimit(max)]
    // \uf8ff sits above any ordinary character, making this a prefix range.
    return [orderBy(field), where(field, '>=', t), where(field, '<=', t + '\uf8ff'), fbLimit(max)]
  }, [field, t, max, enabled])
  return useQueryRows<T>(collectionName, constraints, [collectionName, field, t, max, enabled], { enabled })
}

/** The most recent `max` rows by a timestamp field. */
export function useRecent<T extends { id: string; deletedAt?: string | null }>(
  collectionName: string,
  field: string,
  max = 50,
  extra: QueryConstraint[] = [],
  deps: unknown[] = [],
): CollectionState<T> {
  const constraints = useMemo(
    () => [...extra, orderBy(field, 'desc'), fbLimit(max)],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [field, max, ...deps],
  )
  return useQueryRows<T>(collectionName, constraints, [collectionName, field, max, ...deps])
}

/**
 * Rows whose `field` matches any of `values`, in chunks of 30.
 * Used to load the children of the parents already on screen.
 */
export function useWhereIn<T extends { id: string; deletedAt?: string | null }>(
  collectionName: string,
  field: string,
  values: string[],
  max = 1000,
): CollectionState<T> {
  const key = useMemo(() => Array.from(new Set(values.filter(Boolean))).sort().join(','), [values])
  const [rows, setRows] = useState<T[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const wanted = key ? key.split(',') : []
    if (!firebaseEnabled || wanted.length === 0) {
      setRows([])
      setLoading(false)
      return
    }
    setLoading(true)
    const store = getDb()
    const groups = chunk(wanted)
    const byGroup = new Map<number, T[]>()
    const unsubs = groups.map((group, i) =>
      onSnapshot(
        query(collection(store, collectionName), where(field, 'in', group), fbLimit(max)),
        (snap) => {
          byGroup.set(
            i,
            snap.docs.map((d) => ({ ...(d.data() as T), id: d.id })),
          )
          setRows(
            Array.from(byGroup.values())
              .flat()
              .filter((r) => !r.deletedAt),
          )
          setLoading(false)
          setError(null)
        },
        (err) => {
          console.warn(`[${collectionName}] where-in`, err)
          setError(err.message)
          setLoading(false)
        },
      ),
    )
    return () => unsubs.forEach((u) => u())
  }, [collectionName, field, key, max])

  return { rows, loading, error }
}

/**
 * How many documents match, without reading them.
 *
 * A count aggregation bills far less than fetching the rows, which is what the
 * Hold-defect badge needs: the number, not the defects.
 */
export function useCount(
  collectionName: string,
  constraints: QueryConstraint[],
  deps: unknown[],
): { count: number; loading: boolean } {
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const memo = useMemo(() => constraints, deps)

  useEffect(() => {
    if (!firebaseEnabled) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    getCountFromServer(query(collection(getDb(), collectionName), ...memo))
      .then((snap) => {
        if (cancelled) return
        setCount(snap.data().count)
        setLoading(false)
      })
      .catch((err) => {
        console.warn(`[${collectionName}] count`, err)
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [collectionName, memo])

  return { count, loading }
}

export { EMPTY as emptyCollectionState }
