// ============================================================================
// Table density: Comfortable (44 px rows, for touch) or Compact (34 px rows,
// to see more of a list at once). Kept on this device, like the other view
// settings, and set on <html> so every table follows it through `--row-h`.
// ============================================================================

import { useEffect } from 'react'
import { usePersistedState } from './usePersistedState'

export type Density = 'comfortable' | 'compact'

const KEY = 'qc:density'

/** The density in use, and a way to change it. */
export function useDensity(): [Density, (next: Density) => void] {
  const [density, setDensity] = usePersistedState<Density>(KEY, 'comfortable')
  useEffect(() => {
    document.documentElement.dataset.density = density
  }, [density])
  return [density, setDensity]
}
