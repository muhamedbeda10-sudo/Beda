// §20 — the door to the AI assistant: a round button floating over every page, in the bottom corner to begin with
// (index.css: .ai-fab, above any bar along the bottom). It is the person's to move: dragged with a mouse or a
// finger, it stays where it was dropped, on this device, across pages and reloads (fabPlace); dropped back in its
// corner it goes back to following the bottom bar. A press without a drag opens the popup where it was left; while
// the popup is open the button steps aside for it. It pulses while an answer is being written, so a person who
// closed the popup sees it is busy: the one this device reads, or else one going on on the server (the page
// reloaded meanwhile, or the stream let go of), as the list of conversations says — asked again every few seconds
// while it says so.

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { Bot } from 'lucide-react'
import { useAiConversations } from '@/services/queries'
import { useAi } from './AiAssistantProvider'

/** Where the button was dropped: how far its right and bottom edges are from the window's. */
export interface FabPlace {
  right: number
  bottom: number
}

const PLACE_KEY = 'ai-fab-place'
/** A press that travels less than this is a press, not a drag. */
const DRAG_START = 6
/** The least of the button kept on screen, in px from the window's edges. */
const EDGE = 4
/** Dropped this close to its corner, the button goes back to its default place (following the bottom bar). */
const HOME = 36

function readPlace(): FabPlace | null {
  try {
    const raw = localStorage.getItem(PLACE_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<FabPlace>
    return typeof v.right === 'number' && typeof v.bottom === 'number' && Number.isFinite(v.right) && Number.isFinite(v.bottom) ? { right: v.right, bottom: v.bottom } : null
  } catch {
    return null
  }
}

function writePlace(place: FabPlace | null): void {
  try {
    if (place) localStorage.setItem(PLACE_KEY, JSON.stringify(place))
    else localStorage.removeItem(PLACE_KEY)
  } catch {
    // Kept for this page only.
  }
}

/** The place held on screen: the whole button within the window, whatever its size now. */
export function clampPlace(place: FabPlace, size: number, width = window.innerWidth, height = window.innerHeight): FabPlace {
  return {
    right: Math.min(Math.max(place.right, EDGE), Math.max(EDGE, width - size - EDGE)),
    bottom: Math.min(Math.max(place.bottom, EDGE), Math.max(EDGE, height - size - EDGE)),
  }
}

/** Whether a drop is close enough to the corner to count as putting the button back. */
export const nearHome = (place: FabPlace): boolean => place.right < HOME && place.bottom < HOME

interface Drag {
  id: number
  x: number
  y: number
  from: FabPlace
  moved: boolean
  last: FabPlace
}

export function AiButton() {
  const { open, setOpen, openAt, busy: reading, enabled } = useAi()
  const { data } = useAiConversations(enabled && !open && !reading)
  const busy = reading || !!data?.conversations.some((c) => c.answering)
  const [place, setPlace] = useState<FabPlace | null>(readPlace)
  const button = useRef<HTMLButtonElement>(null)
  const drag = useRef<Drag | null>(null)
  // The click that follows a drag's pointer-up is the drop, not a press.
  const dropped = useRef(false)

  // The window turning or shrinking (a tablet, a resized browser) keeps the button on screen.
  useEffect(() => {
    if (!place) return
    const keep = () => {
      const size = button.current?.offsetWidth || 56
      setPlace((p) => {
        if (!p) return p
        const next = clampPlace(p, size)
        if (next.right === p.right && next.bottom === p.bottom) return p
        writePlace(next)
        return next
      })
    }
    keep()
    window.addEventListener('resize', keep)
    return () => window.removeEventListener('resize', keep)
  }, [place])

  if (open) return null

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const el = e.currentTarget
    const r = el.getBoundingClientRect()
    const from = { right: window.innerWidth - r.right, bottom: window.innerHeight - r.bottom }
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, from, moved: false, last: from }
    el.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.moved && Math.hypot(dx, dy) < DRAG_START) return
    d.moved = true
    const el = e.currentTarget
    d.last = clampPlace({ right: d.from.right - dx, bottom: d.from.bottom - dy }, el.offsetWidth || 56)
    // Moved on the element itself while the finger is down: a render for every pointer event would lag behind it.
    el.style.right = `${d.last.right}px`
    el.style.bottom = `${d.last.bottom}px`
  }
  const endDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    drag.current = null
    const el = e.currentTarget
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
    if (!d.moved) return
    dropped.current = true
    el.style.right = ''
    el.style.bottom = ''
    const next = nearHome(d.last) ? null : d.last
    writePlace(next)
    setPlace(next)
  }
  const onClick = () => {
    if (dropped.current) {
      dropped.current = false
      return
    }
    // The owner without the assistant given to them has its settings alone: the button opens on them.
    if (enabled) setOpen(true)
    else openAt('/admin/ai', 'large')
  }

  const style: CSSProperties | undefined = place ? { right: place.right, bottom: place.bottom } : undefined
  return (
    <button
      ref={button}
      type="button"
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      style={style}
      className="ai-fab fixed z-40 grid h-14 w-14 cursor-grab touch-none select-none place-items-center rounded-full bg-gradient-to-br from-brand-600 to-brand-800 text-white shadow-lift ring-4 ring-white transition-transform duration-200 hover:scale-105 focus:outline-none focus-visible:ring-brand-300 active:cursor-grabbing active:scale-95 animate-fade-in print:hidden dark:ring-slate-900"
      aria-label={busy ? 'AI assistant, answering' : 'AI assistant'}
      aria-haspopup="dialog"
      aria-expanded={false}
      data-tip={busy ? 'AI assistant — answering…' : 'AI assistant — ask about the data. Drag to move the button.'}
    >
      <Bot className="h-7 w-7" />
      {busy && <span aria-hidden className="absolute right-0.5 top-0.5 h-3 w-3 animate-pulse rounded-full bg-accent-500 ring-2 ring-white dark:ring-slate-900" />}
    </button>
  )
}
