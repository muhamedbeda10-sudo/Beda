// ============================================================================
// §20 — the assistant in its card in the corner (and on a phone, its whole
// screen): AiPopup draws it at /ai and /ai/reports/<id>. The header carries
// the mark, New chat, History, My reports, the assistant's own pages (the
// Playbook and Automations: AiHeaderLinks, opened in the popup), Expand (the
// large window, with everything as it is) and Close — no amounts: what the
// assistant costs is on its owner's page alone. Below it the conversation
// and the question box, the list of conversations, or the saved reports —
// their list, or one report run (/ai/reports/<id> in the popup's router).
// ============================================================================

import './fonts'
import { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { FileChartColumn, History, Maximize2, SquarePen, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAi } from './AiAssistantProvider'
import { AiComposer, useComposerDraft } from './AiComposer'
import { AiConversationList } from './AiConversationList'
import { AiHeaderLinks } from './AiHeaderLinks'
import { BotMark } from './AiMessages'
import { AiReportList } from './AiReportList'
import { AiReportView } from './AiReportView'
import { AiThread } from './AiThread'
import { AI_WORKSPACE_PATH, aiWorkspaceHref, workspaceReportId, type AiOpenReport, type AiOpenReportOptions, type AiWorkspaceState } from './workspace'

type View = 'thread' | 'history' | 'reports'

const HEAD_BTN = 'icon-btn h-10 w-10 touch:h-11 touch:w-11'
const HEAD_ON = 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200'

export default function AiPanel() {
  const ai = useAi()
  const { openConversation, setOpen, setSize, phone } = ai
  const location = useLocation()
  const navigate = useNavigate()
  // The report open is the popup's place (/ai/reports/<id>), so it stays open across Expand and back.
  const reportId = workspaceReportId(location.pathname)
  const known = (location.state as AiWorkspaceState | null)?.known
  const arrivedShare = (location.state as AiWorkspaceState | null)?.share === true
  const report: AiOpenReport | null = reportId ? { id: reportId, known: known?.id === reportId ? known : undefined, share: arrivedShare } : null
  const [view, setView] = useState<View>(reportId ? 'reports' : 'thread')
  // A link that opens a report here (an answer's, the Playbook's) shows it, from whichever view was on screen.
  useEffect(() => {
    if (reportId) setView('reports')
  }, [reportId])
  const setReport = useCallback(
    (next: AiOpenReport | null) => {
      if (next) navigate(aiWorkspaceHref({ reportId: next.id }), { state: { known: next.known, share: next.share } satisfies AiWorkspaceState })
      else if (reportId) navigate(AI_WORKSPACE_PATH)
    },
    [navigate, reportId],
  )
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
    setReport(null)
    setView('thread')
    focusComposer(false)
  }
  const openReport = useCallback(
    (id: string, summary?: AiOpenReport['known']) => {
      setReport({ id, known: summary })
      setView('reports')
    },
    [setReport],
  )
  // From an answer's card: the report, on its Share panel when the card was a share card.
  const openReportFromAnswer = useCallback(
    (id: string, opts?: AiOpenReportOptions) => {
      setReport({ id, share: opts?.share })
      setView('reports')
    },
    [setReport],
  )
  // The same thing in the large window: the conversation, the report open here, or the list on screen.
  const expand = () => {
    const list = view === 'reports' && !report ? 'reports' : view === 'history' ? 'conversations' : undefined
    if (list) navigate(`${location.pathname}${location.search}`, { replace: true, state: { list } satisfies AiWorkspaceState })
    setSize('large')
  }
  // My reports opens the list; from a report it goes back to the list, and from the list back to the conversation.
  const toReports = () => {
    if (view === 'reports' && !report) {
      setView('thread')
      return
    }
    setReport(null)
    setView('reports')
  }
  const toggleHistory = () => {
    setReport(null)
    setView((v) => (v === 'history' ? 'thread' : 'history'))
  }
  // From a report back to the answer it was saved from (its conversation, at its end).
  const openFrom = useCallback(
    (conversationId: string) => {
      openConversation(conversationId)
      setReport(null)
      setView('thread')
    },
    [openConversation, setReport],
  )

  return (
    <>
      <header className="flex shrink-0 items-center gap-1 border-b border-slate-100 px-3 py-2.5 dark:border-slate-800 sm:gap-1.5">
        {/* The assistant's mark alone, no words: the buttons say the rest (each has its name as a tooltip). */}
        <BotMark size="md" />
        <h2 className="sr-only">AI assistant</h2>
        <span className="min-w-0 flex-1" />
        <button type="button" onClick={newChat} className={HEAD_BTN} aria-label="New chat" data-tip="New chat">
          <SquarePen className="h-5 w-5" />
        </button>
        <button type="button" onClick={toggleHistory} className={cn(HEAD_BTN, view === 'history' && HEAD_ON)} aria-label="Your conversations" aria-pressed={view === 'history'} data-tip="Your conversations">
          <History className="h-5 w-5" />
        </button>
        <button type="button" onClick={toReports} className={cn(HEAD_BTN, view === 'reports' && HEAD_ON)} aria-label="My reports" aria-pressed={view === 'reports'} data-tip="My reports">
          <FileChartColumn className="h-5 w-5" />
        </button>
        <AiHeaderLinks buttonClass={HEAD_BTN} onClass={HEAD_ON} />
        {/* A phone's popup is its whole screen already. */}
        {!phone && (
          <button type="button" onClick={expand} className={HEAD_BTN} aria-label="Full screen" data-tip="Full screen">
            <Maximize2 className="h-[18px] w-[18px]" />
          </button>
        )}
        <button type="button" onClick={() => setOpen(false)} className={HEAD_BTN} aria-label="Close the assistant" data-tip="Close (Esc)">
          <X className="h-5 w-5" />
        </button>
      </header>

      {view === 'history' ? (
        <AiConversationList onPicked={() => setView('thread')} onNew={newChat} />
      ) : view === 'reports' ? (
        report ? (
          <AiReportView key={`${report.id}:${report.share ? 'share' : ''}`} id={report.id} known={report.known} sharing={report.share} onBack={() => setReport(null)} onOpenConversation={openFrom} />
        ) : (
          <AiReportList onOpen={(r) => openReport(r.id, r)} />
        )
      ) : (
        <>
          <AiThread onAskAgain={fill} onExample={fill} onSuggestion={suggest} onOpenReport={openReportFromAnswer} />
          <AiComposer value={draft} onChange={setDraft} focus={focus} onFocusUsed={focusUsed} />
        </>
      )}
    </>
  )
}
