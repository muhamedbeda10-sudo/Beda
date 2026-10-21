// ============================================================================
// §20 — what fills the assistant's popup (AiPanelHost frames it and gives it
// its own router), fetched the first time it opens. Its places:
//
//   /ai, /ai?c=…, /ai/reports/<id>  the conversation or a saved report: the
//                                   card's panel (AiPanel), or in the large
//                                   window the workspace (AiWorkspace);
//   /automations, /automations/<id>, /automations/deliveries/<id>
//                                   §21's pages, for those who may create
//                                   automations (a delivered report for
//                                   anyone it was sent to, as in the app);
//   /playbook                       what the assistant always follows;
//   /saved-tables                   the tables it keeps to build on;
//   /report-styles                  how reports look when they leave the app;
//   /admin/ai                       its settings, for its owner alone (the gear).
//
// Every other path is a page of the app: the app goes there, the popup steps
// aside (leaveForPage) and stays where it was.
// ============================================================================

import './fonts'
import { lazy, Suspense, useEffect, useRef, type ReactElement } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, Loader2, MessagesSquare, X } from 'lucide-react'
import { ErrorBoundary, LoadFailed } from '@/components/ui/ErrorBoundary'
import { useAi } from './AiAssistantProvider'
import { useAppNavigate } from './AiPanelHost'
import { BotMark } from './AiMessages'
import AiPanel from './AiPanel'
import { AiWorkspace } from './AiWorkspace'
import { AI_WORKSPACE_PATH, workspaceConversationId } from './workspace'
import { APP_SCROLL_ATTR } from '@/lib/appScroll'

const AutomationsPage = lazy(() => import('@/pages/AutomationsPage').then((m) => ({ default: m.AutomationsPage })))
const AutomationPage = lazy(() => import('@/pages/AutomationPage').then((m) => ({ default: m.AutomationPage })))
const AutomationDeliveryPage = lazy(() => import('@/pages/AutomationDeliveryPage').then((m) => ({ default: m.AutomationDeliveryPage })))
const PlaybookPage = lazy(() => import('@/pages/PlaybookPage').then((m) => ({ default: m.PlaybookPage })))
const SavedTablesPage = lazy(() => import('@/pages/SavedTablesPage').then((m) => ({ default: m.SavedTablesPage })))
const ReportStylesPage = lazy(() => import('@/pages/ReportStylesPage').then((m) => ({ default: m.ReportStylesPage })))
const AiSettings = lazy(() => import('@/pages/admin/AiAssistantPage').then((m) => ({ default: m.AiSettings })))

const HEAD_BTN = 'icon-btn h-10 w-10 touch:h-11 touch:w-11'

export default function AiPopup() {
  const { automations, owner, enabled } = useAi()
  // Someone who may not create automations has no Automations pages here, as in the app: the conversation instead.
  const automator = (page: ReactElement) => (automations ? page : <Navigate to={AI_WORKSPACE_PATH} replace />)
  return (
    <Routes>
      <Route path={AI_WORKSPACE_PATH} element={<AiHome />} />
      <Route path={`${AI_WORKSPACE_PATH}/reports/:id`} element={<AiHome />} />
      <Route path={`${AI_WORKSPACE_PATH}/*`} element={<Navigate to={AI_WORKSPACE_PATH} replace />} />
      <Route path="/automations" element={automator(<PopupPage title="Automations" page={<AutomationsPage />} />)} />
      <Route path="/automations/deliveries/:id" element={<PopupPage title="Scheduled report" page={<AutomationDeliveryPage />} />} />
      <Route path="/automations/:id" element={automator(<PopupPage title="Automation" page={<AutomationPage />} />)} />
      <Route path="/playbook" element={enabled ? <PopupPage title="Playbook" page={<PlaybookPage />} /> : <Navigate to="/admin/ai" replace />} />
      <Route path="/saved-tables" element={enabled ? <PopupPage title="Saved tables" page={<SavedTablesPage />} /> : <Navigate to="/admin/ai" replace />} />
      <Route path="/report-styles" element={enabled ? <PopupPage title="Report styles" page={<ReportStylesPage />} /> : <Navigate to="/admin/ai" replace />} />
      {/* The settings are the owner's alone, as on the server; anyone else finds the conversation. */}
      <Route path="/admin/ai" element={owner ? <PopupPage title="AI settings" page={<AiSettings />} /> : <Navigate to={AI_WORKSPACE_PATH} replace />} />
      <Route path="*" element={<LeaveForApp />} />
    </Routes>
  )
}

/** The conversation: the card's panel, or the workspace in the large window (a phone has the panel, its whole screen). */
function AiHome() {
  const { size, phone, enabled, openConversation } = useAi()
  const location = useLocation()
  const navigate = useNavigate()
  const workspace = size === 'large' && !phone
  // A conversation named in the address (/ai?c=<id>: a link, the bell, a phone notification): the workspace reads it
  // itself; the card and a phone's panel open it here, once, and drop it from the address so it is not opened again.
  const named = workspaceConversationId(location.search)
  useEffect(() => {
    if (!enabled || workspace || !named) return
    openConversation(named)
    navigate(AI_WORKSPACE_PATH, { replace: true })
  }, [enabled, workspace, named, openConversation, navigate])
  // The owner without the assistant given to them has no conversation here: its settings instead (where they can give it).
  if (!enabled) return <Navigate to="/admin/ai" replace />
  return workspace ? <AiWorkspace /> : <AiPanel />
}

/**
 * One of the assistant's pages in the popup: a bar with the way back (to where the popup was before, or the
 * conversation), back to the conversation, and Close; under it the page, scrolling in the popup as on its own.
 */
function PopupPage({ title, page }: { title: string; page: ReactElement }) {
  const { setOpen } = useAi()
  const navigate = useNavigate()
  const location = useLocation()
  // The popup's first place (reopened here, or opened on it) has nothing before it: back is the conversation.
  const back = () => (location.key === 'default' ? navigate(AI_WORKSPACE_PATH) : navigate(-1))
  const body = useRef<HTMLDivElement>(null)
  // Each page starts at its top, as a page of the app does.
  useEffect(() => {
    body.current?.scrollTo({ top: 0 })
  }, [location.pathname])
  return (
    <>
      <header className="flex shrink-0 items-center gap-1 border-b border-slate-100 px-3 py-2.5 dark:border-slate-800 sm:gap-1.5">
        <button type="button" onClick={back} className={HEAD_BTN} aria-label="Back" data-tip="Back">
          <ArrowLeft className="h-5 w-5 rtl:rotate-180" />
        </button>
        <BotMark size="md" />
        <h2 className="sr-only">AI assistant: {title}</h2>
        <span className="min-w-0 flex-1" />
        <button type="button" onClick={() => navigate(AI_WORKSPACE_PATH)} className={HEAD_BTN} aria-label="Back to the conversation" data-tip="Back to the conversation">
          <MessagesSquare className="h-5 w-5" />
        </button>
        <button type="button" onClick={() => setOpen(false)} className={HEAD_BTN} aria-label="Close the assistant" data-tip="Close (Esc)">
          <X className="h-5 w-5" />
        </button>
      </header>
      {/* As <main> draws a page: its background and margins, so a page's bars that reach to its edges fit here too;
          and the box the page scrolls in (lib/appScroll), so a frame that fills the window fills this instead and a
          bar that sticks at the top of the page sticks at the top of this. */}
      <div ref={body} {...{ [APP_SCROLL_ATTR]: '' }} className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-slate-100 px-3 py-4 dark:bg-slate-950 sm:px-4">
        <ErrorBoundary resetKey={location.pathname} fallback={(error) => <LoadFailed what={`The ${title} page`} error={error} />}>
          <Suspense
            fallback={
              <p className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </p>
            }
          >
            {page}
          </Suspense>
        </ErrorBoundary>
      </div>
    </>
  )
}

/**
 * A link inside the popup to a page of the app (a session, a task, the follow-ups, the settings): the app opens it,
 * the popup steps aside so it is in view, and goes back to where it was. Once per link followed, StrictMode or not.
 */
function LeaveForApp() {
  const appNavigate = useAppNavigate()
  const { leaveForPage } = useAi()
  const location = useLocation()
  const navigate = useNavigate()
  const done = useRef<string | null>(null)
  useEffect(() => {
    if (done.current === location.key) return
    done.current = location.key
    appNavigate(`${location.pathname}${location.search}${location.hash}`, { state: location.state })
    leaveForPage()
    if (location.key === 'default') navigate(AI_WORKSPACE_PATH, { replace: true })
    else navigate(-1)
  }, [appNavigate, leaveForPage, location, navigate])
  return null
}
