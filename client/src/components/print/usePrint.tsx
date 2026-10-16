// ============================================================================
// Printing one thing on its own — an answer of the assistant, a saved report,
// a delivered report — with the browser's own print, as the dashboard prints
// (its Save as PDF makes the file). What is printed is drawn into a root of
// its own under <body>: off the screen, at the paper's width (A4 standing),
// so its charts measure it before the browser prints; and alone on the
// paper, the app (the assistant's window among it) left off. Paper is light:
// the dark theme steps aside while the browser prints, and comes back after.
//
// A report handed on is known by its name: while it prints, the page's title
// is the report's (with its day), which is the name the browser gives the
// PDF; and every page carries the company and the report at its foot, with
// its number of the whole ("Page 2 of 5"). What still loads (its photos,
// fetched in full) marks itself pending (PRINT_PENDING_ATTR): the browser
// prints once nothing is, or after PENDING_WAIT_MS whatever is left.
// ============================================================================

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Loader2 } from 'lucide-react'

/** On <body> while something is printed on its own: index.css leaves everything else off the paper. */
export const PRINTING_CLASS = 'printing'

/** On what is still loading in what is printed (a photo fetched in full): the browser prints once none is left. */
export const PRINT_PENDING_ATTR = 'data-print-pending'

/** Frames given to what is printed before the browser prints it: one to lay it out, one for its charts to draw at its width. */
const SETTLE_FRAMES = 2
/** The longest the print waits for what is still loading: a photo that never comes is printed without. */
export const PENDING_WAIT_MS = 20_000
const PENDING_POLL_MS = 100

/** Who the paper is from, at the foot of every page. */
export const PRINT_COMPANY = 'LinkMisr · Quality Control'

export interface PrintOptions {
  /** The report's name: the PDF's file name, and the foot of every page. */
  title: string
  /** Its day (YYYY-MM-DD), after the name in the file's: a daily report's files tell apart. */
  day?: string
}

/** The file name the browser gives the PDF (from the page's title): the report's name and day, without the marks a file name cannot hold. */
export function printFileName(o: PrintOptions): string {
  const name = o.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120).trim() || 'Report'
  return o.day ? `${name} ${o.day}` : name
}

/** Text as a CSS string, quotes and line breaks escaped. */
const cssString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`

/** The paper: A4 standing, its margins, and at the foot of each page the company with the report's name, and the page's number. */
export function pageRules(o: PrintOptions): string {
  const name = o.title.replace(/\s+/g, ' ').trim()
  const foot = name.length > 90 ? `${name.slice(0, 89).trimEnd()}…` : name
  const box = 'font-family: Inter, "IBM Plex Sans Arabic", system-ui, sans-serif; font-size: 7.5pt; color: #64748b;'
  return `@media print {
  @page {
    size: A4 portrait;
    margin: 14mm 12mm 16mm 12mm;
    @bottom-left { content: ${cssString(foot ? `${PRINT_COMPANY} — ${foot}` : PRINT_COMPANY)}; ${box} }
    @bottom-right { content: "Page " counter(page) " of " counter(pages); ${box} }
  }
}`
}

export interface Printer {
  /** Prints `doc`: laid out for paper (PrintSheet), alone, under the report's name. */
  print: (doc: ReactNode, options: PrintOptions) => void
  /** Drawn somewhere in the caller's tree (anywhere: it goes under <body>), so what is printed keeps the app's context. */
  node: ReactNode
}

export function usePrint(): Printer {
  const [job, setJob] = useState<{ doc: ReactNode; options: PrintOptions } | null>(null)
  const [waiting, setWaiting] = useState(false)

  useEffect(() => {
    if (job === null) return
    const html = document.documentElement
    const dark = html.classList.contains('dark')
    const title = document.title
    const page = document.createElement('style')
    page.setAttribute('data-print-page', '')
    page.textContent = pageRules(job.options)
    let ended = false
    let timer = 0
    const restore = () => {
      document.body.classList.remove(PRINTING_CLASS)
      if (dark) html.classList.add('dark')
      document.title = title
      page.remove()
    }
    const end = () => {
      if (ended) return
      ended = true
      restore()
      setWaiting(false)
      setJob(null)
    }
    if (dark) html.classList.remove('dark')
    document.body.classList.add(PRINTING_CLASS)
    document.head.appendChild(page)
    document.title = printFileName(job.options)
    window.addEventListener('afterprint', end)
    // A browser that never says it printed: the next touch on the page ends it.
    const touched = () => window.setTimeout(end, 0)
    const started = Date.now()
    const pending = () => document.querySelector(`.print-root [${PRINT_PENDING_ATTR}]`) !== null
    const go = async () => {
      // Its typefaces, so the words keep the size their boxes were made for.
      await document.fonts?.ready.catch(() => undefined)
      if (ended) return
      window.print()
      window.addEventListener('pointerdown', touched, { once: true })
    }
    const waitForPending = () => {
      if (ended) return
      if (pending() && Date.now() - started < PENDING_WAIT_MS) {
        setWaiting(true)
        timer = window.setTimeout(waitForPending, PENDING_POLL_MS)
        return
      }
      setWaiting(false)
      void go()
    }
    let frame = 0
    let left = SETTLE_FRAMES
    const settle = () => {
      if (--left > 0) {
        frame = requestAnimationFrame(settle)
        return
      }
      waitForPending()
    }
    frame = requestAnimationFrame(settle)
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(timer)
      window.removeEventListener('afterprint', end)
      window.removeEventListener('pointerdown', touched)
      if (!ended) {
        ended = true
        restore()
      }
    }
  }, [job])

  const print = useCallback((doc: ReactNode, options: PrintOptions) => setJob({ doc, options }), [])
  const node =
    job === null || typeof document === 'undefined' ? null : (
      <>
        {createPortal(<div className="print-root">{job.doc}</div>, document.body)}
        {waiting &&
          createPortal(
            <div role="status" className="fixed inset-x-0 bottom-6 z-[100] flex justify-center">
              <span className="inline-flex items-center gap-2 rounded-full bg-slate-900/90 px-4 py-2 text-13 font-semibold text-white shadow-lift">
                <Loader2 className="h-4 w-4 animate-spin" /> Preparing the print…
              </span>
            </div>,
            document.body,
          )}
      </>
    )
  return { print, node }
}
