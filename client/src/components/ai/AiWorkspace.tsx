// ============================================================================
// §20 — the assistant's full page, /ai, for the people given the assistant
// (the route asks /ai/me first). The same conversation, draft and answer
// being written as the panel — Expand there opens it here, Dock here goes
// back to the panel beside the page the person came from, and neither ever
// interrupts an answer. A column of 280 px holds the conversations and My
// reports; the thread (or a report run) is a centred column of at most
// 1100 px, wide enough for tables and charts, with the question box pinned
// under it. On a phone the page is the sheet: the list or the thread.
//
// Its addresses (./workspace): /ai?c=<conversation> follows the conversation
// on screen, and /ai/reports/<id> opens a saved report — either can be
// shared or bookmarked.
// ============================================================================

import './fonts'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { FileChartColumn, History, MessagesSquare, PanelRightClose, ShieldOff, SquarePen } from 'lucide-react'
import { Button } from '@/components/ui'
import { cn } from '@/lib/utils'
import { useAi } from './AiAssistantProvider'
import { AiComposer, useComposerDraft } from './AiComposer'
import { AiConversationList } from './AiConversationList'
import { BotMark } from './AiMessages'
import { REVOKED_TEXT } from './AiPanelHost'
import { AiReportList } from './AiReportList'
import { AiReportView } from './AiReportView'
import { AiConversationTitle, AiThread } from './AiThread'
import { AI_WORKSPACE_PATH, aiWorkspaceHref, isKnownWorkspacePath, workspaceConversationId, workspaceReportId, type AiWorkspaceList, type AiWorkspaceState } from './workspace'

const HEAD_BTN = 'icon-btn h-10 w-10 touch:h-11 touch:w-11'
const HEAD_ON = 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200'
const HEAD_TEXT_BTN = 'btn-secondary h-10 min-h-0 gap-1.5 px-3 py-0 text-13 touch:h-11'

export default function AiWorkspace() {
  const { revoked } = useAi()
  const location = useLocation()
  // An address under /ai the page does not know reads as /ai.
  if (!isKnownWorkspacePath(location.pathname)) return <Navigate to={`${AI_WORKSPACE_PATH}${location.search}`} replace />
  if (revoked) return <WorkspaceRevoked />
  return <Workspace />
}

/** The assistant was taken away while the page was open: it says so, and offers the way out. */
function WorkspaceRevoked() {
  const navigate = useNavigate()
  return (
    <div role="alert" className="ai-type ai-workspace flex flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
        <ShieldOff aria-hidden className="h-6 w-6" />
      </span>
      <p className="font-semibold text-slate-700 dark:text-slate-200">{REVOKED_TEXT}</p>
      <Button className="min-h-[44px]" onClick={() => navigate('/', { replace: true })}>
        Back to the app
      </Button>
    </div>
  )
}

function Workspace() {
  const { conversationId, openConversation, dock } = useAi()
  const location = useLocation()
  const navigate = useNavigate()
  const [, setParams] = useSearchParams()
  const reportId = workspaceReportId(location.pathname)
  const c = workspaceConversationId(location.search)
  const arrived = (location.state ?? {}) as AiWorkspaceState
  const [list, setList] = useState<AiWorkspaceList>(() => arrived.list ?? (reportId ? 'reports' : 'conversations'))
  // A phone shows one column at a time: the lists, or the conversation (or report).
  const [pane, setPane] = useState<'list' | 'main'>(() => (arrived.list ? 'list' : 'main'))
  const { draft, setDraft, focus, focusComposer, focusUsed } = useComposerDraft()

  // The address and the conversation on screen follow each other. An address that changed (a link, a bookmark,
  // Back) opens its conversation; a conversation changed here (picked, a new chat, a first answer naming its
  // conversation) is written into the address, in place, so Back still leaves the page. An address without ?c=
  // keeps the conversation the panel had.
  const seen = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (reportId) return
    if (c !== seen.current) {
      seen.current = c
      if (c !== null && c !== conversationId) {
        openConversation(c)
        return
      }
    }
    if (c !== conversationId) {
      seen.current = conversationId
      setParams(conversationId ? { c: conversationId } : {}, { replace: true })
    }
  }, [reportId, c, conversationId, openConversation, setParams])

  // To the conversation: from a report, the address loses the report (and takes the conversation's ?c= above).
  const toThread = useCallback(() => {
    if (reportId) navigate(AI_WORKSPACE_PATH)
    setPane('main')
  }, [reportId, navigate])

  const newChat = () => {
    openConversation(null)
    toThread()
    focusComposer(false)
  }
  const fill = useCallback(
    (question: string) => {
      setDraft(question)
      toThread()
      focusComposer(false)
    },
    [setDraft, toThread, focusComposer],
  )
  // A follow-up question is there to be finished or sent: the box takes it with the caret, the keyboard too.
  const suggest = useCallback(
    (question: string) => {
      setDraft(question)
      toThread()
      focusComposer(true)
    },
    [setDraft, toThread, focusComposer],
  )
  const openReport = useCallback(
    (id: string, known?: AiWorkspaceState['known']) => {
      navigate(aiWorkspaceHref({ reportId: id }), { state: { known } satisfies AiWorkspaceState })
      setList('reports')
      setPane('main')
    },
    [navigate],
  )
  const openFromReport = useCallback(
    (id: string) => {
      openConversation(id)
      navigate(aiWorkspaceHref({ conversationId: id }))
      setPane('main')
    },
    [openConversation, navigate],
  )
  const backFromReport = () => {
    setList('reports')
    setPane('list')
    navigate(AI_WORKSPACE_PATH)
  }

  const showList = (which: AiWorkspaceList) => {
    setList(which)
    setPane('list')
  }

  return (
    <div className="ai-type ai-workspace flex flex-col bg-white dark:bg-slate-900">
      <header className="flex shrink-0 items-center gap-1.5 border-b border-slate-200 px-3 py-2.5 dark:border-slate-800 sm:px-4">
        <BotMark size="md" className="me-1 hidden sm:grid" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-bold leading-tight sm:text-base">AI assistant</h1>
          <p dir="auto" className="truncate text-xs text-muted">
            {pane === 'list' ? <span className="md:hidden">{list === 'reports' ? 'Your saved reports' : 'Your conversations'}</span> : null}
            <span className={cn(pane === 'list' && 'hidden md:inline')}>{reportId ? 'A saved report' : <AiConversationTitle />}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={() => (pane === 'list' ? setPane('main') : showList(list))}
          className={cn(HEAD_BTN, 'md:hidden', pane === 'list' && HEAD_ON)}
          aria-label="Your conversations and reports"
          aria-pressed={pane === 'list'}
          data-tip="Your conversations and reports"
        >
          <History className="h-5 w-5" />
        </button>
        <button type="button" onClick={newChat} className={cn(HEAD_BTN, 'sm:hidden')} aria-label="New chat" data-tip="New chat">
          <SquarePen className="h-5 w-5" />
        </button>
        <button type="button" onClick={newChat} className={cn(HEAD_TEXT_BTN, 'hidden sm:inline-flex')}>
          <SquarePen className="h-4 w-4" /> New chat
        </button>
        <button type="button" onClick={() => dock(reportId ? { id: reportId, known: arrived.known } : undefined)} className={cn(HEAD_BTN, 'sm:hidden')} aria-label="Dock beside the page" data-tip="Dock beside the page">
          <PanelRightClose className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={() => dock(reportId ? { id: reportId, known: arrived.known } : undefined)}
          className={cn(HEAD_TEXT_BTN, 'hidden sm:inline-flex')}
          data-tip="Back to the page you were on, with the assistant beside it"
        >
          <PanelRightClose className="h-4 w-4" /> Dock
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside
          aria-label="Your conversations and reports"
          className={cn(
            'min-h-0 flex-col border-slate-200 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-950/40 md:flex md:w-[280px] md:shrink-0 md:border-e',
            pane === 'list' ? 'flex w-full' : 'hidden',
          )}
        >
          <div role="group" aria-label="Show" className="mx-3 mt-3 grid shrink-0 grid-cols-2 gap-0.5 rounded-xl bg-slate-200/70 p-0.5 dark:bg-slate-800">
            <ListTab on={list === 'conversations'} onClick={() => setList('conversations')} icon={<MessagesSquare className="h-4 w-4" />}>
              Conversations
            </ListTab>
            <ListTab on={list === 'reports'} onClick={() => setList('reports')} icon={<FileChartColumn className="h-4 w-4" />}>
              My reports
            </ListTab>
          </div>
          {list === 'conversations' ? <AiConversationList onPicked={toThread} onNew={newChat} /> : <AiReportList onOpen={(r) => openReport(r.id, r)} activeId={reportId} />}
        </aside>

        <section aria-label={reportId ? 'Saved report' : 'Conversation'} className={cn('min-h-0 min-w-0 flex-1 flex-col md:flex', pane === 'main' ? 'flex' : 'hidden')}>
          {reportId ? (
            <AiReportView key={reportId} id={reportId} known={arrived.known?.id === reportId ? arrived.known : undefined} onBack={backFromReport} onOpenConversation={openFromReport} wide />
          ) : (
            <>
              <AiThread onAskAgain={fill} onExample={fill} onSuggestion={suggest} onOpenReport={openReport} wide />
              <AiComposer value={draft} onChange={setDraft} focus={focus} onFocusUsed={focusUsed} wide />
            </>
          )}
        </section>
      </div>
    </div>
  )
}

function ListTab({ on, onClick, icon, children }: { on: boolean; onClick: () => void; icon: ReactNode; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-semibold transition-colors touch:h-10',
        on ? 'bg-white text-brand-700 shadow-sm dark:bg-slate-900 dark:text-brand-300' : 'text-muted hover:text-slate-700 dark:hover:text-slate-200',
      )}
    >
      {icon}
      <span className="truncate">{children}</span>
    </button>
  )
}
