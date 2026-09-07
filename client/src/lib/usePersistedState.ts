import { useCallback, useState } from 'react'

/**
 * React state that survives reloads on this device, for the small choices a
 * tablet on the floor should not have to make again every shift: which
 * factory tab, which machine, which groups are folded. Storage failures
 * (private mode, full quota) fall back to plain in-memory state.
 */
export function usePersistedState<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? initial : (JSON.parse(raw) as T)
    } catch {
      return initial
    }
  })
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next
        try {
          localStorage.setItem(key, JSON.stringify(resolved))
        } catch {
          // Keep working in memory.
        }
        return resolved
      })
    },
    [key],
  )
  return [value, set]
}
