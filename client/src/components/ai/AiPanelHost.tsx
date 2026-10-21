// ============================================================================
// §20 — the assistant's popup, over whatever page is open, opened from the
// floating button in the bottom corner (AiButton). Three shapes, one tree, so
// changing shape keeps the conversation, the scroll and the draft:
//
//   • compact — a card in the bottom corner of a desktop, the page beside it
//     still usable (no backdrop); above any bar along the bottom (bottomBar);
//   • large — the whole screen, the full workspace in it (the conversations
//     beside the thread); also what the Automations and Playbook pages open
//     in, as they need the room;
//   • a phone — the whole screen, whatever the size.
//
// The popup has its own router, in memory, apart from the app's address: its
// places are the conversation (/ai, ?c=…), a saved report (/ai/reports/<id>),
// the Automations pages and the Playbook, each a path as the app knows it, so
// the links inside them (to an automation, a delivered report, back to the
// list) move within the popup. A link to any other page (a session, a task,
// the follow-ups) leaves it: the app goes there and the popup steps aside
// (AiAssistantProvider's leaveForPage). It reopens where it was left.
//
// This frame is small and always in the bundle; what fills it is fetched the
// first time it opens. Access taken away while it is open leaves only a word
// saying so.
// ============================================================================

import { createContext, lazy, Suspense, useContext, useEffect, useRef, useState, type ContextType, type ReactNode } from 'react'
import { MemoryRouter, UNSAFE_LocationContext, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom'
import { Loader2, MessagesSquare, ShieldOff, X } from 'lucide-react'
import { Button } from '@/components/ui'
import { ErrorBoundary, LoadFailed } from '@/components/ui/ErrorBoundary'
import { cn, lockBodyScroll } from '@/lib/utils'
import { useAi } from './AiAssistantProvider'
import { AI_WORKSPACE_PATH, isAiWorkspacePath } from './workspace'

const AiPopup = lazy(() => import('./AiPopup'))

/** Said once the owner has taken the assistant away (kept here, not in the popup's file, so it shows without fetching it). */
export const REVOKED_TEXT = 'You no longer have access to the assistant.'

/** The shape the popup is drawn in. */
export type AiPopupShape = 'compact' | 'large' | 'phone'

/** The app's own navigate, for a link inside the popup that leaves it for a page of the app. */
const AppNavigateContext = createContext<NavigateFunction | null>(null)

export function useAppNavigate(): NavigateFunction {
  const navigate = useContext(AppNavigateContext)
  if (!navigate) throw new Error('useAppNavigate must be used inside the assistant popup')
  return navigate
}

/** The shape for where the popup is: a page of its own (Automations, the Playbook) takes the large window. */
export function popupShape(pathname: string, size: 'compact' | 'large', phone: boolean): AiPopupShape {
  if (phone) return 'phone'
  return isAiWorkspacePath(pathname) ? size : 'large'
}

export function AiPanelHost() {
  const { open, revoked, setOpen } = useAi()
  const appNavigate = useNavigate()
  if (!open) return null
  if (revoked) {
    return (
      <PopupRouter>
        <AiPopupFrame>
          <header className="flex shrink-0 items-center gap-2 border-b border-slate-100 px-3 py-2.5 dark:border-slate-800">
            <h2 className="min-w-0 flex-1 truncate text-sm font-bold">AI assistant</h2>
            <button type="button" onClick={() => setOpen(false)} className="icon-btn h-10 w-10 touch:h-11 touch:w-11" aria-label="Close the assistant" data-tip="Close (Esc)">
              <X className="h-5 w-5" />
            </button>
          </header>
          <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
            <span className="grid h-12 w-12 place-items-center rounded-2xl bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              <ShieldOff aria-hidden className="h-6 w-6" />
            </span>
            <p className="font-semibold text-slate-700 dark:text-slate-200">{REVOKED_TEXT}</p>
            <Button className="min-h-[44px]" onClick={() => setOpen(false)}>
              <X className="h-4 w-4" /> Close
            </Button>
          </div>
        </AiPopupFrame>
      </PopupRouter>
    )
  }
  return (
    <AppNavigateContext.Provider value={appNavigate}>
      <PopupRouter>
        <AiPopupFrame>
          <PopupBoundary onClose={() => setOpen(false)}>
            <Suspense
              fallback={
                <p className="flex flex-1 items-center justify-center gap-2 text-sm text-muted">
                  <Loader2 className="h-4 w-4 animate-spin" /> Opening the assistant…
                </p>
              }
            >
              <AiPopup />
            </Suspense>
          </PopupBoundary>
        </AiPopupFrame>
      </PopupRouter>
    </AppNavigateContext.Provider>
  )
}

/**
 * The popup's file not arriving (a deploy since the page opened, a dropped connection), or one of its places failing to
 * draw, leaves the page as it was: a word, what broke, and the ways on — reload, back to the conversation (the popup
 * draws again there), or close.
 */
function PopupBoundary({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  return (
    <ErrorBoundary
      resetKey={pathname}
      fallback={(error) => (
        <LoadFailed
          what="The assistant"
          error={error}
          action={
            <>
              {!isAiWorkspacePath(pathname) && (
                <Button className="min-h-[44px]" onClick={() => navigate(AI_WORKSPACE_PATH)}>
                  <MessagesSquare className="h-4 w-4" /> Conversation
                </Button>
              )}
              <Button className="min-h-[44px]" onClick={onClose}>
                <X className="h-4 w-4" /> Close
              </Button>
            </>
          }
        />
      )}
    >
      {children}
    </ErrorBoundary>
  )
}

/**
 * The popup's own router, in memory, starting where the popup was last left. React Router refuses a router inside
 * another; the popup's is a world of its own, so the app's location is hidden from it here (the app's navigate
 * reaches it through AppNavigateContext, set above this).
 */
function PopupRouter({ children }: { children: ReactNode }) {
  const { popupPath } = useAi()
  const [entries] = useState(() => [popupPath.current])
  return (
    <UNSAFE_LocationContext.Provider value={null as unknown as ContextType<typeof UNSAFE_LocationContext>}>
      <MemoryRouter initialEntries={entries}>
        <PopupPlace />
        {children}
      </MemoryRouter>
    </UNSAFE_LocationContext.Provider>
  )
}

/** Keeps the provider told where the popup is (it reopens there), and lets it move the popup while it is open. */
function PopupPlace() {
  const { popupPath, popupNavigate } = useAi()
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    popupPath.current = `${location.pathname}${location.search}${location.hash}`
  }, [popupPath, location.pathname, location.search, location.hash])
  useEffect(() => {
    popupNavigate.current = (to) => navigate(to)
    return () => {
      popupNavigate.current = null
    }
  }, [popupNavigate, navigate])
  return null
}

function AiPopupFrame({ children }: { children: ReactNode }) {
  const { setOpen, size, phone } = useAi()
  const { pathname } = useLocation()
  const shape = popupShape(pathname, size, phone)
  const panel = useRef<HTMLElement>(null)
  const modal = shape !== 'compact'

  // Escape closes the popup — but a dialog opened over it (a result table, a column's filter menu) is closed first,
  // and the card in the corner, which leaves the page usable, closes only for a key pressed inside it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const el = panel.current
      if (!el) return
      const above = Array.from(document.querySelectorAll('[role="dialog"]')).some((d) => d !== el && !el.contains(d))
      if (above) return
      if (!modal && !el.contains(document.activeElement)) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [modal, setOpen])

  // Over the page (the full screen, a phone's) it stops the page scrolling underneath — counted with any modal opened
  // from it — but never its own page, which goes on scrolling inside it (the card turned into the full window while a
  // settings page was open in it used to lock that page too).
  useEffect(() => {
    if (!modal) return
    return lockBodyScroll(panel.current)
  }, [modal])

  return (
    <div className={cn('print:hidden', modal ? 'fixed inset-0 z-50 flex' : 'contents')}>
      <section
        ref={panel}
        role="dialog"
        aria-modal={modal ? true : undefined}
        aria-label="AI assistant"
        data-shape={shape}
        className={cn(
          'ai-type flex min-h-0 flex-col overflow-hidden bg-white dark:bg-slate-900',
          shape === 'compact' && 'ai-popup-compact fixed z-40 rounded-3xl shadow-lift ring-1 ring-slate-200 animate-slide-up dark:ring-slate-800',
          shape === 'large' && 'relative z-10 h-full w-full animate-page-in safe-top',
          shape === 'phone' && 'relative z-10 h-full w-full animate-slide-up safe-top',
        )}
      >
        {children}
      </section>
    </div>
  )
}
