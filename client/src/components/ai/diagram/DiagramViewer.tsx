// ============================================================================
// §20 — a diagram on the whole screen, to read a large one on a tablet: pinch
// or wheel to zoom, drag to move, double-tap to zoom in or back to the whole,
// the buttons for both, Escape or Close to put it away. Like the photo
// viewer (§10.7): touch and mouse go through the same pointer events. It
// opens fitted to the screen; a box's link still opens its page, but only
// on a tap, never at the end of a drag.
// ============================================================================

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent as ReactWheelEvent } from 'react'
import { createPortal } from 'react-dom'
import { Scan, X, ZoomIn, ZoomOut } from 'lucide-react'
import { lockBodyScroll } from '@/lib/utils'

/** How far in a diagram may be zoomed, past its own size; how far out, below fitting the screen. */
const MAX_ZOOM = 4
const MIN_OF_FIT = 0.5
const TAP_SLOP = 10
const STEP = 1.4

interface Point {
  x: number
  y: number
}

/** The scale and the offset (from the stage's top left, in screen px) the diagram is drawn at. */
interface View {
  scale: number
  x: number
  y: number
}

export function DiagramViewer({ width, height, title, onClose, children }: { width: number; height: number; title: string; onClose: () => void; children: ReactNode }) {
  const stage = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View | null>(null)
  const [smooth, setSmooth] = useState(false)
  const fit = useRef(1)
  const pointers = useRef(new Map<number, Point>())
  const gesture = useRef<{ view: View; distance: number; middle: Point; start: Point; moved: boolean } | null>(null)
  const lastTap = useRef<{ at: number; x: number; y: number } | null>(null)
  /** A drag just ended: the click that follows it opens nothing. */
  const dragged = useRef(false)

  /** The whole diagram, centred on the stage. */
  const fitted = useCallback((): View => {
    const box = stage.current?.getBoundingClientRect()
    if (!box) return { scale: 1, x: 0, y: 0 }
    const scale = Math.min(1.5, (box.width - 24) / width, (box.height - 24) / height)
    fit.current = scale
    return { scale, x: (box.width - width * scale) / 2, y: (box.height - height * scale) / 2 }
  }, [width, height])

  useLayoutEffect(() => setView(fitted()), [fitted])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const unlock = lockBodyScroll()
    const onResize = () => setView(fitted())
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
      unlock()
    }
  }, [fitted, onClose])

  /** Zoom to `next`, keeping the point under `at` (screen px) where it is. */
  const zoomAt = useCallback((v: View, next: number, at: Point): View => {
    const box = stage.current?.getBoundingClientRect()
    const scale = Math.min(MAX_ZOOM, Math.max(fit.current * MIN_OF_FIT, next))
    const px = at.x - (box?.left ?? 0)
    const py = at.y - (box?.top ?? 0)
    const f = scale / v.scale
    return { scale, x: px - (px - v.x) * f, y: py - (py - v.y) * f }
  }, [])

  const centre = (): Point => {
    const box = stage.current?.getBoundingClientRect()
    return box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : { x: 0, y: 0 }
  }

  const positions = () => Array.from(pointers.current.values())
  const begin = (v: View) => {
    const p = positions()
    gesture.current = {
      view: v,
      distance: p.length > 1 ? Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) : 0,
      middle: p.length > 1 ? { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 } : p[0],
      start: p[0],
      moved: gesture.current?.moved ?? false,
    }
  }

  const onPointerDown = (e: ReactPointerEvent) => {
    if (!view || (e.pointerType === 'mouse' && e.button !== 0)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 1) dragged.current = false
    setSmooth(false)
    begin(view)
  }

  const onPointerMove = (e: ReactPointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const g = gesture.current
    if (!g) return
    const p = positions()
    if (p.length > 1) {
      // Two fingers: their distance sets the scale, their middle carries the diagram.
      const middle = { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 }
      const zoomed = zoomAt(g.view, (g.view.scale * Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y)) / (g.distance || 1), g.middle)
      g.moved = true
      setView({ ...zoomed, x: zoomed.x + middle.x - g.middle.x, y: zoomed.y + middle.y - g.middle.y })
      return
    }
    const dx = p[0].x - g.start.x
    const dy = p[0].y - g.start.y
    if (!g.moved && Math.hypot(dx, dy) <= TAP_SLOP) return
    // Captured once it is a drag, not before: a tap on a link stays a click on it.
    if (!g.moved) {
      try {
        stage.current?.setPointerCapture(e.pointerId)
      } catch {
        /* not capturable */
      }
    }
    g.moved = true
    setView({ ...g.view, x: g.view.x + dx, y: g.view.y + dy })
  }

  const onPointerUp = (e: ReactPointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return
    const g = gesture.current
    if (pointers.current.size > 0 && view) {
      // A finger lifted mid-pinch: carry on from the others.
      begin(view)
      return
    }
    gesture.current = null
    if (!g || !view) return
    if (g.moved) {
      dragged.current = true
      return
    }
    const at = { x: e.clientX, y: e.clientY }
    const previous = lastTap.current
    if (previous && Date.now() - previous.at < 300 && Math.hypot(at.x - previous.x, at.y - previous.y) < 40) {
      lastTap.current = null
      setSmooth(true)
      setView(view.scale > fit.current * 1.05 ? fitted() : zoomAt(view, view.scale * 2, at))
      return
    }
    lastTap.current = { at: Date.now(), ...at }
  }

  const onWheel = (e: ReactWheelEvent) => {
    if (!view) return
    setSmooth(false)
    setView(zoomAt(view, view.scale * Math.exp(-e.deltaY * 0.0015), { x: e.clientX, y: e.clientY }))
  }

  /** A button's step in or out, about the middle of the screen. */
  const zoomBy = (factor: number) => {
    if (!view) return
    setSmooth(true)
    setView(zoomAt(view, view.scale * factor, centre()))
  }

  const button = 'grid h-11 w-11 place-items-center rounded-xl text-slate-700 transition-colors hover:bg-slate-200/70 active:bg-slate-300/70 disabled:opacity-40 dark:text-slate-200 dark:hover:bg-slate-700/70'
  const zoom = view ? Math.round((view.scale / fit.current) * 100) : 100

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={title} className="ai-type fixed inset-0 z-[60] flex flex-col bg-slate-100 animate-fade-in dark:bg-slate-950">
      <div className="flex items-center gap-2 border-b border-slate-200 bg-white/90 px-2 py-1.5 safe-top dark:border-slate-800 dark:bg-slate-900/90">
        <p dir="auto" className="min-w-0 flex-1 truncate ps-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
          {title}
        </p>
        <div className="flex shrink-0 items-center gap-0.5">
          <button type="button" className={button} onClick={() => zoomBy(1 / STEP)} aria-label="Zoom out">
            <ZoomOut className="h-5 w-5" />
          </button>
          <span className="min-w-[3rem] text-center text-xs font-semibold tabular-nums text-muted">{zoom}%</span>
          <button type="button" className={button} onClick={() => zoomBy(STEP)} aria-label="Zoom in">
            <ZoomIn className="h-5 w-5" />
          </button>
          <button
            type="button"
            className={button}
            onClick={() => {
              setSmooth(true)
              setView(fitted())
            }}
            aria-label="Fit to the screen"
            data-tip="Fit to the screen"
          >
            <Scan className="h-5 w-5" />
          </button>
          <button type="button" className={button} onClick={onClose} aria-label="Close">
            <X className="h-6 w-6" />
          </button>
        </div>
      </div>
      <div
        ref={stage}
        className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onClickCapture={(e) => {
          // The click at the end of a drag opens nothing.
          if (dragged.current) {
            e.preventDefault()
            e.stopPropagation()
            dragged.current = false
          }
        }}
      >
        {view && (
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{ width, height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transition: smooth ? 'transform 180ms ease-out' : undefined }}
          >
            {children}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
