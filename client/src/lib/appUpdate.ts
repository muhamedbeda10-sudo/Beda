// ============================================================================
// A new version of the app waits for the person to finish what they are typing.
//
// Each deploy used to swap the new version in and reload every open window at
// once — on a tablet halfway through a sample, or with a quantity typed into a
// dialog, that took what was on the screen with it. A screen with unsaved
// work holds the update while it is open (an open wizard, a dialog with
// something typed in it); the update is applied as soon as the last such
// screen lets go — the person saves, or moves on — and at once when nothing is
// held. Until then the new version waits in the background and the old one
// keeps running whole: its own files are still served, so nothing it loads
// goes missing. (A version another tab swapped in reloads this one only on the
// same terms; any file of the old version then missing is mended by the
// error boundary's reload — components/ui/ErrorBoundary.tsx.)
// ============================================================================

import { useEffect } from 'react'

export interface UpdateGate {
  /** Holds updates back until the returned release is called (once; later calls do nothing). */
  hold(): () => void
  /** Whether something is held now. */
  readonly held: boolean
  /** Runs `apply` now when nothing is held, or when the last hold is released; a later request replaces one still waiting. */
  whenFree(apply: () => void): void
}

export function createUpdateGate(): UpdateGate {
  const holds = new Set<symbol>()
  let waiting: (() => void) | null = null
  const settle = () => {
    if (holds.size > 0 || !waiting) return
    const apply = waiting
    waiting = null
    apply()
  }
  return {
    hold() {
      const token = Symbol('unsaved work')
      holds.add(token)
      return () => {
        if (holds.delete(token)) settle()
      }
    },
    get held() {
      return holds.size > 0
    },
    whenFree(apply) {
      waiting = apply
      settle()
    },
  }
}

/** The app's one gate: main.tsx applies updates through it, screens with unsaved work hold it. */
export const appUpdates = createUpdateGate()

/** Holds the app's updates while `unsaved` is true and the screen is open. */
export function useHoldUpdates(unsaved: boolean): void {
  useEffect(() => (unsaved ? appUpdates.hold() : undefined), [unsaved])
}
