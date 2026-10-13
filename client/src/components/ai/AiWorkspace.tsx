// ============================================================================
// §20 — the assistant in its large window (AiPopup draws it at /ai and
// /ai/reports/<id> when the popup is large). The same conversation, draft
// and answer being written as the card in the corner — Expand there opens it
// here, Shrink here goes back to the card, and neither ever interrupts an
// answer. A column of 280 px holds the conversations and My reports; the
// thread (or a report run) is a centred column of at most 1100 px, wide
// enough for tables and charts, with the question box pinned under it.
//
// Its places (./workspace), in the popup's own router: /ai?c=<conversation>
// follows the conversation on screen, and /ai/reports/<id> opens a saved
// report. The same addresses opened in the app (a link, a bookmark) open the
// popup here (AiAddress).
// ============================================================================

import './fonts'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { FileChartColumn, History, MessagesSquare, Minimize2, SquarePen, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAi } from './AiAssistantProvider'
import { AiComposer, useComposerDraft } from './AiComposer'
import { AiConversationList } from './AiConversationList'
import { AiHeaderLinks } from './AiHeaderLinks'
import { BotMark } from './AiMessages'
import { AiReportList } from './AiReportList'
import { AiReportView } from './AiReportView'
import { AiThread } from './AiThread'
import { AI_WORKSPACE_PATH, aiWorkspaceHref, workspaceConversationId, workspaceReportId, type AiWorkspaceList, type AiWorkspaceState } from './workspace'

const HEAD_BTN = 'icon-btn h-10 w-10 touch:h-11 touch:w-11'
const HEAD_ON = 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200'

export function AiWorkspace() {
  const { conversationId, openConversation, setSize, setOpen } = useAi()
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
        {/* The assistant's mark alone, no words: the buttons say the rest (each has its name as a tooltip). */}
        <BotMark size="md" />
        <h2 className="sr-only">AI assistant</h2>
        <span className="min-w-0 flex-1" />
        <button type="button" onClick={newChat} className={HEAD_BTN} aria-label="New chat" data-tip="New chat">
          <SquarePen className="h-5 w-5" />
        </button>
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
        <AiHeaderLinks buttonClass={HEAD_BTN} onClass={HEAD_ON} />
        {/* Back to the card in the corner, the report open here still open there. */}
        <button type="button" onClick={() => setSize('compact')} className={HEAD_BTN} aria-label="Shrink to the corner" data-tip="Shrink to the corner">
          <Minimize2 className="h-[18px] w-[18px]" />
        </button>
        <button type="button" onClick={() => setOpen(false)} className={HEAD_BTN} aria-label="Close the assistant" data-tip="Close (Esc)">
          <X className="h-5 w-5" />
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
          {list === 'conversations' ? <AiConversationList onPicked={toThread} /> : <AiReportList onOpen={(r) => openReport(r.id, r)} activeId={reportId} />}
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
