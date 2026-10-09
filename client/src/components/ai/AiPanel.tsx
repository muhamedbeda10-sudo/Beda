// ============================================================================
// §20 — the assistant's panel, loaded the first time it opens (AiPanelHost
// frames it). The header carries the mark, the month's spend against the
// cap, New chat, History and Close; below it the conversation and the
// question box, or the list of conversations.
// ============================================================================

import { useCallback, useState } from 'react'
import { History, SquarePen, X } from 'lucide-react'
import { Badge } from '@/components/ui'
import { cn } from '@/lib/utils'
import { useAiMessages, useAiStatus } from '@/services/queries'
import { useAi, useAiLive } from './AiAssistantProvider'
import { AiComposer } from './AiComposer'
import { AiConversationList } from './AiConversationList'
import { BotMark } from './AiMessages'
import { AiThread } from './AiThread'
import { formatCap, formatMonth, formatUsd, spendTone, utcMonth } from './format'

const HEAD_BTN = 'icon-btn h-10 w-10 touch:h-11 touch:w-11'
const HEAD_ON = 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200'

export default function AiPanel() {
  const ai = useAi()
  const [view, setView] = useState<'thread' | 'history'>('thread')
  // The unsent question lives here while the panel is open, and in the provider's ref while it is closed.
  const [draft, setDraftState] = useState(() => ai.draft.current)
  const [focusKey, setFocusKey] = useState(0)
  const { data: status } = useAiStatus(ai.enabled)

  const { draft: kept, openConversation, setOpen } = ai
  const setDraft = useCallback(
    (value: string) => {
      kept.current = value
      setDraftState(value)
    },
    [kept],
  )
  const fill = useCallback(
    (question: string) => {
      setDraft(question)
      setView('thread')
      setFocusKey((k) => k + 1)
    },
    [setDraft],
  )
  const newChat = () => {
    openConversation(null)
    setView('thread')
    setFocusKey((k) => k + 1)
  }

  return (
    <>
      <header className="flex shrink-0 items-center gap-1.5 border-b border-slate-100 px-3 py-2.5 dark:border-slate-800">
        <BotMark size="md" className="me-1 hidden sm:grid" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold leading-tight">AI assistant</h2>
          <p dir="auto" className="truncate text-xs text-muted">
            {view === 'history' ? 'Your conversations' : <ConversationTitle />}
          </p>
        </div>
        {status && (
          <Badge
            tone={spendTone(status.spentUsd, status.capUsd)}
            className="tabular-nums"
            tip={`Spent in ${formatMonth(utcMonth(0, new Date(status.monthStart)))} (UTC), of the monthly cap. It resets on the 1st.`}
          >
            {formatUsd(status.spentUsd)} / {formatCap(status.capUsd)}
          </Badge>
        )}
        <button type="button" onClick={newChat} className={HEAD_BTN} aria-label="New chat" data-tip="New chat">
          <SquarePen className="h-5 w-5" />
        </button>
        <button type="button" onClick={() => setView((v) => (v === 'history' ? 'thread' : 'history'))} className={cn(HEAD_BTN, view === 'history' && HEAD_ON)} aria-label="Your conversations" aria-pressed={view === 'history'} data-tip="Your conversations">
          <History className="h-5 w-5" />
        </button>
        <button type="button" onClick={() => setOpen(false)} className={HEAD_BTN} aria-label="Close the assistant" data-tip="Close (Esc)">
          <X className="h-5 w-5" />
        </button>
      </header>

      {view === 'history' ? (
        <AiConversationList onPicked={() => setView('thread')} onNew={newChat} />
      ) : (
        <>
          <AiThread onAskAgain={fill} onExample={fill} />
          <AiComposer value={draft} onChange={setDraft} status={status} focusKey={focusKey} />
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
