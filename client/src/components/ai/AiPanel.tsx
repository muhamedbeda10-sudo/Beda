// ============================================================================
// §20 — the assistant's panel, loaded the first time it opens (AiPanelHost
// frames it). The header carries the mark, New chat, History, My reports and
// Close — no amounts: what the assistant costs is on its owner's page alone.
// Below it the conversation and the question box, the list of
// conversations, or the saved reports — their list, or one report run.
// ============================================================================

import { useCallback, useState } from 'react'
import { FileChartColumn, History, SquarePen, X } from 'lucide-react'
import type { AiReportSummary } from '@qc/shared/ai'
import { cn } from '@/lib/utils'
import { useAiMessages } from '@/services/queries'
import { useAi, useAiLive } from './AiAssistantProvider'
import { AiComposer } from './AiComposer'
import { AiConversationList } from './AiConversationList'
import { BotMark } from './AiMessages'
import { AiReportList } from './AiReportList'
import { AiReportView } from './AiReportView'
import { AiThread } from './AiThread'
import { spentFocus, type ComposerFocus } from './suggestions'

type View = 'thread' | 'history' | 'reports'

/** The report open under My reports: its id, and what the list knew of it, drawn until the report itself arrives. */
interface OpenReport {
  id: string
  known?: AiReportSummary
}

const HEAD_BTN = 'icon-btn h-10 w-10 touch:h-11 touch:w-11'
const HEAD_ON = 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200'

export default function AiPanel() {
  const ai = useAi()
  const [view, setView] = useState<View>('thread')
  const [report, setReport] = useState<OpenReport | null>(null)
  // The unsent question lives here while the panel is open, and in the provider's ref while it is closed.
  const [draft, setDraftState] = useState(() => ai.draft.current)
  const [focus, setFocus] = useState<ComposerFocus>({ key: 0, always: false })

  const { draft: kept, openConversation, setOpen } = ai
  const setDraft = useCallback(
    (value: string) => {
      kept.current = value
      setDraftState(value)
    },
    [kept],
  )
  const focusComposer = useCallback((always: boolean) => setFocus((f) => ({ key: f.key + 1, always })), [])
  const focusUsed = useCallback(() => setFocus(spentFocus), [])
  const fill = useCallback(
    (question: string) => {
      setDraft(question)
      setView('thread')
      focusComposer(false)
    },
    [setDraft, focusComposer],
  )
  // A follow-up question is there to be finished or sent: the box takes it with the caret, the keyboard too.
  const suggest = useCallback(
    (question: string) => {
      setDraft(question)
      setView('thread')
      focusComposer(true)
    },
    [setDraft, focusComposer],
  )
  const newChat = () => {
    openConversation(null)
    setView('thread')
    focusComposer(false)
  }
  const openReport = useCallback((id: string, known?: AiReportSummary) => {
    setReport({ id, known })
    setView('reports')
  }, [])
  // My reports opens the list; from a report it goes back to the list, and from the list back to the conversation.
  const toReports = () => {
    if (view === 'reports' && !report) {
      setView('thread')
      return
    }
    setReport(null)
    setView('reports')
  }
  // From a report back to the answer it was saved from (its conversation, at its end).
  const openFrom = useCallback(
    (conversationId: string) => {
      openConversation(conversationId)
      setView('thread')
    },
    [openConversation],
  )

  return (
    <>
      <header className="flex shrink-0 items-center gap-1.5 border-b border-slate-100 px-3 py-2.5 dark:border-slate-800">
        <BotMark size="md" className="me-1 hidden sm:grid" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-bold leading-tight">AI assistant</h2>
          <p dir="auto" className="truncate text-xs text-muted">
            {view === 'history' ? 'Your conversations' : view === 'reports' ? 'Your saved reports' : <ConversationTitle />}
          </p>
        </div>
        <button type="button" onClick={newChat} className={HEAD_BTN} aria-label="New chat" data-tip="New chat">
          <SquarePen className="h-5 w-5" />
        </button>
        <button type="button" onClick={() => setView((v) => (v === 'history' ? 'thread' : 'history'))} className={cn(HEAD_BTN, view === 'history' && HEAD_ON)} aria-label="Your conversations" aria-pressed={view === 'history'} data-tip="Your conversations">
          <History className="h-5 w-5" />
        </button>
        <button type="button" onClick={toReports} className={cn(HEAD_BTN, view === 'reports' && HEAD_ON)} aria-label="My reports" aria-pressed={view === 'reports'} data-tip="My reports">
          <FileChartColumn className="h-5 w-5" />
        </button>
        <button type="button" onClick={() => setOpen(false)} className={HEAD_BTN} aria-label="Close the assistant" data-tip="Close (Esc)">
          <X className="h-5 w-5" />
        </button>
      </header>

      {view === 'history' ? (
        <AiConversationList onPicked={() => setView('thread')} onNew={newChat} />
      ) : view === 'reports' ? (
        report ? (
          <AiReportView key={report.id} id={report.id} known={report.known} onBack={() => setReport(null)} onOpenConversation={openFrom} />
        ) : (
          <AiReportList onOpen={(r) => openReport(r.id, r)} />
        )
      ) : (
        <>
          <AiThread onAskAgain={fill} onExample={fill} onSuggestion={suggest} onOpenReport={openReport} />
          <AiComposer value={draft} onChange={setDraft} focus={focus} onFocusUsed={focusUsed} />
        </>
      )}
    </>
  )
}

/** The open conversation's title (its first question, as the server shortened it). Its own component: it follows the answer being written, the header does not. */
function ConversationTitle() {
  const { conversationId, enabled } = useAi()
  const live = useAiLive()
  const { data } = useAiMessages(conversationId, enabled)
  if (conversationId === null) return <>New conversation</>
  return <>{data?.conversation.title ?? (live?.conversationId === conversationId ? live.conversation?.title : undefined) ?? 'Conversation'}</>
}
