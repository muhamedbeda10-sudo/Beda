// ============================================================================
// One action at a time, for a button that writes something.
//
// A disabled button is drawn only after React renders again; a second tap
// that lands first — a gloved finger, a slow tablet — runs the action twice:
// two closes, two discards, a sample saved and then refused. The guard here
// is set the instant the action starts, so the second tap finds it taken.
// A failure is kept as a message for the dialog to show where it happened;
// the dialog stays open with what was typed in it.
// ============================================================================

import { useCallback, useRef, useState } from 'react'
import { ApiError } from './api'

/** A latch: `run` starts the work unless work started by it is still running. */
export function singleFlight() {
  let running = false
  return {
    get running() {
      return running
    },
    /** The work's result, or undefined when it did not run because another was under way. */
    async run<T>(work: () => Promise<T>): Promise<T | undefined> {
      if (running) return undefined
      running = true
      try {
        return await work()
      } finally {
        running = false
      }
    },
  }
}

/** What a failure says to the person: the server's own words, or the fallback. */
export function failureMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.status === 0 ? 'Network error — check your connection.' : e.message
  return e instanceof Error && e.message ? e.message : fallback
}

/**
 * Runs the work through the latch, saying when it is busy and why it failed
 * (null as it starts). Resolves true when it finished without throwing; false
 * when it failed — the caller's dialog stays open with the message — or did
 * not run because another was under way.
 */
export async function guarded(
  flight: ReturnType<typeof singleFlight>,
  work: () => Promise<void>,
  fallback: string,
  setBusy: (busy: boolean) => void,
  setError: (error: string | null) => void,
): Promise<boolean> {
  const done = await flight.run(async () => {
    setBusy(true)
    setError(null)
    try {
      await work()
      return true
    } catch (e) {
      setError(failureMessage(e, fallback))
      return false
    } finally {
      setBusy(false)
    }
  })
  return done === true
}

/**
 * `run(work, fallback)` runs the work once at a time; `busy` is true while it
 * does, and `error` holds why it last failed (cleared when it runs again).
 * Resolves true when the work finished without throwing.
 */
export function useBusyAction() {
  const flight = useRef(singleFlight()).current
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = useCallback((work: () => Promise<void>, fallback: string) => guarded(flight, work, fallback, setBusy, setError), [flight])
  return { busy, error, run, clearError: useCallback(() => setError(null), []) }
}
