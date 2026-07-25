// ============================================================================
// Live Firestore reads for the screens.
//
// Everything the inspector sees is a realtime subscription, so two people
// working the same line see each other's samples appear without refreshing.
// Soft-deleted records are filtered out here, in one place, so no screen can
// accidentally show evidence that was marked deleted.
// ============================================================================

import { useEffect, useMemo, useState } from 'react'
import { collection, onSnapshot, query, where, type QueryConstraint } from 'firebase/firestore'
import { getDb, firebaseEnabled } from '@/lib/firebase'

export interface CollectionState<T> {
  rows: T[]
  loading: boolean
  error: string | null
}

/**
 * Subscribe to a collection. `constraints` must be memoised by the caller (or
 * expressed via `deps`) — a fresh array each render would resubscribe forever.
 */
export function useCollection<T extends { id: string; deletedAt?: string | null }>(
  collectionName: string,
  constraints: QueryConstraint[] = [],
  deps: unknown[] = [],
  options: { includeDeleted?: boolean } = {},
): CollectionState<T> {
  const [rows, setRows] = useState<T[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const includeDeleted = options.includeDeleted ?? false

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const memoConstraints = useMemo(() => constraints, deps)

  useEffect(() => {
    if (!firebaseEnabled) {
      setLoading(false)
      return
    }
    setLoading(true)
    const q = query(collection(getDb(), collectionName), ...memoConstraints)
    const unsub = onSnapshot(
      q,
      (snap) => {
        const all = snap.docs.map((d) => ({ ...(d.data() as T), id: d.id }))
        setRows(includeDeleted ? all : all.filter((r) => !r.deletedAt))
        setLoading(false)
        setError(null)
      },
      (err) => {
        console.warn(`[${collectionName}]`, err)
        setError(err.message)
        setLoading(false)
      },
    )
    return () => unsub()
  }, [collectionName, memoConstraints, includeDeleted])

  return { rows, loading, error }
}

/** Convenience for the common "all rows in a collection" case. */
export function useAll<T extends { id: string; deletedAt?: string | null }>(
  collectionName: string,
): CollectionState<T> {
  return useCollection<T>(collectionName, [], [collectionName])
}

/** Rows matching a single equality filter. */
export function useWhere<T extends { id: string; deletedAt?: string | null }>(
  collectionName: string,
  field: string,
  value: string | number | boolean | null | undefined,
): CollectionState<T> {
  const enabled = value !== undefined && value !== null && value !== ''
  const constraints = useMemo(
    () => (enabled ? [where(field, '==', value)] : []),
    [field, value, enabled],
  )
  const state = useCollection<T>(collectionName, constraints, [collectionName, field, value])
  return enabled ? state : { rows: [], loading: false, error: null }
}
