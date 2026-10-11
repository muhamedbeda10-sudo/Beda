// ============================================================================
// One tooltip for the whole application. An element says what its tooltip
// reads with `data-tip` (or is wrapped in <Tooltip>); a single layer mounted
// at the root shows it after a short pause under a mouse or pen, at once
// under keyboard focus, and on a long press of a finger, in the theme's
// colours. The browser's own `title` tooltip is not used anywhere: it ignores
// the theme, waits a second or more, and cannot be styled.
//
// The long press is a safety net, not a way in: a touch screen shows no
// tooltip until a finger rests on the element, so what a person needs to
// read is written on the page itself, and the tooltip only adds to it.
// ============================================================================

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { formatDate, formatDateTime, formatFullTimestamp } from '@/lib/utils'

/** How long a pointer rests on an element before its tooltip shows. */
const DELAY_MS = 300
/** How long a finger rests on an element before its tooltip shows instead of the tap. */
export const LONG_PRESS_MS = 500
/** How far a finger may drift during a long press before it counts as a scroll. */
export const LONG_PRESS_SLOP = 8
const TIP_ID = 'qc-tooltip'
const GAP = 6
const EDGE = 8

interface Shown {
  text: string
  /** The element's box when the tooltip opened. */
  rect: DOMRect
}

/** Wraps `children` so they carry a tooltip. Nothing is drawn when `content` is empty. */
export function Tooltip({ content, children, className }: { content: string | null | undefined; children: ReactNode; className?: string }) {
  if (!content) return <>{children}</>
  return (
    <span data-tip={content} className={className ?? 'inline-flex'}>
      {children}
    </span>
  )
}

/** Whether a finger that went down at `from` and is now at `to` has moved too far to be a long press. */
export function driftedTooFar(from: { x: number; y: number }, to: { x: number; y: number }): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) > LONG_PRESS_SLOP
}

/** The one tooltip layer. Mounted once, at the root of the application. */
export function TooltipLayer() {
  const [shown, setShown] = useState<Shown | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const target = useRef<Element | null>(null)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    // A finger resting on an element: where it went down, and the timer that shows the tooltip.
    let press: { id: number; x: number; y: number; timer: number } | null = null
    // A long press showed the tooltip: the click and the phone's menu that may follow the lift are swallowed, once.
    let swallow = false
    let swallowTimer: number | undefined
    const endPress = () => {
      if (press) window.clearTimeout(press.timer)
      press = null
    }
    const clear = () => {
      window.clearTimeout(timer.current)
      const t = target.current
      if (t && t.getAttribute('aria-describedby') === TIP_ID) t.removeAttribute('aria-describedby')
      target.current = null
      setShown(null)
      setPos(null)
    }
    const open = (el: Element, wait: number) => {
      const text = el.getAttribute('data-tip')
      if (!text) return
      window.clearTimeout(timer.current)
      target.current = el
      timer.current = window.setTimeout(() => {
        if (target.current !== el || !el.isConnected) return
        // Screen readers hear the tooltip as the element's description, as they did the title.
        if (!el.hasAttribute('aria-describedby')) el.setAttribute('aria-describedby', TIP_ID)
        setShown({ text, rect: el.getBoundingClientRect() })
      }, wait)
    }
    const tipOf = (e: Event) => (e.target instanceof Element ? e.target.closest('[data-tip]') : null)
    const over = (e: PointerEvent) => {
      // A finger has no hover: a tap is a tap, not a request for a tooltip.
      if (e.pointerType === 'touch') return
      const el = tipOf(e)
      if (el === target.current) return
      if (!el) return clear()
      open(el, DELAY_MS)
    }
    // Any press hides the tooltip showing; a finger held still on an element with one shows it.
    const down = (e: PointerEvent) => {
      clear()
      endPress()
      window.clearTimeout(swallowTimer)
      swallow = false
      if (e.pointerType !== 'touch' || !e.isPrimary) return
      const el = tipOf(e)
      if (!el) return
      press = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        timer: window.setTimeout(() => {
          press = null
          if (!el.isConnected) return
          swallow = true
          open(el, 0)
        }, LONG_PRESS_MS),
      }
    }
    const move = (e: PointerEvent) => {
      if (press && e.pointerId === press.id && driftedTooFar(press, { x: e.clientX, y: e.clientY })) endPress()
    }
    const up = (e: PointerEvent) => {
      if (press?.id === e.pointerId) endPress()
      // A click the lift may still send arrives straight after it; past that, a tap is a tap again.
      if (swallow) swallowTimer = window.setTimeout(() => (swallow = false), 400)
    }
    const swallowClick = (e: MouseEvent) => {
      if (!swallow) return
      swallow = false
      e.preventDefault()
      e.stopPropagation()
    }
    const menu = (e: MouseEvent) => {
      // The phone may answer the same long press with its own menu (or a text selection): the tooltip is the answer.
      if (press) {
        const el = tipOf(e)
        endPress()
        if (el) {
          swallow = true
          open(el, 0)
        }
      }
      if (swallow) e.preventDefault()
    }
    const out = (e: PointerEvent) => {
      // A finger leaves the element as it lifts: the tooltip a long press opened stays until the next press.
      if (e.pointerType === 'touch') return
      const el = tipOf(e)
      if (!el || el !== target.current) return
      const next = e.relatedTarget instanceof Element ? e.relatedTarget.closest('[data-tip]') : null
      if (next !== el) clear()
    }
    const focus = (e: FocusEvent) => {
      const el = tipOf(e)
      if (el && e.target instanceof Element && e.target.matches(':focus-visible')) open(el, 0)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clear()
    }
    const scrolled = () => {
      endPress()
      clear()
    }
    document.addEventListener('pointerover', over)
    document.addEventListener('pointerout', out)
    // Captured, so a press inside an element that stops its events still hides the tooltip and starts a long press.
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('pointermove', move, true)
    document.addEventListener('pointerup', up, true)
    document.addEventListener('pointercancel', up, true)
    window.addEventListener('click', swallowClick, true)
    window.addEventListener('contextmenu', menu, true)
    document.addEventListener('focusin', focus)
    document.addEventListener('focusout', clear)
    document.addEventListener('keydown', key)
    window.addEventListener('scroll', scrolled, true)
    window.addEventListener('resize', clear)
    return () => {
      window.clearTimeout(timer.current)
      window.clearTimeout(swallowTimer)
      endPress()
      document.removeEventListener('pointerover', over)
      document.removeEventListener('pointerout', out)
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('pointermove', move, true)
      document.removeEventListener('pointerup', up, true)
      document.removeEventListener('pointercancel', up, true)
      window.removeEventListener('click', swallowClick, true)
      window.removeEventListener('contextmenu', menu, true)
      document.removeEventListener('focusin', focus)
      document.removeEventListener('focusout', clear)
      document.removeEventListener('keydown', key)
      window.removeEventListener('scroll', scrolled, true)
      window.removeEventListener('resize', clear)
    }
  }, [])

  // Above the element, centred; below it when there is no room above; never past the window's edges.
  useEffect(() => {
    if (!shown || !tipRef.current) return
    const { width, height } = tipRef.current.getBoundingClientRect()
    const r = shown.rect
    const above = r.top - height - GAP
    const top = above >= EDGE ? above : Math.min(r.bottom + GAP, window.innerHeight - height - EDGE)
    const left = Math.max(EDGE, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - EDGE))
    setPos({ top, left })
  }, [shown])

  if (!shown) return null
  return createPortal(
    <div
      ref={tipRef}
      id={TIP_ID}
      role="tooltip"
      style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
      className="pointer-events-none z-[100] max-w-xs whitespace-pre-line rounded-md bg-slate-900 px-2 py-1 text-xs font-medium leading-snug text-white shadow-lg ring-1 ring-black/10 animate-fade-in dark:bg-slate-100 dark:text-slate-900 dark:ring-white/10"
    >
      {shown.text}
    </div>,
    document.body,
  )
}

/** A date or moment in the one format, with the full timestamp as its tooltip. */
export function When({ iso, time = false, className }: { iso?: string | null; time?: boolean; className?: string }) {
  if (!iso) return <span className={className}>—</span>
  return (
    <time dateTime={iso} data-tip={formatFullTimestamp(iso)} className={className}>
      {time ? formatDateTime(iso) : formatDate(iso)}
    </time>
  )
}
