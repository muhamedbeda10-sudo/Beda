// ============================================================================
// §20 — where the assistant's panel sits. On a desktop it docks at the right
// under the header and leaves the page usable beside it; below that it is a
// sheet over the page with a backdrop. This frame is small and always in the
// bundle; what fills it (the markdown renderer, the result tables) is fetched
// the first time it opens, so it never weighs on an inspector's phone.
// ============================================================================

import { lazy, Suspense, useEffect, useRef, type ReactNode } from 'react'
import { Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui'
import { ErrorBoundary, LoadFailed } from '@/components/ui/ErrorBoundary'
import { cn, lockBodyScroll } from '@/lib/utils'
import { useAi } from './AiAssistantProvider'

const AiPanel = lazy(() => import('./AiPanel'))

export function AiPanelHost() {
  const { enabled, open, setOpen } = useAi()
  if (!enabled || !open) return null
  return (
    <AiPanelFrame>
      {/* The panel's file not arriving (a deploy since the page opened, a dropped connection) leaves the page as it was. */}
      <ErrorBoundary
        fallback={
          <LoadFailed
            what="The assistant"
            action={
              <Button className="min-h-[44px]" onClick={() => setOpen(false)}>
                <X className="h-4 w-4" /> Close
              </Button>
            }
          />
        }
      >
        <Suspense
          fallback={
            <p className="flex flex-1 items-center justify-center gap-2 text-sm text-muted">
              <Loader2 className="h-4 w-4 animate-spin" /> Opening the assistant…
            </p>
          }
        >
          <AiPanel />
        </Suspense>
      </ErrorBoundary>
    </AiPanelFrame>
  )
}

function AiPanelFrame({ children }: { children: ReactNode }) {
  const { docked, setOpen } = useAi()
  const panel = useRef<HTMLElement>(null)

  // Escape closes the panel — but a dialog opened over it (a result table, a
  // column's filter menu) is closed first, and when docked only a key pressed
  // inside the panel counts: the page beside it keeps its own Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const el = panel.current
      if (!el) return
      const above = Array.from(document.querySelectorAll('[role="dialog"]')).some((d) => d !== el && !el.contains(d))
      if (above) return
      if (docked && !el.contains(document.activeElement)) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [docked, setOpen])

  // As a sheet it covers the page, which stops scrolling underneath — counted with any modal opened from it.
  useEffect(() => {
    if (docked) return
    return lockBodyScroll()
  }, [docked])

  // One tree for both shapes, so crossing the breakpoint keeps the conversation, the scroll and the draft.
  return (
    <div className={cn('print:hidden', docked ? 'contents' : 'fixed inset-0 z-50 flex items-end justify-end sm:items-stretch')}>
      {!docked && <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm animate-fade-in" onClick={() => setOpen(false)} />}
      <section
        ref={panel}
        role="dialog"
        aria-modal={docked ? undefined : true}
        aria-label="AI assistant"
        className={cn(
          'flex min-h-0 flex-col overflow-hidden bg-white dark:bg-slate-900',
          docked
            ? 'fixed bottom-0 right-0 top-[calc(4rem+env(safe-area-inset-top))] z-30 w-[30rem] border-l border-slate-200 shadow-lift animate-slide-in-right dark:border-slate-800'
            : 'relative z-10 h-[92dvh] w-full rounded-t-3xl shadow-lift ring-1 ring-slate-200 animate-slide-up dark:ring-slate-800 sm:h-full sm:max-w-xl sm:rounded-none sm:rounded-l-3xl sm:pt-[env(safe-area-inset-top)] sm:animate-slide-in-right',
        )}
      >
        {children}
      </section>
    </div>
  )
}
