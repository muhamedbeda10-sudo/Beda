// ============================================================================
// A sheet from the bottom of the screen, for a message's actions and its
// emoji: drawn over the page (a portal, so no frame of the thread clips or
// moves it), above the home indicator, on a dimmed backdrop. A tap on the
// backdrop closes it — one that began there, not the lift of the long press
// that opened it — as does Escape. From 640 px it floats, narrower, a margin
// above the bottom edge.
// ============================================================================

import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn, lockBodyScroll } from '@/lib/utils'

export function ChatSheet({ label, onClose, header, children, className }: { label: string; onClose: () => void; header?: ReactNode; children: ReactNode; className?: string }) {
  const panel = useRef<HTMLDivElement>(null)
  const armed = useRef(false)
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    // Focus moves into the sheet, so a keyboard and a screen reader are where the actions are, and goes back after.
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      close.current()
    }
    document.addEventListener('keydown', onKey)
    const unlock = lockBodyScroll()
    return () => {
      document.removeEventListener('keydown', onKey)
      unlock()
      if (before?.isConnected) before.focus({ preventScroll: true })
    }
  }, [])

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:p-4">
      <div
        className="absolute inset-0 bg-slate-900/40 animate-fade-in"
        onPointerDown={(e) => {
          armed.current = e.target === e.currentTarget
        }}
        onClick={(e) => {
          const ok = armed.current && e.target === e.currentTarget
          armed.current = false
          if (ok) close.current()
        }}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={cn(
          'relative z-10 flex max-h-sheet w-full flex-col overflow-hidden rounded-t-3xl bg-white shadow-lift ring-1 ring-slate-200 animate-slide-up focus:outline-none dark:bg-slate-900 dark:ring-slate-800 sm:max-w-md sm:rounded-3xl safe-bottom',
          className,
        )}
      >
        <span aria-hidden className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-slate-200 dark:bg-slate-700 sm:hidden" />
        {header}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
