// ============================================================================
// Printing one thing on its own — an answer of the assistant, a saved report,
// a delivered report — with the browser's own print, as the dashboard prints
// (its Save as PDF makes the file). What is printed is drawn into a root of
// its own under <body>: off the screen, at the paper's width, so its charts
// measure it before the browser prints; and alone on the paper, the app (the
// assistant's window among it) left off. Paper is light: the dark theme steps
// aside while the browser prints, and comes back after.
// ============================================================================

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** On <body> while something is printed on its own: index.css leaves everything else off the paper. */
export const PRINTING_CLASS = 'printing'

/** Frames given to what is printed before the browser prints it: one to lay it out, one for its charts to draw at its width. */
const SETTLE_FRAMES = 2

export interface Printer {
  /** Prints `doc`: laid out for paper (PrintSheet), alone. */
  print: (doc: ReactNode) => void
  /** Drawn somewhere in the caller's tree (anywhere: it goes under <body>), so what is printed keeps the app's context. */
  node: ReactNode
}

export function usePrint(): Printer {
  const [doc, setDoc] = useState<ReactNode>(null)

  useEffect(() => {
    if (doc === null) return
    const html = document.documentElement
    const dark = html.classList.contains('dark')
    let ended = false
    const end = () => {
      if (ended) return
      ended = true
      document.body.classList.remove(PRINTING_CLASS)
      if (dark) html.classList.add('dark')
      setDoc(null)
    }
    if (dark) html.classList.remove('dark')
    document.body.classList.add(PRINTING_CLASS)
    window.addEventListener('afterprint', end)
    // A browser that never says it printed: the next touch on the page ends it.
    const touched = () => window.setTimeout(end, 0)
    let frame = 0
    let left = SETTLE_FRAMES
    const settle = () => {
      if (--left > 0) {
        frame = requestAnimationFrame(settle)
        return
      }
      window.print()
      window.addEventListener('pointerdown', touched, { once: true })
    }
    frame = requestAnimationFrame(settle)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('afterprint', end)
      window.removeEventListener('pointerdown', touched)
      if (!ended) {
        document.body.classList.remove(PRINTING_CLASS)
        if (dark) html.classList.add('dark')
      }
    }
  }, [doc])

  const print = useCallback((next: ReactNode) => setDoc(next), [])
  const node = doc === null || typeof document === 'undefined' ? null : createPortal(<div className="print-root">{doc}</div>, document.body)
  return { print, node }
}
