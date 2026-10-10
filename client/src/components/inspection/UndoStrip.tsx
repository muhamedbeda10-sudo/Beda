// ============================================================================
// Taking something back. A row, a defect or a photo removed in the wizard goes
// at once — no question in the way of a quick inspector — and the place it
// left says so for a few seconds with an Undo beside it, so a slip of a gloved
// finger costs a tap, not the measurement or the photos that went with it.
// The app's toasts carry a message only, so the offer sits in the page, where
// the eye already is.
// ============================================================================

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Undo2 } from 'lucide-react'

/** How long a removal can be taken back. */
export const UNDO_MS = 6000

/** `list` with `item` put back at `index`, or at the end when the list has since become shorter. */
export function insertAt<T>(list: readonly T[], item: T, index: number): T[] {
  const at = Math.max(0, Math.min(index, list.length))
  return [...list.slice(0, at), item, ...list.slice(at)]
}

/** What was removed, where it stood, and what to call it in the strip. */
export interface Removed<T> {
  /** Changes with every removal, so a strip restarts its countdown. */
  id: number
  /** "Width removed": a name the inspector typed goes in a <bdi>, so Arabic keeps its own direction. */
  label: ReactNode
  item: T
  index: number
}

/**
 * One removal that can still be taken back. A second removal while the first
 * is on offer makes the first final: one strip, about the latest.
 */
export function useUndo<T>(ms = UNDO_MS) {
  const [removed, setRemoved] = useState<Removed<T> | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seq = useRef(0)
  const stop = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => stop, [])

  /** Offers `item`, removed from `index`, back for `ms`. */
  const offer = useCallback(
    (label: ReactNode, item: T, index: number) => {
      stop()
      seq.current += 1
      setRemoved({ id: seq.current, label, item, index })
      timer.current = setTimeout(() => setRemoved(null), ms)
    },
    [ms],
  )
  /** Ends the offer: after an Undo, or when what it would restore is gone with its parent. */
  const clear = useCallback(() => {
    stop()
    setRemoved(null)
  }, [])

  return { removed, offer, clear }
}

/**
 * "Width removed · Undo", in the place the row left. A thin bar runs down the
 * time left to take it back. The words are announced politely, so a screen
 * reader hears what went and that it can come back.
 */
export function UndoStrip({ label, onUndo, ms = UNDO_MS }: { label: ReactNode; onUndo: () => void; ms?: number }) {
  // The bar starts full and shrinks once it is on screen, as a CSS transition over the time left.
  const [running, setRunning] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setRunning(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  return (
    <div
      role="status"
      className="relative flex min-h-[48px] items-center justify-between gap-2 overflow-hidden rounded-xl border border-dashed border-slate-300 bg-slate-50 ps-3 text-sm text-slate-600 animate-fade-in dark:border-slate-600 dark:bg-slate-800/60 dark:text-slate-300"
    >
      <span className="min-w-0 truncate">{label}</span>
      <button
        type="button"
        onClick={onUndo}
        className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-xl px-3 font-bold text-brand-700 hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-brand-300 dark:hover:bg-brand-500/10"
      >
        <Undo2 className="h-4 w-4" /> Undo
      </button>
      <span
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-brand-500/60 ease-linear"
        style={{ transform: running ? 'scaleX(0)' : 'scaleX(1)', transitionProperty: 'transform', transitionDuration: `${ms}ms` }}
      />
    </div>
  )
}
