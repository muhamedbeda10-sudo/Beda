// ============================================================================
// A strip wider than the screen, scrolled sideways inside its own frame: a
// table on a phone, a row of tabs or chips. The frame is a positioned box, so
// whatever inside it is placed absolutely — Tailwind's `sr-only` text in a
// header cell, a badge's hidden words — is clipped by the frame instead of
// stretching the page sideways (a phone then zooms out to fit it, a tablet
// grows a page scrollbar, and fixed layers such as the toasts centre on the
// widened page). A soft shadow at either end says there is more that way, and
// only while there is.
// ============================================================================

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { cn } from '@/lib/utils'

/** Which ends of a strip have content scrolled out of view. `start` and `end` follow the text's direction. */
export interface ScrollEdges {
  /** Content is hidden before the visible part: at the left, or at the right in a right-to-left strip. */
  start: boolean
  /** Content is hidden after it. */
  end: boolean
  /** The strip runs right to left. */
  rtl: boolean
}

const NONE: ScrollEdges = { start: false, end: false, rtl: false }

/**
 * The ends a strip hides, from its scroll position. Browsers put a strip's
 * start at scrollLeft 0 in both directions, counting up (left to right) or
 * down (right to left) towards its end; a pixel of slack absorbs the rounding
 * of a zoomed screen.
 */
export function edgesOf({ scrollLeft, scrollWidth, clientWidth }: { scrollLeft: number; scrollWidth: number; clientWidth: number }): { start: boolean; end: boolean } {
  const range = scrollWidth - clientWidth
  if (range <= 1) return { start: false, end: false }
  const from = Math.abs(scrollLeft)
  return { start: from > 1, end: from < range - 1 }
}

/**
 * Follows a horizontal scroller: which of its ends hide content, updated as
 * it scrolls, as it or its content changes size, and as children come and go.
 * For a strip that cannot be wrapped in <ScrollX> — a tab list, the wizard's
 * step rail — draw <EdgeShadows {...edges} /> in a positioned parent.
 */
export function useScrollEdges(ref: RefObject<HTMLElement>): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>(NONE)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let frame = 0
    const measure = () => {
      frame = 0
      const { start, end } = edgesOf(el)
      const rtl = getComputedStyle(el).direction === 'rtl'
      // The same answer draws nothing again: a scroll fires many times a second.
      setEdges((prev) => (prev.start === start && prev.end === end && prev.rtl === rtl ? prev : { start, end, rtl }))
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measure()
    el.addEventListener('scroll', schedule, { passive: true })
    // The frame changes width with the window; the content with its data. Both move the ends.
    const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null
    const observeAll = () => {
      if (!resize) return
      resize.disconnect()
      resize.observe(el)
      for (const child of Array.from(el.children)) resize.observe(child)
    }
    observeAll()
    const children =
      typeof MutationObserver !== 'undefined'
        ? new MutationObserver(() => {
            observeAll()
            schedule()
          })
        : null
    children?.observe(el, { childList: true })
    return () => {
      if (frame) cancelAnimationFrame(frame)
      el.removeEventListener('scroll', schedule)
      resize?.disconnect()
      children?.disconnect()
    }
  }, [ref])
  return edges
}

/**
 * The two shadows that say a strip goes on: drawn over its ends, inside a
 * positioned parent that does not scroll with it. Purely visual — hidden from
 * screen readers and from the pointer.
 */
export function EdgeShadows({ start, end, rtl, className }: ScrollEdges & { className?: string }) {
  const left = rtl ? end : start
  const right = rtl ? start : end
  const base = 'pointer-events-none absolute inset-y-0 z-[2] w-6 from-black/10 to-transparent transition-opacity duration-150 dark:from-black/40'
  return (
    <>
      <span aria-hidden className={cn(base, 'left-0 bg-gradient-to-r', left ? 'opacity-100' : 'opacity-0', className)} />
      <span aria-hidden className={cn(base, 'right-0 bg-gradient-to-l', right ? 'opacity-100' : 'opacity-0', className)} />
    </>
  )
}

/**
 * A horizontal scroller with its edge shadows. `className` styles the outer
 * box (margins, a card's rounding); `innerClassName` the scrolling frame
 * (a max height, its own padding). With a `label` the frame is a named region
 * a keyboard can reach and scroll with the arrow keys.
 *
 * The frame says which ends hide content in `data-overflow-start` and
 * `data-overflow-end`, so CSS can follow it: a table's sticky first or last
 * column (`.table-sticky-first`, `.table-sticky-last` in index.css) casts its
 * shadow only while rows run under it. Such a column draws its own edge, so
 * `shadows` then leaves that end out: 'end' beside a sticky first column,
 * 'start' beside a sticky last one.
 */
export function ScrollX({
  children,
  className,
  innerClassName,
  label,
  shadows = 'both',
}: {
  children: ReactNode
  className?: string
  innerClassName?: string
  label?: string
  shadows?: 'both' | 'start' | 'end' | 'none'
}) {
  const frame = useRef<HTMLDivElement>(null)
  const edges = useScrollEdges(frame)
  return (
    <div className={cn('relative', className)}>
      <div
        ref={frame}
        role={label ? 'region' : undefined}
        aria-label={label}
        tabIndex={label ? 0 : undefined}
        data-overflow-start={edges.start || undefined}
        data-overflow-end={edges.end || undefined}
        className={cn('relative overflow-x-auto overscroll-x-contain', label && 'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500', innerClassName)}
      >
        {children}
      </div>
      {shadows !== 'none' && <EdgeShadows rtl={edges.rtl} start={edges.start && shadows !== 'end'} end={edges.end && shadows !== 'start'} />}
    </div>
  )
}
