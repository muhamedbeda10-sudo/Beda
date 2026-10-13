// ============================================================================
// §20 — the assistant's panel, loaded the first time it opens (AiPanelHost
// frames it). The header carries the mark, New chat, History, My reports,
// the assistant's own pages (Automations: AiHeaderLinks), Expand (to the
// full page, /ai, with everything as it is) and Close — no
// amounts: what the assistant costs is on its owner's page alone. Below it
// the conversation and the question box, the list of conversations, or the
// saved reports — their list, or one report run.
// ============================================================================

import './fonts'
import { useCallback, useEffect, useState } from 'react'
import { FileChartColumn, History, Maximize2, SquarePen, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAi } from './AiAssistantProvider'
import { AiComposer, useComposerDraft } from './AiComposer'
import { AiConversationList } from './AiConversationList'
import { AiHeaderLinks } from './AiHeaderLinks'
import { BotMark } from './AiMessages'
import { AiReportList } from './AiReportList'
import { AiReportView } from './AiReportView'
import { AiConversationTitle, AiThread } from './AiThread'
import type { AiOpenReport } from './workspace'

type View = 'thread' | 'history' | 'reports'

const HEAD_BTN = 'icon-btn h-10 w-10 touch:h-11 touch:w-11'
const HEAD_ON = 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200'

export default function AiPanel() {
  const ai = useAi()
  const { openConversation, setOpen, expand, handoff } = ai
  // Docked from the full page with a report open there: the panel opens on it. Read once, cleared after.
  const [start] = useState(() => handoff.current)
  useEffect(() => {
    handoff.current = null
  }, [handoff])
  const [view, setView] = useState<View>(start ? 'reports' : 'thread')
  const [report, setReport] = useState<AiOpenReport | null>(start)
  // The unsent question lives here while the panel is open, and in the provider's ref while it is closed.
  // A conversation composed elsewhere ("Edit in chat") brings the panel back to the thread to show it.
  const { draft, setDraft, focus, focusComposer, focusUsed } = useComposerDraft(() => setView('thread'))
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
  const openReport = useCallback((id: string, known?: AiOpenReport['known']) => {
    setReport({ id, known })
    setView('reports')
  }, [])
  // The same thing on the full page: the conversation, the report open here, or the list on screen.
  const toPage = () => expand(view === 'reports' ? (report ? { report } : { list: 'reports' }) : view === 'history' ? { list: 'conversations' } : undefined)
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
      <header className="flex shrink-0 items-center gap-1 border-b border-slate-100 px-3 py-2.5 dark:border-slate-800 sm:gap-1.5">
        <BotMark size="md" className="me-1 hidden sm:grid" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-bold leading-tight">AI assistant</h2>
          {/* A title in Arabic reads right to left (and, too long, is cut at its own end), but sits under the heading. */}
          <p dir="auto" className="truncate text-left text-xs text-muted">
            {view === 'history' ? 'Your conversations' : view === 'reports' ? 'Your saved reports' : <AiConversationTitle />}
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
        <AiHeaderLinks buttonClass={HEAD_BTN} onClass={HEAD_ON} fromPanel />
        {/* On a phone too: the full page has a phone's shape (the list, then the conversation). */}
        <button type="button" onClick={toPage} className={HEAD_BTN} aria-label="Expand to a full page" data-tip="Expand to a full page">
          <Maximize2 className="h-[18px] w-[18px]" />
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
